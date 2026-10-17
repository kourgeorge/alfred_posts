// Google Drive + Forms access with plain fetch. Mirrors drive.py.
// Forms needs the service account; Drive can also use GOOGLE_API_KEY for a public folder.
import { encoder, fromBase64, toBase64 } from './util.js';

const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/forms.body.readonly';
export const MAX_VIDEO_SIZE_BYTES = 50 * 1024 * 1024;
const MAX_QUESTION_FORM_ATTEMPTS = 10;

export class WorkflowError extends Error {}

const base64url = bytes => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class Google {
  constructor(config, random = Math.random) {
    this.config = config;
    this.random = random;
    this.token = null;
  }

  account() {
    if (!this.config.google_service_account_json) return null;
    try { return JSON.parse(this.config.google_service_account_json); }
    catch { throw new WorkflowError('The Google service account JSON is invalid.'); }
  }

  async accessToken() {
    if (this.token && this.token.expires > Date.now() + 60000) return this.token.value;
    const account = this.account();
    if (!account) throw new WorkflowError('Question posts need GOOGLE_SERVICE_ACCOUNT_JSON — the Forms API doesn\'t support GOOGLE_API_KEY auth.');
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const claims = base64url(encoder.encode(JSON.stringify({ iss: account.client_email, scope: SCOPES,
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })));
    const pem = account.private_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
    const key = await crypto.subtle.importKey('pkcs8', fromBase64(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const signature = base64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(`${header}.${claims}`))));
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }) });
    if (!response.ok) throw new WorkflowError('Google sign-in failed. Check the service account in Settings.');
    const result = await response.json();
    this.token = { value: result.access_token, expires: Date.now() + (result.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  /** Drive requests use the API key when one is set, like build_drive_service. */
  async driveRequest(url, { forms = false } = {}) {
    const target = new URL(url);
    const headers = {};
    if (!forms && this.config.google_api_key) target.searchParams.set('key', this.config.google_api_key);
    else headers.Authorization = `Bearer ${await this.accessToken()}`;
    const response = await fetch(target, { headers, signal: AbortSignal.timeout(300000) });
    if (!response.ok) throw new WorkflowError(`Google request failed (${response.status}).`);
    return response;
  }

  async listFiles(folderId, mimeClause, extraFields = '') {
    const fields = `nextPageToken, files(id, name, mimeType${extraFields})`;
    const q = `'${folderId}' in parents and ${mimeClause} and trashed = false`;
    const files = [];
    let pageToken = null;
    do {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.set('q', q);
      url.searchParams.set('fields', fields);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const page = await (await this.driveRequest(url)).json();
      files.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    if (!files.length) throw new WorkflowError(`No files found in Drive folder ${folderId}. `
      + 'Check the folder ID and, if using a service account, that the folder is shared with it.');
    return files;
  }

  async download(fileId) {
    const response = await this.driveRequest(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async form(formId) {
    return (await this.driveRequest(`https://forms.googleapis.com/v1/forms/${encodeURIComponent(formId)}`, { forms: true })).json();
  }

  choice(items) { return items[Math.floor(this.random() * items.length)]; }

  async pickImage(postedIds) {
    const files = await this.listFiles(this.config.drive_folder_id_image, "mimeType contains 'image/'");
    return this.choice(unposted(files, postedIds));
  }

  async pickVideo(postedIds) {
    const files = await this.listFiles(this.config.drive_folder_id_video, "mimeType contains 'video/'", ', size');
    const small = files.filter(f => Number(f.size ?? 0) < MAX_VIDEO_SIZE_BYTES);
    if (!small.length) throw new WorkflowError(`No videos under ${MAX_VIDEO_SIZE_BYTES / 1024 / 1024}MB found in Drive folder ${this.config.drive_folder_id_video}.`);
    return this.choice(unposted(small, postedIds));
  }

  async pickQuestion(postedIds) {
    const forms = await this.listFiles(this.config.drive_folder_id_questions, "mimeType = 'application/vnd.google-apps.form'");
    const tried = new Set();
    let fallback = null;
    const attempts = Math.min(MAX_QUESTION_FORM_ATTEMPTS, forms.length);
    for (let i = 0; i < attempts; i++) {
      const file = this.choice(forms.filter(f => !tried.has(f.id)));
      tried.add(file.id);
      const form = await this.form(file.id);
      const title = form.info?.title ?? 'Untitled Form';
      const questions = questionsWithImages(form);
      if (!questions.length) continue;
      for (const question of questions) question.form_id = file.id;
      const fresh = questions.filter(q => !postedIds.has(questionKey(q)));
      if (fresh.length) return { form_title: title, ...this.choice(fresh) };
      fallback ??= { form_title: title, ...this.choice(questions) };
    }
    if (fallback) return fallback;
    throw new WorkflowError(`No question with an image found after checking ${tried.size} form(s) in Drive folder ${this.config.drive_folder_id_questions}.`);
  }
}

/** Prefer files not yet posted; once everything in the pool has been used, allow repeats again. */
function unposted(files, postedIds) {
  const fresh = files.filter(f => !postedIds.has(f.id));
  return fresh.length ? fresh : files;
}

/** Keep only choice-question items that have both a title and a non-empty image. */
export function questionsWithImages(form) {
  const questions = [];
  for (const item of form.items ?? []) {
    const questionItem = item.questionItem || {};
    const question = questionItem.question;
    const imageUri = (questionItem.image || {}).contentUri;
    if (!question || !item.title || typeof imageUri !== 'string' || !imageUri.trim()) continue;
    const options = (question.choiceQuestion || {}).options ?? [];
    questions.push({ question_id: question.questionId ?? null, question: { text: item.title, image: imageUri },
      answers: options.map(option => option.value ?? null) });
  }
  return questions;
}

export const questionKey = question => `${question.form_id}:${question.question_id}`;
