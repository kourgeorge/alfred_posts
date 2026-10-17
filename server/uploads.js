// Read immutable uploads stored next to state.json. Mirrors studio/uploads.py.
import { UserError, isInt, pyLen, pyStrip, sha256Hex, decoder } from './util.js';

export const CHUNK_SIZE = 2 * 1024 * 1024;
export const LIMITS = { image: 10 * 1024 * 1024, video: 50 * 1024 * 1024 };
export const FORMATS = { 'image/jpeg': ['image', ['jpg', 'jpeg']], 'image/png': ['image', ['png']],
  'image/webp': ['image', ['webp']], 'video/mp4': ['video', ['mp4']], 'video/quicktime': ['video', ['mov']] };
export const ID_PATTERN = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const ID = new RegExp(`^${ID_PATTERN}$`);

export function validateId(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new UserError('Choose a valid uploaded file.');
  return value;
}

export function validateDescription(value) {
  if (typeof value !== 'string' || pyLen(pyStrip(value)) < 1 || pyLen(pyStrip(value)) > 2000)
    throw new UserError('Describe your image or video in 1–2,000 characters.');
  return pyStrip(value);
}

export function validateManifest(item, uploadId) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || item.id !== validateId(uploadId))
    throw new UserError('The uploaded file details are invalid. Upload the file again.');
  const { name, type: kind, mime, size } = item;
  const format = Object.hasOwn(FORMATS, mime) ? FORMATS[mime] : null;
  if (!format || format[0] !== kind || typeof name !== 'string' || pyLen(name) < 1 || pyLen(name) > 180
      || /[\x00-\x1f/\\]/.test(name) || !format[1].includes(name.split('.').at(-1).toLowerCase()))
    throw new UserError('Use a JPG, PNG, WebP, MP4, or MOV file.');
  if (!isInt(size) || size <= 0 || size > LIMITS[kind]) throw new UserError('Images must be under 10 MB and videos under 50 MB.');
  if (!isInt(item.parts) || item.parts !== Math.ceil(size / CHUNK_SIZE)) throw new UserError('The upload is incomplete. Upload the file again.');
  if (typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)) throw new UserError('The uploaded file checksum is invalid.');
  return item;
}

export const partPath = (id, index) => `uploads/${id}/part-${String(index).padStart(2, '0')}.bin`;
export const manifestPath = id => `uploads/${id}/manifest.json`;

export async function readUpload(store, uploadId) {
  validateId(uploadId);
  const raw = await store.readFile(manifestPath(uploadId), 8192);
  let parsed;
  try { parsed = JSON.parse(decoder.decode(raw)); } catch { throw new UserError('The uploaded file details are invalid. Upload the file again.'); }
  const item = validateManifest(parsed, uploadId);
  const data = new Uint8Array(item.size);
  for (let index = 0; index < item.parts; index++) {
    const part = await store.readFile(partPath(uploadId, index), CHUNK_SIZE);
    const expected = Math.min(CHUNK_SIZE, item.size - index * CHUNK_SIZE);
    if (part.length !== expected) throw new UserError('The upload is incomplete. Upload the file again.');
    data.set(part, index * CHUNK_SIZE);
  }
  if (await sha256Hex(data) !== item.sha256) throw new UserError('The uploaded file changed. Upload the original file again.');
  return [item, data];
}

const ascii = (data, start, end) => String.fromCharCode(...data.subarray(start, end));

/** The still-image format of the bytes, or null. Animated PNG and WebP are reported as 'animated'. */
export function imageFormat(data) {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (ascii(data, 0, 8) === '\x89PNG\r\n\x1a\n') {
    // An APNG has an acTL chunk before the first image data.
    for (let i = 8; i + 8 <= data.length;) {
      const length = ((data[i] << 24) >>> 0) + (data[i + 1] << 16) + (data[i + 2] << 8) + data[i + 3];
      const type = ascii(data, i + 4, i + 8);
      if (type === 'acTL') return 'animated';
      if (type === 'IDAT') break;
      i += 12 + length;
    }
    return 'image/png';
  }
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WEBP') {
    if (ascii(data, 12, 16) === 'VP8X' && data[20] & 0x02) return 'animated';
    return 'image/webp';
  }
  return null;
}

const MP4_BRANDS = ['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'MSNV'];

/** `images` decodes the picture (Cloudflare Images); it replaces Pillow's verify(). */
export async function validateMedia(item, data, images) {
  if (item.type === 'image') {
    const format = imageFormat(data);
    if (format && format !== 'animated' && format !== item.mime) throw new UserError('Choose a still JPG, PNG, or WebP image.');
    if (format === 'animated') throw new UserError('Choose a still JPG, PNG, or WebP image.');
    if (!format || !await images.info(data)) throw new UserError('This image could not be opened. Choose a valid JPG, PNG, or WebP file.');
    return;
  }
  // Check the container signature only. No frames or audio go to the AI.
  const brands = item.mime === 'video/quicktime' ? ['qt  '] : MP4_BRANDS;
  if (data.length < 32 || ascii(data, 4, 8) !== 'ftyp' || !brands.includes(ascii(data, 8, 12)))
    throw new UserError('Choose a valid MP4 or MOV video.');
}
