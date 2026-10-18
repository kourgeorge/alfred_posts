// The Telegram bot. The owner sends a photo or video, chats with the AI about
// the caption, and approves the post with a button. The bot can also do what the
// studio website does with posts and schedules: list, edit, reschedule, publish,
// delete, generate, and manage recurring schedules. The AI runs here in the
// gateway so replies take seconds; an approved change runs as the usual studio
// command. Setup: STUDIO.md → "Telegram bot".
//
// Nothing changes in the studio without an Approve tap. The bot answers only
// the Telegram accounts in TELEGRAM_ALLOWED_USER_IDS, in private chats.
import { UPLOAD_CHUNK, base64, body, encoder, uploadManifest, validateCommand } from './core.js';
import { ACCURACY, DEFAULT_PROMPTS } from '../server/content.js';
import { TYPES, wallClock, zonedTime } from '../server/scheduler.js';
import CAPTION_STYLES from '../caption_styles.json' with { type: 'json' };
import { readLimited } from '../server/util.js';
import { botSettings } from './telegram-settings.js';

const ZONE = 'Asia/Jerusalem';
const MAX_DOWNLOAD = 20 * 1024 * 1024; // Telegram's download limit for bots.
const LIMITS = { image: 10 * 1024 * 1024, video: 50 * 1024 * 1024 };
const VISION_LIMIT = 5 * 1024 * 1024;
const HISTORY = 20;
const PROPOSAL_MS = 24 * 60 * 60 * 1000;
const FORMATS = { 'image/jpeg': ['image', ['jpg', 'jpeg']], 'image/png': ['image', ['png']], 'image/webp': ['image', ['webp']],
  'video/mp4': ['video', ['mp4']], 'video/quicktime': ['video', ['mov']] };
const SKIP = Symbol('skip');
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const EDITABLE = ['draft', 'scheduled', 'failed'];

