// The Telegram bot. The owner sends a photo or video, chats with the AI about
// the caption, and approves the post with a button. The AI runs here in the
// gateway so replies take seconds; an approved post is saved, scheduled or
// published by the usual studio command. Setup: STUDIO.md → "Telegram bot".
//
// Nothing changes in the studio without an Approve tap. The bot answers only
// the Telegram accounts in TELEGRAM_ALLOWED_USER_IDS, in private chats.
import { UPLOAD_CHUNK, base64, body, encoder, uploadManifest, validateCommand } from './core.js';
import { ACCURACY, DEFAULT_PROMPTS } from '../server/content.js';
import { wallClock, zonedTime } from '../server/scheduler.js';
import { readLimited } from '../server/util.js';

const ZONE = 'Asia/Jerusalem';
const MAX_DOWNLOAD = 20 * 1024 * 1024; // Telegram's download limit for bots.
const LIMITS = { image: 10 * 1024 * 1024, video: 50 * 1024 * 1024 };
const VISION_LIMIT = 5 * 1024 * 1024;
const HISTORY = 20;
const PROPOSAL_MS = 24 * 60 * 60 * 1000;
const FORMATS = { 'image/jpeg': ['image', ['jpg', 'jpeg']], 'image/png': ['image', ['png']], 'image/webp': ['image', ['webp']],
  'video/mp4': ['video', ['mp4']], 'video/quicktime': ['video', ['mov']] };
const SKIP = Symbol('skip');

const TEXT = {
  en: {
    private: id => `This bot is private. Your Telegram user ID is ${id}. Ask the studio owner to add it.`,
    welcome: 'Hi! Send me a photo or video, with a few words about it if you like, and I will write a Facebook post. '
      + 'Tell me when to post it, ask for changes, or ask what is scheduled. Nothing is posted until you tap Approve.',
    reset: 'Started a new conversation.',
    tooLarge: 'This file is too large. Telegram lets bots download files up to 20 MB, and the studio accepts photos up to 10 MB. '
      + 'Upload larger videos in Alfred Studio.',
    unsupported: 'Send a JPG, PNG or WebP photo, or an MP4 or MOV video.',
    album: 'I use one photo or video per post, so I kept the first one.',
    failed: 'Sorry, something went wrong. Please try again.',
    ai: 'I could not reach the AI right now. Please try again in a minute.',
    approve: 'Approve', cancel: 'Cancel',
    now: 'Publish now', draft: 'Save as a draft in Alfred Studio', at: time => `Schedule for ${time}`,
    unschedule: time => `Unschedule the post set for ${time}? It goes back to your drafts.`,
    stale: 'This suggestion is no longer available.',
    working: 'Approved. I will let you know when it is done.',
    cancelled: 'Cancelled. Nothing was changed.',
    trimmed: '(Shortened here. The full caption will be saved.)',
  },
  he: {
    private: id => `הבוט הזה פרטי. מזהה המשתמש שלך בטלגרם הוא ${id}. בקשו מבעל הסטודיו להוסיף אותו.`,
    welcome: 'שלום! שלחו לי תמונה או סרטון, אפשר עם כמה מילים עליו, ואכתוב פוסט לפייסבוק. '
      + 'אפשר לומר לי מתי לפרסם, לבקש שינויים או לשאול מה מתוזמן. שום דבר לא מתפרסם עד שתלחצו על "אישור".',
    reset: 'התחלנו שיחה חדשה.',
    tooLarge: 'הקובץ גדול מדי. טלגרם מאפשר לבוטים להוריד קבצים עד 20MB, והסטודיו מקבל תמונות עד 10MB. '
      + 'סרטונים גדולים יותר אפשר להעלות דרך Alfred Studio.',
    unsupported: 'שלחו תמונה מסוג JPG, PNG או WebP, או סרטון MP4 או MOV.',
    album: 'אני משתמש בתמונה או בסרטון אחד לכל פוסט, לכן שמרתי את הראשון.',
    failed: 'מצטער, משהו השתבש. נסו שוב.',
    ai: 'לא הצלחתי להגיע ל-AI כרגע. נסו שוב בעוד דקה.',
    approve: 'אישור', cancel: 'ביטול',
    now: 'פרסום עכשיו', draft: 'שמירה כטיוטה ב-Alfred Studio', at: time => `תזמון ל-${time}`,
    unschedule: time => `לבטל את התזמון של הפוסט שמתוזמן ל-${time}? הוא יחזור לטיוטות.`,
    stale: 'ההצעה הזו כבר לא זמינה.',
    working: 'אושר. אעדכן כשזה יסתיים.',
    cancelled: 'בוטל. שום דבר לא השתנה.',
    trimmed: '(קוצר כאן. הכיתוב המלא יישמר.)',
  },
};

