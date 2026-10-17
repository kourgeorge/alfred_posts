// Small helpers that reproduce the Python worker's behaviour exactly.
// Both servers must accept, reject, and store the same values.

/** Expected, user-facing failure. Its message is shown in the dashboard (Python's ValueError). */
export class UserError extends Error {}

const PY_SPACE = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const LEADING = new RegExp(`^${PY_SPACE}+`, 'u');
const TRAILING = new RegExp(`${PY_SPACE}+$`, 'u');

/** Python str.strip(): the same whitespace set, unlike String.prototype.trim. */
export const pyStrip = value => value.replace(LEADING, '').replace(TRAILING, '');

/** Python len(): counts code points, so emoji count once. */
export const pyLen = value => [...value].length;

/** Python str() for the JSON values a command can contain. */
export function pyStr(value) {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  return String(value);
}

/** Python `type(x) is int`: booleans and floats are rejected. */
export const isInt = value => typeof value === 'number' && Number.isInteger(value);

/** UTC timestamp in Python's isoformat() shape, e.g. 2026-10-06T10:22:01.123000+00:00. */
export function isoUtc(date) {
  return date.toISOString().replace(/\.(\d{3})Z$/, (_, ms) => ms === '000' ? '+00:00' : `.${ms}000+00:00`);
}

/** Python dict.get(key, fallback): a present null stays null. */
export const get = (object, key, fallback) => Object.hasOwn(object ?? {}, key) ? object[key] : fallback;

/** Parse Python or JavaScript ISO timestamps (microseconds, Z, or offsets). */
export function parseIso(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d{1,6}))?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!match) return null;
  const [, day, time, fraction = '', zone] = match;
  const ms = fraction ? `.${fraction.padEnd(3, '0').slice(0, 3)}` : '';
  const offset = !zone ? '' : zone === 'Z' ? 'Z' : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
  const date = new Date(`${day}T${time.length === 5 ? `${time}:00` : time}${ms}${offset || 'Z'}`);
  if (Number.isNaN(date.getTime())) return null;
  return { date, aware: Boolean(zone) };
}

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = '';
  for (let i = 0; i < view.length; i += 8192) text += String.fromCharCode(...view.subarray(i, i + 8192));
  return btoa(text);
}

export const fromBase64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));

export const clone = value => structuredClone(value);

/** JSON.stringify with Python json.dumps(ensure_ascii=False) spacing: ", " and ": ". */
export function pyJson(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(pyJson).join(', ')}]`;
  if (typeof value === 'object')
    return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${pyJson(v)}`).join(', ')}}`;
  return JSON.stringify(value);
}

/** Read a response body without holding more than `limit` bytes. */
export async function readLimited(response, limit, message) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new UserError(message); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