const TEXT = {
  en: {
    private: id => `This bot is private. Your Telegram user ID is ${id}. Ask the studio owner to add it.`,
    welcome: 'Hi! Send me a photo or video, with a few words about it if you like, and I will write a Facebook post. '
      + 'You can also ask what is scheduled, change or reschedule a post, publish it now, create a draft from your Drive or the news, '
      + 'and manage your recurring schedules. Nothing changes until you tap Approve.',
    reset: 'Started a new conversation.',
    paused: 'The bot is paused. It can be turned back on in Alfred Studio → Settings → Telegram bot.',
    tooLarge: 'This file is too large. Telegram lets bots download files up to 20 MB, and the studio accepts photos up to 10 MB. '
      + 'Upload larger videos in Alfred Studio.',
    unsupported: 'Send a JPG, PNG or WebP photo, or an MP4 or MOV video.',
    album: 'I use one photo or video per post, so I kept the first one.',
    failed: 'Sorry, something went wrong. Please try again.',
    ai: 'I could not reach the AI right now. Please try again in a minute.',
    approve: 'Approve', cancel: 'Cancel',
    now: 'Publish now', draft: 'Save as a draft in Alfred Studio', at: time => `Schedule for ${time}`,
    toDraft: 'Unschedule it and move it back to your drafts', moveTo: time => `New time: ${time}`,
    stays: time => `It stays scheduled for ${time}.`,
    edit: 'Change this post?', newMedia: 'Replace its photo or video with the one you sent', newCaption: 'New caption:',
    remove: 'Delete this post? It is removed from your drafts, and a scheduled time is cancelled.',
    generate: (format, style) => `Create a new ${format} draft${style ? ` in a ${style} style` : ''}? Alfred picks the source and writes the caption. It is saved as a draft for you to review.`,
    newSchedule: 'Create this recurring schedule?', changeSchedule: name => `Change the schedule "${name}"?`,
    scheduleLines: s => [`Name: ${s.name}`, `Format: ${s.format}`, `Days: ${s.days}`, `Time: ${s.time} (${s.timezone})`,
      `When it runs: ${s.mode === 'publish' ? 'generate and publish automatically, without review' : 'prepare a draft for you to review'}`],
    pause: name => `Pause the schedule "${name}"? It creates no posts until you resume it.`,
    resume: name => `Resume the schedule "${name}"?`,
    removeSchedule: name => `Delete the schedule "${name}"? Future runs stop. Posts it already created stay.`,
    recover: (name, time) => `Prepare the missed post from "${name}" (${time})? It is saved as a draft for you to review.`,
    runDue: 'Run the schedule check now? Due posts set to publish are sent to Facebook; other due tasks prepare drafts.',
    formats: { image: 'photo', video: 'video', question: 'question', news: 'news' },
    days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    styles: Object.fromEntries(Object.entries(CAPTION_STYLES).map(([key, style]) => [key, style.label.toLowerCase()])),
    stale: 'This suggestion is no longer available.',
    working: 'Approved. I will let you know when it is done.',
    cancelled: 'Cancelled. Nothing was changed.',
    trimmed: '(Shortened here. The full caption will be saved.)',
  },
  he: {
    private: id => `הבוט הזה פרטי. מזהה המשתמש שלך בטלגרם הוא ${id}. בקשו מבעל הסטודיו להוסיף אותו.`,
    welcome: 'שלום! שלחו לי תמונה או סרטון, אפשר עם כמה מילים עליו, ואכתוב פוסט לפייסבוק. '
      + 'אפשר גם לשאול מה מתוזמן, לשנות פוסט או את המועד שלו, לפרסם עכשיו, ליצור טיוטה מהדרייב או מהחדשות '
      + 'ולנהל את התזמונים הקבועים. שום דבר לא משתנה עד שתלחצו על "אישור".',
    reset: 'התחלנו שיחה חדשה.',
    paused: 'הבוט מושהה. אפשר להפעיל אותו מחדש ב-Alfred Studio ← הגדרות ← בוט טלגרם.',
    tooLarge: 'הקובץ גדול מדי. טלגרם מאפשר לבוטים להוריד קבצים עד 20MB, והסטודיו מקבל תמונות עד 10MB. '
      + 'סרטונים גדולים יותר אפשר להעלות דרך Alfred Studio.',
    unsupported: 'שלחו תמונה מסוג JPG, PNG או WebP, או סרטון MP4 או MOV.',
    album: 'אני משתמש בתמונה או בסרטון אחד לכל פוסט, לכן שמרתי את הראשון.',
    failed: 'מצטער, משהו השתבש. נסו שוב.',
    ai: 'לא הצלחתי להגיע ל-AI כרגע. נסו שוב בעוד דקה.',
    approve: 'אישור', cancel: 'ביטול',
    now: 'פרסום עכשיו', draft: 'שמירה כטיוטה ב-Alfred Studio', at: time => `תזמון ל-${time}`,
    toDraft: 'ביטול התזמון והחזרה לטיוטות', moveTo: time => `מועד חדש: ${time}`,
    stays: time => `הפוסט נשאר מתוזמן ל-${time}.`,
    edit: 'לשנות את הפוסט הזה?', newMedia: 'החלפת התמונה או הסרטון במה ששלחתם', newCaption: 'כיתוב חדש:',
    remove: 'למחוק את הפוסט הזה? הוא יוסר מהטיוטות, ותזמון שלו יבוטל.',
    generate: (format, style) => `ליצור טיוטה חדשה של ${format}${style ? ` בסגנון ${style}` : ''}? אלפרד יבחר את המקור ויכתוב את הכיתוב. היא תישמר כטיוטה לבדיקה שלכם.`,
    newSchedule: 'ליצור את התזמון הקבוע הזה?', changeSchedule: name => `לשנות את התזמון "${name}"?`,
    scheduleLines: s => [`שם: ${s.name}`, `סוג: ${s.format}`, `ימים: ${s.days}`, `שעה: ${s.time} (${s.timezone})`,
      `כשמגיע הזמן: ${s.mode === 'publish' ? 'יצירה ופרסום אוטומטי, בלי בדיקה' : 'הכנת טיוטה לבדיקה שלכם'}`],
    pause: name => `להשהות את התזמון "${name}"? הוא לא ייצור פוסטים עד שתפעילו אותו מחדש.`,
    resume: name => `להפעיל מחדש את התזמון "${name}"?`,
    removeSchedule: name => `למחוק את התזמון "${name}"? ההרצות הבאות ייעצרו. פוסטים שכבר נוצרו יישארו.`,
    recover: (name, time) => `להכין את הפוסט שהוחמץ מ"${name}" (${time})? הוא יישמר כטיוטה לבדיקה שלכם.`,
    runDue: 'להריץ עכשיו את בדיקת התזמונים? פוסטים שהגיע זמנם ומוגדרים לפרסום יישלחו לפייסבוק; משימות אחרות יכינו טיוטות.',
    formats: { image: 'תמונה', video: 'סרטון', question: 'שאלה', news: 'חדשות' },
    days: ['שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת', 'ראשון'],
    styles: { default: 'השמור', neutral: 'ניטרלי', funny: 'מצחיק', friendly: 'ידידותי', professional: 'מקצועי', educational: 'לימודי',
      motivational: 'מעורר מוטיבציה', storytelling: 'סיפורי', promotional: 'שיווקי' },
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

const tool = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description,
  parameters: { type: 'object', additionalProperties: false, required, properties } } });