/** A problem the owner can fix; its message is sent to the chat. */
class Notice extends Error {
  constructor(key) { super(key); this.key = key; }
}

const TOOLS = [
  { type: 'function', function: { name: 'propose_post',
    description: 'Show the owner a caption for the current photo or video, with Approve and Cancel buttons. '
      + 'Call it again with the full new caption to make changes.',
    parameters: { type: 'object', additionalProperties: false, required: ['caption', 'when'], properties: {
      caption: { type: 'string', description: 'The complete Facebook caption.' },
      when: { type: 'string', description: '"draft" to save it in Alfred Studio, "now" to publish immediately, '
        + 'or an Israel local time as YYYY-MM-DDTHH:MM to schedule it.' } } } } },
  { type: 'function', function: { name: 'list_scheduled', description: 'List the posts that are scheduled to be published.',
    parameters: { type: 'object', additionalProperties: false, properties: {} } } },
  { type: 'function', function: { name: 'propose_cancel',
    description: 'Ask the owner to confirm unscheduling a scheduled post. Use an id from list_scheduled.',
    parameters: { type: 'object', additionalProperties: false, required: ['draft_id'], properties: {
      draft_id: { type: 'string' } } } } },
];

function sameSecret(value, expected) {
  const a = encoder.encode(String(value ?? '')), b = encoder.encode(expected);
  let difference = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) difference |= (a[i] ?? 0) ^ b[i];
  return difference === 0;
}

const hex = buffer => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
const allowedUsers = env => String(env.TELEGRAM_ALLOWED_USER_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
const formatTime = (date, lang) => new Intl.DateTimeFormat(lang === 'he' ? 'he-IL' : 'en-GB', { timeZone: ZONE,
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);

// The bot token is part of every Telegram URL: errors never include the URL or response.
async function telegram(env, method, params) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(20000) });
  } catch { throw new Error(`Telegram ${method} failed.`); }
  const value = await response.json().catch(() => null);
  if (!response.ok || !value?.ok) throw new Error(`Telegram ${method} failed (${response.status}).`);
  return value.result;
}
const send = (env, chatId, text, extra = {}) => telegram(env, 'sendMessage', { chat_id: chatId, text, ...extra });
const typing = (env, chatId, action = 'typing') => telegram(env, 'sendChatAction', { chat_id: chatId, action }).catch(() => {});

