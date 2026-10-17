// After `vite build`: point the Cloudflare copy of the website at its own Worker.
// The GitHub Pages build keeps web/public/config.json (the Sites gateway).
import { writeFileSync } from 'node:fs';

writeFileSync(new URL('../dist/config.json', import.meta.url), `${JSON.stringify({ gateway: 'same-origin', backend: 'cloudflare' })}\n`);