const WHEN = 'An Israel local time as YYYY-MM-DDTHH:MM to schedule it, "now" to publish immediately, or "draft"';
const TOOLS = [
  tool('propose_post', 'Show the owner a caption for the photo or video they sent, with Approve and Cancel buttons. '
    + 'Call it again with the full new caption to make changes.', {
    caption: { type: 'string', description: 'The complete Facebook caption.' },
    when: { type: 'string', description: `${WHEN} to save it in Alfred Studio.` } }, ['caption', 'when']),
  tool('list_posts', 'List saved posts. "open" (the default) is drafts, scheduled posts and posts that need attention.', {
    filter: { type: 'string', enum: ['open', 'scheduled', 'drafts', 'attention', 'published', 'all'],
      description: '"attention" also lists missed schedule runs.' } }),
  tool('get_post', 'Show one post in full, including its whole caption.', { post_id: { type: 'string' } }, ['post_id']),
  tool('propose_edit', 'Ask the owner to approve changes to a saved post. Send only what changes.', {
    post_id: { type: 'string' },
    caption: { type: 'string', description: 'The complete new caption.' },
    when: { type: 'string', description: `${WHEN} to unschedule it and move it back to the drafts.` },
    replace_media: { type: 'boolean', description: 'Use the photo or video the owner sent in this chat instead of the current one.' } },
    ['post_id']),
  tool('propose_delete', 'Ask the owner to approve deleting a post that is not published yet.', { post_id: { type: 'string' } }, ['post_id']),
  tool('propose_generate', 'Ask the owner to approve creating a new draft, like the studio\'s Create page: '
    + 'a photo or video from the Drive folder, a question from Google Forms, or a recent news story.', {
    format: { type: 'string', enum: [...TYPES, 'news'] },
    style: { type: 'string', enum: Object.keys(CAPTION_STYLES), description: 'Caption tone. "default" uses the saved writing instructions.' } },
    ['format']),
  tool('list_schedules', 'List the recurring schedules, with their next run.'),
  tool('propose_schedule', 'Ask the owner to approve a new recurring schedule, or changes to one (with schedule_id; send only what changes).', {
    schedule_id: { type: 'string' },
    name: { type: 'string' },
    format: { type: 'string', enum: TYPES },
    days: { type: 'array', items: { type: 'string', enum: DAYS } },
    time: { type: 'string', description: 'HH:MM, 24-hour, in the schedule\'s time zone (Israel time for a new schedule).' },
    mode: { type: 'string', enum: ['draft', 'publish'], description: '"draft" prepares a draft to review; "publish" posts without review.' } }),
  tool('propose_schedule_switch', 'Ask the owner to approve pausing (on=false) or resuming (on=true) a schedule.', {
    schedule_id: { type: 'string' }, on: { type: 'boolean' } }, ['schedule_id', 'on']),
  tool('propose_delete_schedule', 'Ask the owner to approve deleting a recurring schedule.', { schedule_id: { type: 'string' } }, ['schedule_id']),
  tool('propose_missed', 'Ask the owner to approve preparing the post for a missed schedule run (from list_posts with filter "attention").', {
    missed_id: { type: 'string' } }, ['missed_id']),
  tool('propose_run_due', 'Ask the owner to approve running the schedule check now, for posts and schedules that are due.'),
];

function sameSecret(value, expected) {
  const a = encoder.encode(String(value ?? '')), b = encoder.encode(expected);
  let difference = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) difference |= (a[i] ?? 0) ^ b[i];
  return difference === 0;
}