async function download(env, fileId, limit) {
  const file = await telegram(env, 'getFile', { file_id: fileId });
  if (!file?.file_path || (file.file_size ?? 0) > limit) throw new Notice('tooLarge');
  let response;
  try {
    response = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`,
      { signal: AbortSignal.timeout(120000) });
  } catch { throw new Error('Telegram download failed.'); }
  if (!response.ok) throw new Error(`Telegram download failed (${response.status}).`);
  try { return await readLimited(response, limit, 'tooLarge'); }
  catch (error) { throw error?.message === 'tooLarge' ? new Notice('tooLarge') : error; }
}

/** The photo or video in a message, its studio file name, and a small still image for the AI. */
function mediaOf(message) {
  if (message.photo?.length) {
    const sizes = [...message.photo].sort((a, b) => a.width * a.height - b.width * b.height);
    const vision = sizes.filter(s => Math.max(s.width, s.height) <= 1280).at(-1) ?? sizes[0];
    return { type: 'image', mime: 'image/jpeg', name: 'telegram-photo.jpg', file: sizes.at(-1),
      vision: { file_id: vision.file_id, mime: 'image/jpeg' } };
  }
  const item = message.video ?? message.document;
  if (!item) return null;
  const format = FORMATS[item.mime_type];
  if (!format) return { unsupported: true };
  const [type, extensions] = format;
  let name = String(item.file_name ?? '').replace(/[\x00-\x1f/\\]/g, '_').slice(-180);
  if (!extensions.includes(name.split('.').at(-1).toLowerCase())) name = `telegram-${type === 'image' ? 'photo' : 'video'}.${extensions[0]}`;
  const thumb = item.thumbnail ?? item.thumb;
  const vision = thumb ? { file_id: thumb.file_id, mime: 'image/jpeg' }
    : type === 'image' && (item.file_size ?? Infinity) <= VISION_LIMIT ? { file_id: item.file_id, mime: item.mime_type } : null;
  return { type, mime: item.mime_type, name, file: item, vision };
}

/** Store the file exactly like a dashboard upload, so the studio checks and publishes it the same way. */
async function saveUpload(env, backend, media) {
  const limit = Math.min(MAX_DOWNLOAD, LIMITS[media.type]);
  if ((media.file.file_size ?? 0) > limit) throw new Notice('tooLarge');
  const bytes = await download(env, media.file.file_id, limit);
  const id = crypto.randomUUID();
  const parts = Math.ceil(bytes.length / UPLOAD_CHUNK);
  const manifest = uploadManifest({ name: media.name, type: media.type, mime: media.mime, size: bytes.length, parts,
    sha256: hex(await crypto.subtle.digest('SHA-256', bytes)) }, id);
  for (let i = 0; i < parts; i++)
    await backend.writeUpload(env, `uploads/${id}/part-${String(i).padStart(2, '0')}.bin`, bytes.subarray(i * UPLOAD_CHUNK, (i + 1) * UPLOAD_CHUNK));
  await backend.writeUpload(env, `uploads/${id}/manifest.json`, encoder.encode(JSON.stringify(manifest)));
  return id;
}

// One small conversation file per chat, next to state.json. Writes use compare-and-swap.
const chatPath = chatId => `telegram/chat-${chatId}.json`;
const emptyChat = () => ({ version: 1, updates: [], messages: [], upload: null, pending: null });

async function readChat(ctx) {
  const file = await ctx.backend.readFile(ctx.env, chatPath(ctx.chatId));
  return file ? JSON.parse(file.text) : emptyChat();
}

async function changeChat(ctx, mutate) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const file = await ctx.backend.readFile(ctx.env, chatPath(ctx.chatId));
    const chat = file ? JSON.parse(file.text) : emptyChat();
    const result = mutate(chat);
    if (result === SKIP) return SKIP;
    if (await ctx.backend.writeFile(ctx.env, chatPath(ctx.chatId), JSON.stringify(chat), file?.sha)) return result;
  }
  throw new Error('The Telegram conversation is busy.');
}

async function readState(ctx) {
  const value = await ctx.backend.readState(ctx.env);
  const state = typeof value === 'string' ? JSON.parse(value) : value;
  return { ...state, drafts: state?.drafts ?? [] };
}

function localTime(value) {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  return zonedTime({ year, month, day, hour, minute, second: 0 }, ZONE);
}

function systemPrompt(chat, state, now) {
  const w = wallClock(now, ZONE);
  const pad = n => String(n).padStart(2, '0');
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'long' }).format(now);
  const upload = chat.upload;
  const pending = chat.pending;
  const type = upload?.type ?? 'image';
  return [
    'You are the assistant of Alfred Studio, which publishes posts to the Facebook page of a driving school. '
      + 'You chat with the page owner on Telegram.',
    'What you can do:',
    '- When the owner sends a photo or video, write a Facebook caption for it with the writing instructions below, then call propose_post. '
      + 'If they did not say when to post, use when="draft" and add one short sentence saying they can ask you to schedule it or post it now.',
    '- For changes, call propose_post again with the full new caption.',
    '- To post at a time, call propose_post with when set to an Israel local time (YYYY-MM-DDTHH:MM). Use "now" only when asked to publish immediately.',
    '- Use list_scheduled for questions about scheduled posts, and propose_cancel to unschedule one.',
    'Rules:',
    '- Nothing happens until the owner taps Approve. Never say that a post was published, scheduled or cancelled.',
    '- After propose_post the caption and buttons are shown automatically. Do not repeat the caption; reply with at most one short sentence, or nothing.',
    '- Reply in the owner\'s language, briefly and in plain words.',
    '- Base the caption on what you can see and what the owner wrote. For a video you see only one still frame: '
      + 'do not describe what happens in the video or what is said in it.',
    '- With no photo or video yet, ask the owner to send one before writing a post.',
    `Now: ${weekday}, ${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)} (Israel time).`,
    `Current photo or video: ${upload ? `${upload.type === 'video' ? 'a video' : 'a photo'}`
      + `${upload.description ? `; the owner wrote: ${upload.description}` : ''}${upload.vision ? '' : ' (you cannot see it)'}` : 'none'}.`,
    `Waiting for approval: ${pending ? (pending.action === 'unschedule' ? `unscheduling post ${pending.draft_id}`
      : `the caption below, ${pending.publish ? 'to publish now' : pending.scheduled_at ? `scheduled for ${pending.scheduled_at} (UTC)` : 'as a draft'}:\n${pending.caption}`) : 'nothing'}.`,
    '',
    'Writing instructions for captions (saved by the owner):',
    (state.prompts?.[type] || DEFAULT_PROMPTS[type]) + ACCURACY,
  ].join('\n');
}

/** The AI's tools. A proposal is only remembered here; it is shown after the AI's reply. */
function tools(chat, state, now) {
  const scheduled = state.drafts.filter(d => d.status === 'scheduled');
  const result = { proposal: null };
  const expires_at = new Date(now.getTime() + PROPOSAL_MS).toISOString();
  result.run = (name, args) => {
    if (name === 'list_scheduled')
      return { scheduled: scheduled.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at)).slice(0, 20).map(d => ({
        id: d.id, type: d.type, time: formatTime(new Date(d.scheduled_at), 'en'), caption: String(d.text).slice(0, 160) })) };
    if (name === 'propose_cancel') {
      const draft = scheduled.find(d => d.id === args.draft_id);
      if (!draft) return { error: 'There is no scheduled post with this id. Call list_scheduled first.' };
      result.proposal = { id: crypto.randomUUID(), action: 'unschedule', draft_id: draft.id, revision: draft.revision,
        time: draft.scheduled_at, caption: String(draft.text).slice(0, 600), expires_at };
      return { shown_to_owner: true };
    }
    if (name === 'propose_post') {
      if (!chat.upload) return { error: 'There is no photo or video yet. Ask the owner to send one.' };
      const caption = String(args.caption ?? '').trim();
      if (!caption || caption.length > 12000) return { error: 'The caption must contain 1–12,000 characters.' };
      let scheduled_at = null;
      if (args.when !== 'now' && args.when !== 'draft') {
        const date = localTime(args.when);
        if (!date) return { error: 'Use "now", "draft", or an Israel local time like 2026-10-18T18:00.' };
        if (date.getTime() < now.getTime() + 2 * 60 * 1000) return { error: 'That time has passed. Ask the owner for a future time.' };
        scheduled_at = date.toISOString();
      }
      result.proposal = { id: crypto.randomUUID(), action: 'post', upload: chat.upload, caption, scheduled_at,
        publish: args.when === 'now', expires_at };
      return { shown_to_owner: true, note: 'The caption and Approve/Cancel buttons are shown automatically. Do not repeat the caption.' };
    }
    return { error: 'Unknown tool.' };
  };
  return result;
}

// Some reasoning models accept tools in Chat Completions only with reasoning turned off,
// while older models reject the setting. Remember which models needed it.
const reasoningOff = new Set();

async function openai(env, model, messages) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try {
      response = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(90000),
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, tools: TOOLS, ...(reasoningOff.has(model) ? { reasoning_effort: 'none' } : {}) }) });
    } catch (error) { console.error('OpenAI connection failed', error?.name ?? 'Error'); throw new Notice('ai'); }
    const value = await response.json().catch(() => null);
    if (response.ok && value?.choices?.[0]?.message) return value.choices[0].message;
    // Never log the provider body: it can echo request details. The error code and type are safe.
    const problem = String(value?.error?.message ?? '');
    if (response.status === 400 && !reasoningOff.has(model) && /reasoning_effort/.test(problem) && /'none'/.test(problem)) {
      reasoningOff.add(model);
      continue;
    }
    console.error('OpenAI request failed', response.status, value?.error?.code ?? '', value?.error?.type ?? '', model);
    throw new Notice('ai');
  }
  throw new Notice('ai');
}

function proposalText(ctx, proposal) {
  const t = ctx.t;
  let caption = proposal.caption;
  if (caption.length > 3500) caption = `${caption.slice(0, 3500)}…\n\n${t.trimmed}`;
  if (proposal.action === 'unschedule') return `${t.unschedule(formatTime(new Date(proposal.time), ctx.lang))}\n\n${caption}`;
  const when = proposal.publish ? t.now : proposal.scheduled_at ? t.at(formatTime(new Date(proposal.scheduled_at), ctx.lang)) : t.draft;
  return `${caption}\n\n— ${when}`;
}

async function converse(ctx, userText) {
  if (!ctx.env.OPENAI_API_KEY) throw new Notice('ai');
  await typing(ctx.env, ctx.chatId);
  const [chat, state] = await Promise.all([readChat(ctx), readState(ctx)]);
  const now = new Date(Date.now());
  const toolbox = tools(chat, state, now);
  const vision = chat.upload?.vision;
  const image = vision ? await download(ctx.env, vision.file_id, VISION_LIMIT)
    .then(bytes => `data:${vision.mime};base64,${base64(bytes)}`).catch(() => null) : null;
  const messages = [{ role: 'system', content: systemPrompt(chat, state, now) }, ...chat.messages,
    { role: 'user', content: image ? [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url: image } }] : userText }];
  // TELEGRAM_OPENAI_MODEL gives the bot its own model; otherwise it shares the studio's.
  const model = ctx.env.TELEGRAM_OPENAI_MODEL || state.ai_settings?.model || ctx.env.OPENAI_MODEL || 'gpt-4.1-mini';
  let reply = '';
  for (let round = 0; round < 4; round++) {
    const message = await openai(ctx.env, model, messages);
    if (!message.tool_calls?.length) { reply = String(message.content ?? '').trim().slice(0, 4000); break; }
    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls });
    for (const call of message.tool_calls) {
      let args;
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(toolbox.run(call.function?.name, args ?? {})) });
    }
  }
  const proposal = toolbox.proposal;
  // Save before sending the buttons, so an Approve tap always finds this proposal.
  await changeChat(ctx, c => {
    c.messages = [...c.messages, { role: 'user', content: userText.slice(0, 4000) },
      ...(reply ? [{ role: 'assistant', content: reply }] : []),
      ...(proposal ? [{ role: 'assistant', content: `[Shown with Approve/Cancel buttons]\n${proposalText(ctx, proposal)}`.slice(0, 4000) }] : [])]
      .slice(-HISTORY);
    if (proposal) c.pending = proposal;
  });
  if (reply) await send(ctx.env, ctx.chatId, reply);
  if (proposal) await send(ctx.env, ctx.chatId, proposalText(ctx, proposal), { reply_markup: { inline_keyboard: [[
    { text: `✅ ${ctx.t.approve}`, callback_data: `ok:${proposal.id}` }, { text: `✖️ ${ctx.t.cancel}`, callback_data: `no:${proposal.id}` }]] } });
}

async function onMessage(ctx, message) {
  const text = String(message.text ?? message.caption ?? '').trim().slice(0, 2000);
  if (/^\/(start|help)\b/.test(text)) return send(ctx.env, ctx.chatId, ctx.t.welcome);
  if (/^\/(reset|new)\b/.test(text)) {
    await changeChat(ctx, c => { Object.assign(c, { messages: [], upload: null, pending: null }); });
    return send(ctx.env, ctx.chatId, ctx.t.reset);
  }
  const media = mediaOf(message);
  if (media?.unsupported) throw new Notice('unsupported');
  if (media) {
    const group = message.media_group_id ?? null;
    if (group && (await readChat(ctx)).upload?.media_group_id === group) return send(ctx.env, ctx.chatId, ctx.t.album);
    await typing(ctx.env, ctx.chatId, 'upload_document');
    const id = await saveUpload(ctx.env, ctx.backend, media);
    await changeChat(ctx, c => {
      c.upload = { id, type: media.type, name: media.name, description: text || null, vision: media.vision, media_group_id: group };
      c.pending = null;
    });
    return converse(ctx, `[Sent a ${media.type === 'video' ? 'video' : 'photo'}${text ? '' : ' without a description'}]${text ? ` ${text}` : ''}`);
  }
  if (text) return converse(ctx, text);
}

async function onButton(ctx, query) {
  await telegram(ctx.env, 'answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
  const [, verb, id] = String(query.data ?? '').match(/^(ok|no):([0-9a-f-]{36})$/) ?? [];
  if (query.message?.message_id) await telegram(ctx.env, 'editMessageReplyMarkup', { chat_id: ctx.chatId,
    message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  const now = Date.now();
  const pending = await changeChat(ctx, c => {
    const p = c.pending;
    if (!verb || !p || p.id !== id) return SKIP;
    c.pending = null;
    if (Date.parse(p.expires_at) < now) return null;
    if (verb === 'ok' && p.action === 'post') c.upload = null;
    c.messages = [...c.messages, { role: 'user', content: verb === 'ok' ? '[Tapped Approve]' : '[Tapped Cancel]' }].slice(-HISTORY);
    return p;
  });
  if (pending === SKIP || !pending) return send(ctx.env, ctx.chatId, ctx.t.stale);
  if (verb === 'no') return send(ctx.env, ctx.chatId, ctx.t.cancelled);
  const commandId = `telegram-${pending.id}`;
  const command = pending.action === 'unschedule'
    ? { id: commandId, action: 'cancel_draft', draft_id: pending.draft_id, revision: pending.revision }
    : { id: commandId, action: 'create_upload_draft', type: pending.upload.type, upload_id: pending.upload.id, text: pending.caption,
      ...(pending.upload.description ? { description: pending.upload.description } : {}),
      ...(pending.scheduled_at ? { scheduled_at: pending.scheduled_at } : {}), ...(pending.publish ? { publish: true } : {}) };
  await ctx.backend.dispatch(ctx.env, validateCommand({ ...command, notify_chat_id: String(ctx.chatId), notify_language: ctx.lang }));
  return send(ctx.env, ctx.chatId, ctx.t.working);
}

async function route(env, backend, update) {
  const message = update?.message, query = update?.callback_query;
  const from = message?.from ?? query?.from;
  const chat = message?.chat ?? query?.message?.chat;
  if (!from || !chat || chat.type !== 'private' || !Number.isInteger(update.update_id)) return;
  const lang = String(from.language_code ?? '').startsWith('he') ? 'he' : 'en';
  if (!allowedUsers(env).includes(String(from.id))) {
    // Helps the owner find their user ID during setup; reveals nothing else.
    if (/^\/start\b/.test(message?.text ?? '')) await send(env, chat.id, TEXT[lang].private(from.id));
    return;
  }
  const ctx = { env, backend, chatId: chat.id, lang, t: TEXT[lang] };
  // Telegram repeats an update when a reply is slow. Claim each one once.
  const claimed = await changeChat(ctx, c => {
    if (c.updates.includes(update.update_id)) return SKIP;
    c.updates = [update.update_id, ...c.updates].slice(0, 30);
  });
  if (claimed === SKIP) return;
  try {
    if (query) await onButton(ctx, query);
    else if (message) await onMessage(ctx, message);
  } catch (error) {
    await send(env, chat.id, error instanceof Notice ? ctx.t[error.key] : ctx.t.failed).catch(() => {});
    if (!(error instanceof Notice)) throw error;
  }
}

/**
 * POST /telegram/webhook. backend needs readState, dispatch, writeUpload, and
 * readFile(env, path) → {text, sha} | null / writeFile(env, path, text, sha) → false on conflict.
 */
export async function handleTelegram(request, env, backend) {
  if (request.method !== 'POST' || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET || !allowedUsers(env).length)
    return new Response(null, { status: 404 });
  if (!sameSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.TELEGRAM_WEBHOOK_SECRET))
    return new Response(null, { status: 401 });
  // Always answer 200 once the request is genuine: Telegram would otherwise resend it.
  try { await route(env, backend, await body(request, 262144)); }
  catch (error) { console.error('Telegram update failed', error?.name ?? 'Error'); }
  return new Response(null, { status: 200 });
}
