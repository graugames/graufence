/**
 * Downloads the MediaPipe pose model into public/models so the game can run
 * fully self-hosted, with no runtime dependency on Google's CDN.
 *
 * Optional: by default the client loads the model straight from the CDN, which
 * needs no setup. Run `npm run fetch:model --workspace @graufence/client` if
 * you would rather serve it yourself (offline demos, locked-down networks, or
 * simply not wanting a third-party request on every page load), then set
 * VITE_POSE_MODEL_URL=/models/pose_landmarker_lite.task
 *
 * The file is ~5 MB, which is why it is fetched rather than committed.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'models');
const outFile = join(outDir, 'pose_landmarker_lite.task');

console.log(`[graufence] downloading pose model...`);

const res = await fetch(MODEL_URL);
if (!res.ok) {
  console.error(`[graufence] download failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}

const bytes = new Uint8Array(await res.arrayBuffer());
await mkdir(outDir, { recursive: true });
await writeFile(outFile, bytes);

console.log(
  `[graufence] saved ${(bytes.byteLength / 1e6).toFixed(1)} MB to public/models/\n` +
    `            now set VITE_POSE_MODEL_URL=/models/pose_landmarker_lite.task`,
);