const hex = buffer => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
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
      + 'You chat with the page owner on Telegram. You can do everything the studio website does with posts and schedules.',
    'Posts:',
    '- When the owner sends a photo or video, write a Facebook caption for it with the writing instructions below, then call propose_post. '
      + 'If they did not say when to post, use when="draft" and add one short sentence saying they can ask you to schedule it or post it now.',
    '- For changes to that caption before it is approved, call propose_post again with the full new caption.',
    '- list_posts and get_post show saved posts. propose_edit changes a saved post: its caption, its time '
      + '(a new time, "now" to publish it, "draft" to unschedule it), or its photo or video (replace_media, with the one the owner sent here).',
    '- propose_delete deletes a post. propose_generate creates a new draft from the Drive folder, Google Forms or the news.',
    '- When the owner refers to a post ("the previous post", "Monday\'s post"), look it up with list_posts. '
      + 'If more than one post could match, ask which one. Never guess an id.',
    'Schedules (recurring times when Alfred creates or publishes a post by itself):',
    '- list_schedules shows them with their next run. propose_schedule creates or changes one, '
      + 'propose_schedule_switch pauses or resumes one, propose_delete_schedule deletes one.',
    '- list_posts with filter "attention" shows posts that failed or are overdue, and missed schedule runs. '
      + 'propose_missed prepares the post for a missed run. propose_run_due runs the schedule check now.',
    'Rules:',
    '- Every change waits for the owner to tap Approve, and only one change can wait at a time. '
      + 'Never say that something was published, scheduled, changed or deleted; say it is ready to approve.',
    '- After a propose_ tool the details and buttons are shown automatically. Do not repeat them; reply with at most one short sentence, or nothing.',
    '- If a tool returns an error, fix the request or ask the owner.',
    '- Post statuses: draft, scheduled, overdue (its time passed but it was not published), failed (needs attention), '
      + 'uncertain (Facebook did not confirm: the owner should check the page before anything else), published.',
    '- Times are in Israel time. Reply in the owner\'s language, briefly and in plain words.',
    '- Base a caption on what you can see and what the owner wrote. For a video you see only one still frame: '
      + 'do not describe what happens in the video or what is said in it.',
    '- To write a new post from a photo or video, ask the owner to send one first.',
    `Now: ${weekday}, ${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)} (Israel time).`,
    `Photo or video sent in this chat: ${upload ? `${upload.type === 'video' ? 'a video' : 'a photo'}`
      + `${upload.description ? `; the owner wrote: ${upload.description}` : ''}${upload.vision ? '' : ' (you cannot see it)'}` : 'none'}.`,
    `Waiting for approval: ${pending?.command ? proposalText(pending, 'en') : 'nothing'}.`,
    '',
    'Writing instructions for captions (saved by the owner):',
    (state.prompts?.[type] || DEFAULT_PROMPTS[type]) + ACCURACY,
  ].join('\n');
}

const localTimeText = value => value ? formatTime(new Date(value), 'en') : null;

/** A post as the AI sees it in a list. */
function postSummary(draft, schedules, now) {
  const overdue = draft.status === 'scheduled' && now - new Date(draft.scheduled_at) > 30 * 60 * 1000;
  return { id: draft.id, format: draft.type, status: overdue ? 'overdue' : draft.status,
    ...(draft.scheduled_at ? { scheduled_for: localTimeText(draft.scheduled_at) } : {}),
    ...(draft.published_at ? { published: localTimeText(draft.published_at) } : {}),
    created: localTimeText(draft.created_at), media: draft.source?.name ?? null,
    ...(draft.schedule_id ? { from_schedule: schedules.find(s => s.id === draft.schedule_id)?.name ?? 'a deleted schedule' } : {}),
    ...(draft.error ? { problem: draft.error } : {}), caption: String(draft.text ?? '').slice(0, 200) };
}

function nextRun(schedule, now) {
  if (!schedule.enabled) return null;
  const today = wallClock(now, schedule.timezone);
  const [hour, minute] = schedule.time.split(':').map(Number);
  for (let i = 0; i < 8; i++) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    if (!schedule.days.includes((day.getUTCDay() + 6) % 7)) continue;
    const at = zonedTime({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour, minute, second: 0 }, schedule.timezone);
    if (at && at > now) return at;
  }
  return null;
}

