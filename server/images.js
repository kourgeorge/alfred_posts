// Image checks and previews through the Cloudflare Images binding (replaces Pillow).
import { toBase64 } from './util.js';

const stream = data => new Blob([data]).stream();

export class CloudflareImages {
  constructor(binding) { this.binding = binding; }

  /** {width, height, format} when the bytes decode as an image, otherwise null. */
  async info(data) {
    try {
      const info = await this.binding.info(stream(data));
      return info && 'width' in info ? info : null;
    } catch { return null; }
  }

  /** A JPEG data URL that fits within 720×480 (orientation applied), or null. */
  async thumbnail(data, quality = 65) {
    try {
      const result = await this.binding.input(stream(data))
        .transform({ width: 720, height: 480, fit: 'scale-down', background: '#ffffff' })
        .output({ format: 'image/jpeg', quality });
      const bytes = new Uint8Array(await result.response().arrayBuffer());
      return bytes.length ? `data:image/jpeg;base64,${toBase64(bytes)}` : null;
    } catch { return null; }
  }
}
