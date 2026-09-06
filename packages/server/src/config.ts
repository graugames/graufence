/**
 * Server configuration, read once at startup.
 *
 * Everything has a working default so `npm run dev` needs no .env at all;
 * see .env.example at the repo root for what each value does in production.
 */

/**
 * Loads a .env file if one is sitting next to the process.
 *
 * Uses Node's own loader rather than a dependency. It is absent before Node
 * 20.12 and throws when the file does not exist, so both cases are swallowed:
 * a missing .env is the normal case in production, where the host injects real
 * environment variables directly.
 */
export function loadDotEnv(): void {
  const loader = (process as NodeJS.Process & { loadEnvFile?: (p?: string) => void })
    .loadEnvFile;
  if (typeof loader !== 'function') return;
  for (const path of ['.env', '../../.env']) {
    try {
      loader.call(process, path);
      return;
    } catch {
      // No file there - try the next candidate, then give up quietly.
    }
  }
}

const num = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export interface ServerConfig {
  port: number;
  host: string;
  /** Origins allowed to open a socket; ['*'] disables the check. */
  allowedOrigins: string[];
  maxMessagesPerSecond: number;
  reconnectGraceSeconds: number;
  /** Largest inbound frame accepted, in bytes. */
  maxFrameBytes: number;
  /** Hard cap on concurrent rooms, so one script cannot exhaust memory. */
  maxRooms: number;
  /** Hard cap on concurrent sockets. */
  maxConnections: number;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const origins = (env['ALLOWED_ORIGINS'] ?? '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    port: num(env['PORT'], 8787),
    host: env['HOST'] ?? '0.0.0.0',
    allowedOrigins: origins.length > 0 ? origins : ['*'],
    maxMessagesPerSecond: num(env['MAX_MESSAGES_PER_SECOND'], 60),
    reconnectGraceSeconds: num(env['RECONNECT_GRACE_SECONDS'], 30),
    maxFrameBytes: num(env['MAX_FRAME_BYTES'], 4096),
    maxRooms: num(env['MAX_ROOMS'], 500),
    maxConnections: num(env['MAX_CONNECTIONS'], 2000),
  };
}

/**
 * Whether a browser at `origin` may open a socket.
 *
 * A missing Origin header is allowed: non-browser clients (health checks, the
 * test suite, `wscat`) do not send one, and the header is not a security
 * boundary anyway - it only stops a random web page from quietly using this
 * server as free infrastructure.
 */
export function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (allowed.includes('*')) return true;
  if (!origin) return true;
  return allowed.includes(origin);
}