/** A future Israel time, "now" or "draft"; anything else is an error message for the AI. */
function parseWhen(value, now) {
  if (value === 'now' || value === 'draft') return { when: value };
  const date = localTime(value);
  if (!date) return { error: 'Use "now", "draft", or an Israel local time like 2026-10-18T18:00.' };
  if (date.getTime() < now.getTime() + 2 * 60 * 1000) return { error: 'That time has passed. Ask the owner for a future time.' };
  return { when: date.toISOString() };
}

const caption = value => {
  const text = String(value ?? '').trim();
  return text && text.length <= 12000 ? text : null;
};

/**
 * The AI's tools. Lists answer straight away; a propose_ tool only remembers one
 * proposal, with the exact studio command it runs, shown after the AI's reply.
 */
function tools(chat, state, now) {
  const drafts = state.drafts.filter(d => d.status !== 'deleted');
  const schedules = state.schedules ?? [];
  const result = { proposal: null };
  const expires_at = new Date(now.getTime() + PROPOSAL_MS).toISOString();
  const post = id => drafts.find(d => d.id === id);
  const schedule = id => schedules.find(s => s.id === id);
  const propose = proposal => {
    result.proposal = { id: crypto.randomUUID(), expires_at, ...proposal };
    return { shown_to_owner: true, note: 'The details and Approve/Cancel buttons are shown automatically. Do not repeat them.' };
  };
  const notChangeable = draft => !draft ? 'There is no post with this id. Call list_posts first.'
    : !EDITABLE.includes(draft.status) ? `This post is ${draft.status} and can no longer be changed.` : null;

  const run = {
    list_posts({ filter = 'open' }) {
      const attention = d => ['failed', 'uncertain'].includes(d.status)
        || (d.status === 'scheduled' && now - new Date(d.scheduled_at) > 30 * 60 * 1000);
      const match = { open: d => EDITABLE.includes(d.status) || d.status === 'uncertain', scheduled: d => d.status === 'scheduled',
        drafts: d => d.status === 'draft', attention, published: d => ['published', 'processing'].includes(d.status), all: () => true }[filter];
      if (!match) return { error: 'Unknown filter.' };
      const time = d => d.status === 'scheduled' ? d.scheduled_at : d.published_at || d.created_at || '';
      const posts = drafts.filter(match).sort((a, b) => a.status === 'scheduled' && b.status === 'scheduled'
        ? a.scheduled_at.localeCompare(b.scheduled_at) : String(time(b)).localeCompare(String(time(a))));
      const missed = ['attention', 'all'].includes(filter) ? (state.missed_runs ?? [])
        .filter(r => r.id && ['missed', 'failed'].includes(r.status) && !drafts.some(d => d.id === (r.draft_id || r.id)))
        .map(r => ({ missed_id: r.id, schedule: r.name, format: r.type, time: localTimeText(r.scheduled_at), status: r.status,
          ...(r.error ? { problem: r.error } : {}) })) : [];
      return { posts: posts.slice(0, 25).map(d => postSummary(d, schedules, now)), total: posts.length,
        ...(missed.length ? { missed_runs: missed.slice(0, 20) } : {}) };
    },
    get_post({ post_id }) {
      const draft = post(post_id);
      if (!draft) return { error: 'There is no post with this id. Call list_posts first.' };
      return { ...postSummary(draft, schedules, now), caption: String(draft.text ?? '').slice(0, 4000),
        ...(draft.source?.description ? { media_description: draft.source.description } : {}),
        ...(draft.facebook_url ? { facebook_url: draft.facebook_url } : {}), can_change: EDITABLE.includes(draft.status) };
    },
    propose_post(args) {
      if (!chat.upload) return { error: 'There is no photo or video yet. Ask the owner to send one.' };
      const text = caption(args.caption);
      if (!text) return { error: 'The caption must contain 1–12,000 characters.' };
      const { when, error } = args.when === 'draft' ? { when: 'draft' } : parseWhen(args.when, now);
      if (error) return { error };
      const upload = chat.upload;
      return propose({ kind: 'post', caption: text, when, uses_upload: true, command: { action: 'create_upload_draft',
        type: upload.type, upload_id: upload.id, text, ...(upload.description ? { description: upload.description } : {}),
        ...(when === 'now' ? { publish: true } : when !== 'draft' ? { scheduled_at: when } : {}) } });
    },
    propose_edit(args) {
      const draft = post(args.post_id);
      const problem = notChangeable(draft);
      if (problem) return { error: problem };
      const text = args.caption === undefined ? null : caption(args.caption);
      if (args.caption !== undefined && !text) return { error: 'The caption must contain 1–12,000 characters.' };
      let when = null;
      if (args.when !== undefined && args.when !== 'keep') {
        const parsed = parseWhen(args.when, now);
        if (parsed.error) return { error: parsed.error };
        when = parsed.when;
      }
      const media = args.replace_media === true;
      if (media && !chat.upload) return { error: 'The owner has not sent a photo or video in this chat. Ask them to send one.' };
      if (media && draft.type === 'news') return { error: 'News posts share the original link, so their media cannot be replaced.' };
      if (media && when) return { error: 'Replace the photo or video first. After the owner approves it, propose the time change.' };
      if (when === 'draft' && draft.status === 'draft') when = null;
      if (!text && !when && !media) return { error: 'Nothing would change. Ask the owner what to change.' };
      const base = { draft_id: draft.id, revision: draft.revision, ...(text ? { text } : {}) };
      const command = media ? { action: 'replace_media', ...base, text: text ?? draft.text, type: chat.upload.type, upload_id: chat.upload.id }
        : when === 'now' ? { action: 'publish', ...base }
        : when === 'draft' ? { action: 'cancel_draft', ...base }
        : when ? { action: 'schedule_draft', ...base, scheduled_at: when }
        : { action: 'save_draft', ...base };
      return propose({ kind: 'edit', current: String(draft.text ?? ''), caption: text, when, media, uses_upload: media,
        stays: !when && draft.status === 'scheduled' ? draft.scheduled_at : null, command });
    },
    propose_delete({ post_id }) {
      const draft = post(post_id);
      const problem = notChangeable(draft);
      if (problem) return { error: problem };
      return propose({ kind: 'delete', current: String(draft.text ?? ''), command: { action: 'delete_draft', draft_id: draft.id, revision: draft.revision } });
    },
    propose_generate({ format, style = 'default' }) {
      if (![...TYPES, 'news'].includes(format)) return { error: 'Choose photo (image), video, question or news.' };
      if (!Object.hasOwn(CAPTION_STYLES, style)) return { error: `Choose a style from: ${Object.keys(CAPTION_STYLES).join(', ')}.` };
      if (drafts.filter(d => EDITABLE.includes(d.status)).length >= 30)
        return { error: 'There are 30 unfinished posts. The owner must publish or delete some first.' };
      return propose({ kind: 'generate', format, style, command: { action: 'generate', type: format, caption_style: style } });
    },
    list_schedules() {
      return { schedules: schedules.map(s => {
        const next = nextRun(s, now);
        return { schedule_id: s.id, name: s.name, format: s.type, days: s.days.map(d => DAYS[d]), time: s.time, timezone: s.timezone,
          mode: s.mode, on: Boolean(s.enabled), ...(next ? { next_run: formatTime(next, 'en') } : {}),
          ...(s.last_run ? { last_run: localTimeText(s.last_run), last_result: s.last_status ?? null } : {}) };
      }) };
    },
    propose_schedule(args) {
      const existing = args.schedule_id ? schedule(args.schedule_id) : null;
      if (args.schedule_id && !existing) return { error: 'There is no schedule with this id. Call list_schedules first.' };
      if (!existing && schedules.length >= 12) return { error: 'There are already 12 schedules, the most the studio supports.' };
      const missing = ['name', 'format', 'days', 'time', 'mode'].filter(k => !existing && args[k] === undefined);
      if (missing.length) return { error: `A new schedule needs: ${missing.join(', ')}. Ask the owner.` };
      const name = String(args.name ?? existing.name).trim();
      if (!name || name.length > 100) return { error: 'The name must contain 1–100 characters.' };
      const type = args.format ?? existing.type;
      if (!TYPES.includes(type)) return { error: 'Schedules create a photo, video or question.' };
      const days = args.days === undefined ? existing.days : [...new Set((Array.isArray(args.days) ? args.days : [])
        .map(d => DAYS.indexOf(String(d).toLowerCase().slice(0, 3))))].sort();
      if (!days.length || days.includes(-1)) return { error: `Days must be from: ${DAYS.join(', ')}.` };
      const clock = String(args.time ?? existing.time).match(/^(\d{1,2}):(\d{2})$/);
      if (!clock || +clock[1] > 23 || +clock[2] > 59) return { error: 'Use a 24-hour time like 09:00.' };
      const mode = args.mode ?? existing.mode;
      if (!['draft', 'publish'].includes(mode)) return { error: 'The mode must be "draft" or "publish".' };
      const value = { name, type, mode, days, time: `${clock[1].padStart(2, '0')}:${clock[2]}`,
        timezone: existing?.timezone ?? ZONE, enabled: existing?.enabled ?? true };
      if (existing && ['name', 'type', 'mode', 'time', 'timezone'].every(k => value[k] === existing[k]) && value.days.join() === existing.days.join())
        return { error: 'Nothing would change. Ask the owner what to change.' };
      return propose({ kind: 'schedule', previous: existing?.name ?? null, schedule: value,
        command: { action: 'save_schedule', schedule: value, ...(existing ? { schedule_id: existing.id } : {}) } });
    },
    propose_schedule_switch({ schedule_id, on }) {
      const item = schedule(schedule_id);
      if (!item) return { error: 'There is no schedule with this id. Call list_schedules first.' };
      if (typeof on !== 'boolean') return { error: 'Set on to true or false.' };
      if (Boolean(item.enabled) === on) return { error: `This schedule is already ${on ? 'on' : 'paused'}.` };
      return propose({ kind: 'switch', name: item.name, on, command: { action: 'toggle_schedule', schedule_id: item.id, enabled: on } });
    },
    propose_delete_schedule({ schedule_id }) {
      const item = schedule(schedule_id);
      if (!item) return { error: 'There is no schedule with this id. Call list_schedules first.' };
      return propose({ kind: 'delete_schedule', name: item.name, command: { action: 'delete_schedule', schedule_id: item.id } });
    },
    propose_missed({ missed_id }) {
      const run = (state.missed_runs ?? []).find(r => r.id && r.id === missed_id && ['missed', 'failed'].includes(r.status));
      if (!run || drafts.some(d => d.id === (run.draft_id || run.id)))
        return { error: 'There is no missed run with this id. Call list_posts with filter "attention" first.' };
      return propose({ kind: 'missed', name: run.name, time: run.scheduled_at, command: { action: 'recover_missed', missed_id: run.id } });
    },
    propose_run_due() { return propose({ kind: 'run_due', command: { action: 'run_due' } }); },
  };
  result.run = (name, args) => {
    if (!Object.hasOwn(run, name)) return { error: 'Unknown tool.' };
    if (name.startsWith('propose_') && result.proposal)
      return { error: 'One change is already waiting for approval. Ask the owner to approve or cancel it first.' };
    return run[name](args && typeof args === 'object' ? args : {});
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

function clip(text, t, limit = 3500) {
  return text.length > limit ? `${text.slice(0, limit)}…\n\n${t.trimmed}` : text;
}

/** What the owner approves, in their language. */
function proposalText(p, lang) {
  const t = TEXT[lang];
  const time = value => formatTime(new Date(value), lang);
  const when = value => value === 'now' ? t.now : value === 'draft' ? t.draft : t.at(time(value));
  switch (p.kind) {
    case 'post': return `${clip(p.caption, t)}\n\n— ${when(p.when)}`;
    case 'edit': return [t.edit,
      ...(p.media ? [`• ${t.newMedia}`] : []),
      ...(p.when ? [`• ${p.when === 'now' ? t.now : p.when === 'draft' ? t.toDraft : t.moveTo(time(p.when))}`] : []),
      ...(p.stays ? [t.stays(time(p.stays))] : []),
      '', p.caption ? `${t.newCaption}\n${clip(p.caption, t)}` : clip(p.current, t, 600)].join('\n');
    case 'delete': return `${t.remove}\n\n${clip(p.current, t, 600)}`;
    case 'generate': return t.generate(t.formats[p.format], p.style === 'default' ? '' : t.styles[p.style]);
    case 'schedule': {
      const s = p.schedule;
      return [p.previous ? t.changeSchedule(p.previous) : t.newSchedule, '', ...t.scheduleLines({ ...s,
        format: t.formats[s.type], days: s.days.map(d => t.days[d]).join(', ') })].join('\n');
    }
    case 'switch': return p.on ? t.resume(p.name) : t.pause(p.name);
    case 'delete_schedule': return t.removeSchedule(p.name);
    case 'missed': return t.recover(p.name, time(p.time));
    case 'run_due': return t.runDue;
  }
  return '';
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
  for (let round = 0; round < 6; round++) {
    const message = await openai(ctx.env, model, messages);
    if (!message.tool_calls?.length) { reply = String(message.content ?? '').trim().slice(0, 4000); break; }
    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls });
    for (const call of message.tool_calls) {
      let args;
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(toolbox.run(call.function?.name, args)) });
    }
  }
  const proposal = toolbox.proposal;
  // Save before sending the buttons, so an Approve tap always finds this proposal.
  await changeChat(ctx, c => {
    c.messages = [...c.messages, { role: 'user', content: userText.slice(0, 4000) },
      ...(reply ? [{ role: 'assistant', content: reply }] : []),
      ...(proposal ? [{ role: 'assistant', content: `[Shown with Approve/Cancel buttons${proposal.command.draft_id ? `; post ${proposal.command.draft_id}` : ''}]\n${proposalText(proposal, 'en')}`.slice(0, 4000) }] : [])]
      .slice(-HISTORY);
    if (proposal) c.pending = proposal;
  });
  if (reply) await send(ctx.env, ctx.chatId, reply);
  if (proposal) await send(ctx.env, ctx.chatId, proposalText(proposal, ctx.lang), { reply_markup: { inline_keyboard: [[
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
    // Suggestions saved before this version have no command: they cannot be approved.
    if (!p.command) return null;
    if (verb === 'ok' && p.uses_upload) c.upload = null;
    const commandId = `telegram-${p.id}`;
    // A new post's id is the command id: remember it, so "the previous post" can be found.
    const created = ['create_upload_draft', 'generate'].includes(p.command.action) ? ` The new post's id is ${commandId}.` : '';
    c.messages = [...c.messages, { role: 'user', content: verb === 'ok' ? `[Tapped Approve]${created}` : '[Tapped Cancel]' }].slice(-HISTORY);
    return p;
  });
  if (pending === SKIP || !pending) return send(ctx.env, ctx.chatId, ctx.t.stale);
  if (verb === 'no') return send(ctx.env, ctx.chatId, ctx.t.cancelled);
  await ctx.backend.dispatch(ctx.env, validateCommand({ ...pending.command, id: `telegram-${pending.id}`,
    notify_chat_id: String(ctx.chatId), notify_language: ctx.lang }));
  return send(ctx.env, ctx.chatId, ctx.t.working);
}

async function route(env, backend, update) {
  const message = update?.message, query = update?.callback_query;
  const from = message?.from ?? query?.from;
  const chat = message?.chat ?? query?.message?.chat;
  if (!from || !chat || chat.type !== 'private' || !Number.isInteger(update.update_id)) return;
  const lang = String(from.language_code ?? '').startsWith('he') ? 'he' : 'en';
  if (!env.TELEGRAM_USERS.includes(String(from.id))) {
    // Helps the owner find their user ID during setup; reveals nothing else.
    if (/^\/start\b/.test(message?.text ?? '')) await send(env, chat.id, TEXT[lang].private(from.id));
    return;
  }
  if (!env.TELEGRAM_ENABLED) {
    if (message) await send(env, chat.id, TEXT[lang].paused);
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
  if (request.method !== 'POST' || !env.TELEGRAM_WEBHOOK_SECRET) return new Response(null, { status: 404 });
  if (!sameSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.TELEGRAM_WEBHOOK_SECRET))
    return new Response(null, { status: 401 });
  // Always answer 200 once the request is genuine: Telegram would otherwise resend it.
  try {
    // Settings saved in the dashboard take priority over gateway variables.
    const settings = await botSettings(env, backend);
    if (!settings.token) return new Response(null, { status: 200 });
    const merged = { ...env, TELEGRAM_BOT_TOKEN: settings.token, OPENAI_API_KEY: settings.openaiKey,
      TELEGRAM_OPENAI_MODEL: settings.model, TELEGRAM_USERS: settings.users, TELEGRAM_ENABLED: settings.enabled };
    await route(merged, backend, await body(request, 262144));
  }
  catch (error) { console.error('Telegram update failed', error?.name ?? 'Error'); }
  return new Response(null, { status: 200 });
}
