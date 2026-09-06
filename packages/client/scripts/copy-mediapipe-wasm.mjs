/**
 * Copies MediaPipe's WASM runtime out of node_modules and into public/.
 *
 * MediaPipe ships its JavaScript through npm but loads its WASM and worker
 * files at runtime from a URL. The usual answer is to point that URL at a CDN,
 * which works right up until the CDN is blocked, rate-limited, or serving a
 * different version than the npm package expects.
 *
 * Copying the files that ship *with the installed package* means the version
 * always matches, the app works offline, and there is no manual setup step for
 * anyone who clones the repo: `npm run dev` and `npm run build` both run this
 * first.
 */

import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(here, '..');
const repoRoot = join(clientRoot, '..', '..');

// npm workspaces usually hoists to the repo root, but not always - check both.
const candidates = [
  join(clientRoot, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'),
  join(repoRoot, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'),
];

const destination = join(clientRoot, 'public', 'mediapipe', 'wasm');

const source = candidates.find((p) => existsSync(p));

if (!source) {
  console.warn(
    '[graufence] MediaPipe WASM not found in node_modules.\n' +
      '            Run `npm install` first. The app will fall back to the CDN,\n' +
      '            which works but needs network access at runtime.',
  );
  process.exit(0);
}

// Skip the copy when it is already up to date, so `npm run dev` stays instant.
if (existsSync(destination)) {
  const [srcFiles, dstFiles] = await Promise.all([readdir(source), readdir(destination)]);
  if (srcFiles.length === dstFiles.length) {
    const srcStat = await stat(join(source, srcFiles[0]));
    const dstStat = await stat(join(destination, srcFiles[0]));
    if (dstStat.mtimeMs >= srcStat.mtimeMs) process.exit(0);
  }
}

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
console.log(`[graufence] MediaPipe WASM ready at public/mediapipe/wasm`);
