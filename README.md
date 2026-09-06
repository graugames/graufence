# Grau Battle

Grau Battle is a playable 1v1 online webcam boxing game. Players throw punches,
block with either glove, and slip attacks with their hips. The browser mirrors
the tracked pose into a low-poly ring; the server receives compact pose
summaries and action intents, never webcam frames or video.

## Stack

- React + TypeScript + Vite client
- Node.js + TypeScript + `ws` WebSocket server
- Shared TypeScript protocol and deterministic match engine
- MediaPipe Pose Landmarker in the browser
- Optional OpenCV.js browser preprocessing for the camera preview
- Vitest unit tests

## Quick start

Requirements: Node.js 20 or newer and npm.

```bash
npm install
npm run dev
```

Open <http://localhost:5174>. The development server starts:

- Vite client: `http://localhost:5174`
- WebSocket and health server: `ws://localhost:8787/ws`
- Health check: <http://localhost:8787/health>

The first browser window can create a room. A second browser window can join
with the four-character room code, or with the invite link shown in the lobby.
Both players must press **Ready** before the countdown begins.

For a camera-free development session, open:

```text
http://localhost:5174/?keys=1
```

This uses the same pose, glove, action, network, and server-authoritative
combat paths as camera play, but supplies deterministic keyboard input.

## Controls

| Input | Action |
| --- | --- |
| Mouse | Move the lead glove |
| Space | Straight punch |
| J / K | Hook left / right |
| L / right click | Block with the raised glove |
| Q / E | Slip left / right |
| A / D | Turn your guard left / right |
| W / S | Raise or lower the gloves |
| Hold still | Keep a glove on the punch line |
| Shift + K | Toggle camera/keyboard mode during development |
| Backtick | Toggle the debug panel |

Attacks and dodges consume stamina. Matches are best of three rounds, with
head, torso, left-side, and right-side hit zones. The local sparring button
uses a deterministic bot, so combat can be tested without a second client.

## Camera and tracking

Camera access requires HTTPS or `localhost`. The calibration screen captures a
neutral stance and both gloves, then normalizes movement by the player's own
shoulder width. It applies smoothing, confidence gating, gesture
cooldowns, and a keyboard fallback when a camera is unavailable.

MediaPipe's WASM runtime is copied from the installed package during `dev` and
`build`. The small Pose Landmarker model is loaded from Google's CDN by
default. To self-host that model instead:

```bash
npm run fetch:model --workspace @graufence/client
```

Then set `VITE_POSE_MODEL_URL=/models/pose_landmarker_lite.task` in the client
environment. The downloaded model is intentionally not committed.

If tracking is unreliable, face the camera with both shoulders, both arms,
and hips visible; step back if the hips are cropped; or use `?keys=1`.

## Configuration

Copy `.env.example` to `.env` for local overrides. Important server values:

- `PORT` — HTTP/WebSocket port, default `8787`
- `HOST` — bind address, default `0.0.0.0`
- `ALLOWED_ORIGINS` — comma-separated browser origins, or `*` for local work
- `MAX_MESSAGES_PER_SECOND` — per-connection message limit
- `RECONNECT_GRACE_SECONDS` — time to hold a dropped player's seat
- `MAX_ROOMS` and `MAX_CONNECTIONS` — process capacity limits

The client reads `VITE_SERVER_URL`. In production it must be a `wss://` URL,
for example `wss://your-server.example.com/ws`.

## Tests and production builds

```bash
npm test
npm run typecheck
npm run build
```

The test suite uses mock poses and keyboard input; it does not need a camera or
an internet connection. The build produces the client in
`packages/client/dist`, and compiled server/shared output in each package's
`dist` directory.

## Deployment

Deploy the frontend and WebSocket server separately:

1. Build the client with `VITE_SERVER_URL` set to the deployed `wss://` server.
2. Host `packages/client/dist` on a static HTTPS host such as Netlify,
   Cloudflare Pages, Vercel, or GitHub Pages.
3. Run the server with `npm run build:shared && npm run build:server`, then
   `npm run start` on Render, Railway, Fly.io, or another Node-capable host.
4. Set `ALLOWED_ORIGINS` on the server to the exact frontend origin.
5. Configure the host's health check to use `/health`.

GitHub Pages can host the static frontend, but it cannot host the Node WebSocket
server. The frontend therefore needs `VITE_SERVER_URL` pointing at a separate
WebSocket-capable service. Use `wss://` whenever the frontend is served over
HTTPS; browsers block mixed-content `ws://` connections.

## Architecture and security

`packages/shared` contains the versioned wire protocol, normalized pose types,
gesture classification, stamina/cooldown rules, hit resolution, and match
state machine. `packages/client` owns camera access, local prediction,
rendering, and UI. `packages/server` owns rooms, reconnect grace periods,
message validation, rate limiting, authoritative timing, health, stamina, and
damage.

Clients send only compact pose summaries and action intent. The server never
trusts client health, damage, timestamps, or hit results. Malformed frames are
size-limited and rejected without crashing the process. Real secrets belong in
environment variables; `.env` files are ignored by Git.
