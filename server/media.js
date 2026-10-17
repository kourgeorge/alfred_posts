// Prepare content, then publish the same source. Mirrors studio/media.py.
import * as content from './content.js';
import * as facebook from './facebook.js';
import { Google, questionKey, questionsWithImages } from './drive.js';
import { NewsService, publicUrl } from './news.js';
import { readUpload, validateDescription, validateMedia } from './uploads.js';
import { UserError, encoder, readLimited, sha256Hex } from './util.js';

export const digest = data => sha256Hex(data);

export async function googleImage(url) {
  let host = null;
  try { const parsed = new URL(url); host = parsed.protocol === 'https:' ? parsed.hostname : null; } catch { /* invalid */ }
  if (!host || !['.googleusercontent.com', '.ggpht.com', '.google.com'].some(suffix => host.endsWith(suffix)))
    throw new UserError('The question image must come from Google Forms.');
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Google image request failed (${response.status}).`);
  return readLimited(response, 20 * 1024 * 1024, 'The question image is too large.');
}

export class MediaService {
  /**
   * config: provider settings (see server/config.js). store: upload storage.
   * images: CloudflareImages. step: durable unit of work for long news runs.
   */
  constructor(config, { store, images, step, google } = {}) {
    this.config = config;
    this.store = store;
    this.images = images;
    this.step = step;
    this.google = google ?? new Google(config);
  }

  async checkUpload(postType, uploadId) {
    const [item, data] = await readUpload(this.store, uploadId);
    if (item.type !== postType) throw new UserError('The uploaded file does not match the selected post format.');
    await validateMedia(item, data, this.images);
    const preview = postType === 'image' ? await this.images.thumbnail(data) : null;
    if (postType === 'image' && !preview) throw new UserError('This image could not be previewed. Choose a different image.');
    return [{ key: `upload:${uploadId}`, upload_id: uploadId, name: item.name, sha256: item.sha256,
      size: item.size, mime: item.mime, parts: item.parts }, preview];
  }

  async prepareUpload(postType, uploadId, description, prompt) {
    description = validateDescription(description);
    const [source, preview] = await this.checkUpload(postType, uploadId);
    const text = await content.uploadText(this.config, postType, description, prompt);
    return { source: { ...source, description }, text, preview };
  }

  /** An upload whose caption was already written and approved (the Telegram bot). */
  async prepareUploadText(postType, uploadId, text, description) {
    const [source, preview] = await this.checkUpload(postType, uploadId);
    source.origin = 'telegram';
    if (description) source.description = validateDescription(description);
    return { source, text, preview };
  }

  async prepare(postType, posted, prompt, selectionPrompt) {
    const config = this.config;
    if (postType === 'news')
      return new NewsService(config, { images: this.images, step: this.step }).prepare(posted, prompt, selectionPrompt);
    let source, text, data;
    if (postType === 'question') {
      const item = await this.google.pickQuestion(new Set(posted));
      data = await googleImage(item.question.image);
      source = { key: questionKey(item), form_id: item.form_id, question_id: item.question_id, name: item.form_title,
        question: item.question.text, answers: item.answers, url: `https://docs.google.com/forms/d/${item.form_id}/edit` };
      text = await content.questionText(config, item, prompt);
    } else {
      const item = await (postType === 'video' ? this.google.pickVideo(new Set(posted)) : this.google.pickImage(new Set(posted)));
      data = await this.google.download(item.id);
      source = { key: item.id, id: item.id, name: item.name, url: `https://drive.google.com/file/d/${item.id}/view` };
      text = postType === 'video' ? await content.videoText(config, item.name, prompt)
        : await content.imageText(config, item.id, item.name, prompt);
    }
    source.sha256 = await digest(data);
    return { source, text, preview: postType === 'video' ? null : await this.images.thumbnail(data) };
  }

  async download(draft) {
    const source = draft.source;
    let data;
    if (draft.type === 'news') {
      if (!publicUrl(source.url)) throw new UserError('The news source URL is invalid. Generate a new draft.');
      data = encoder.encode(source.url);
    } else if (source.upload_id) {
      const [item, bytes] = await readUpload(this.store, source.upload_id);
      if (item.type !== draft.type) throw new UserError('The uploaded file does not match this draft.');
      data = bytes;
    } else if (draft.type === 'question') {
      const form = await this.google.form(source.form_id);
      const item = questionsWithImages(form).find(x => x.question_id === source.question_id);
      if (!item || item.question.text !== source.question || JSON.stringify(item.answers) !== JSON.stringify(source.answers))
        throw new UserError('This question changed in Google Forms. Please generate a new draft.');
      data = await googleImage(item.question.image);
    } else {
      data = await this.google.download(source.id);
    }
    if (await digest(data) !== source.sha256) throw new UserError('The source media changed after preview. Please generate a new draft.');
    return data;
  }

  publish(draft, data) {
    if (draft.type === 'news') return facebook.postLink(this.config, draft.source.url, draft.text);
    if (draft.type === 'video') return facebook.postVideo(this.config, data, draft.text);
    return facebook.postPhoto(this.config, data, draft.text);
  }

  videoStatus(videoId) { return facebook.videoStatus(this.config, videoId); }
}
