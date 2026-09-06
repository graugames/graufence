/**
 * WebSocket client.
 *
 * Responsibilities, in order of how much they matter:
 *
 *  1. Never lose a match to a blip. A dropped socket reconnects with backoff
 *     and replays the seat token, so a five-second Wi-Fi stumble costs a few
 *     seconds of play rather than the round.
 *  2. Measure latency honestly. A ping/pong round trip gives both the number
 *     shown in the HUD and the clock offset used to convert the server's
 *     `landsAt` timestamps into local time - without which a telegraphed
 *     attack would render at the wrong moment on a laggy connection.
 *  3. Stay cheap. Pose goes out at 20 Hz and is rounded to two decimals; the
 *     whole outbound stream is a couple of kB/s.
 */

import type {
  ClientMessage,
  HitZone,
  PoseSnapshot,
  ServerMessage,
} from '@graufence/shared';
import { compactPose, NET, PROTOCOL_VERSION } from '@graufence/shared';

export type ConnectionListener = (message: ServerMessage) => void;
export type StatusListener = (
  status: 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'offline',
  detail?: string,
) => void;

/**
 * Where the server lives.
 *
 * In development the client is on :5174 and the server on :8787, so guessing
 * the same host with the server's port is right nearly always. In production
 * the two are on different hosts entirely and VITE_SERVER_URL must be set -
 * a static host such as GitHub Pages cannot serve WebSockets at all.
 */
export function defaultServerUrl(): string {
  const configured = import.meta.env['VITE_SERVER_URL'];
  if (typeof configured === 'string' && configured.length > 0) return configured;
  if (typeof window === 'undefined') return 'ws://localhost:8787/ws';
  const secure = window.location.protocol === 'https:';
  const proto = secure ? 'wss' : 'ws';
  return `${proto}://${window.location.hostname}:8787/ws`;
}

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

export class Connection {
  private socket: WebSocket | null = null;
  private listeners = new Set<ConnectionListener>();
  private statusListeners = new Set<StatusListener>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private poseTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  /** Set once we mean to be connected; cleared by an explicit disconnect. */
  private wanted = false;

  /** Seat credentials, kept so a reconnect can reclaim the same slot. */
  private roomCode: string | null = null;
  private token: string | null = null;
  /** Queued while the socket is down, so a click is never silently lost. */
  private pending: ClientMessage[] = [];

  /** Latest pose, sampled by the send timer rather than sent per frame. */
  private latestPose: { pose: PoseSnapshot; guard: HitZone | null } | null = null;
  private lastPoseSentAt = 0;

  private actionSeq = 0;

  /** Smoothed round-trip time in milliseconds. */
  pingMs = 0;
  /** serverNow - clientNow, for converting server timestamps to local time. */
  clockOffsetMs = 0;

  constructor(private url: string = defaultServerUrl()) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  onMessage(fn: ConnectionListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private emitStatus(
    status: 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'offline',
    detail?: string,
  ): void {
    for (const fn of this.statusListeners) fn(status, detail);
  }

  connect(): void {
    this.wanted = true;
    this.open();
  }

  private open(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    this.emitStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (err) {
      // A malformed URL throws synchronously; treat it like a failed connect
      // so the retry path and the error message are the same in both cases.
      this.emitStatus('failed', String(err));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0;
      this.emitStatus('connected');
      // Reclaim the seat before anything else, so the server can put us back
      // in the match we were already in.
      if (this.roomCode && this.token) {
        this.sendNow({
          type: 'rejoin',
          v: PROTOCOL_VERSION,
          code: this.roomCode,
          token: this.token,
        });
      }
      for (const msg of this.pending.splice(0)) this.sendNow(msg);
      this.startTimers();
    });

    socket.addEventListener('message', (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        // The server should never send us garbage, but a proxy might.
        return;
      }
      if (msg.type === 'pong') {
        const rtt = Date.now() - msg.t;
        // Exponential smoothing: a single slow packet should nudge the number,
        // not spike it, or the HUD becomes a strobe light.
        this.pingMs = this.pingMs === 0 ? rtt : this.pingMs * 0.8 + rtt * 0.2;
        // Assume symmetric latency: the server's clock at send time was
        // roughly `now - rtt/2` on ours.
        this.clockOffsetMs = msg.now - (Date.now() - rtt / 2);
        return;
      }
      if (msg.type === 'joined') {
        this.roomCode = msg.code;
        this.token = msg.token;
      }
      for (const fn of this.listeners) fn(msg);
    });

    socket.addEventListener('close', () => {
      this.stopTimers();
      this.socket = null;
      if (this.wanted) this.scheduleReconnect();
      else this.emitStatus('offline');
    });

    socket.addEventListener('error', () => {
      // 'error' is always followed by 'close'; the reconnect happens there.
    });
  }

  private scheduleReconnect(): void {
    if (!this.wanted || this.reconnectTimer) return;
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)]!;
    this.attempt++;
    if (this.attempt > 8) {
      this.emitStatus('failed', 'Could not reach the match server.');
      this.wanted = false;
      return;
    }
    this.emitStatus('reconnecting', `retrying in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private startTimers(): void {
    this.stopTimers();
    this.pingTimer = setInterval(() => {
      this.sendNow({ type: 'ping', t: Date.now() });
    }, 2000);
    this.sendNow({ type: 'ping', t: Date.now() });

    // Pose is sampled on a timer rather than pushed per frame: the camera runs
    // at ~25 fps and the renderer at 60, but the opponent only needs 20.
    this.poseTimer = setInterval(() => {
      const latest = this.latestPose;
      if (!latest) return;
      this.latestPose = null;
      this.lastPoseSentAt = Date.now();
      this.sendNow({ type: 'pose', pose: compactPose(latest.pose), guard: latest.guard });
    }, Math.round(1000 / NET.poseHz));
  }

  private stopTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.poseTimer) clearInterval(this.poseTimer);
    this.pingTimer = null;
    this.poseTimer = null;
  }

  private sendNow(msg: ClientMessage): void {
    if (!this.connected) return;
    try {
      this.socket!.send(JSON.stringify(msg));
    } catch {
      // The socket died between the readyState check and the send. The close
      // handler will reconnect; dropping this one frame is fine.
    }
  }

  /**
   * Sends a message, queueing it if the socket is briefly down.
   *
   * Pose updates are never queued - a stale body position is worse than none -
   * but a room join or an attack is queued, because losing one to a blip would
   * be visible as an input that just did not happen.
   */
  send(msg: ClientMessage): void {
    if (this.connected) {
      this.sendNow(msg);
      return;
    }
    if (msg.type === 'pose' || msg.type === 'ping') return;
    if (this.pending.length < 32) this.pending.push(msg);
  }

  createRoom(name: string): void {
    this.roomCode = null;
    this.token = null;
    this.send({ type: 'create_room', v: PROTOCOL_VERSION, name });
  }

  joinRoom(code: string, name: string): void {
    this.roomCode = null;
    this.token = null;
    this.send({ type: 'join_room', v: PROTOCOL_VERSION, code, name });
  }

  setReady(ready: boolean): void {
    this.send({ type: 'ready', ready });
  }

  requestRematch(): void {
    this.send({ type: 'rematch' });
  }

  /** Latest pose; actually transmitted by the 20 Hz timer. */
  pushPose(pose: PoseSnapshot, guard: HitZone | null): void {
    this.latestPose = { pose, guard };
  }

  /** @returns the sequence number stamped on the action. */
  sendAction(
    kind: 'thrust' | 'slash' | 'parry' | 'dodge',
    extra: { zone?: HitZone; slash?: 'lr' | 'rl'; dodge?: 'left' | 'right' } = {},
  ): number {
    const seq = ++this.actionSeq;
    this.send({ type: 'action', kind, seq, ...extra });
    return seq;
  }

  leaveRoom(): void {
    this.send({ type: 'leave' });
    this.roomCode = null;
    this.token = null;
  }

  /** Milliseconds since the last pose actually went out; a staleness check. */
  poseAgeMs(): number {
    return Date.now() - this.lastPoseSentAt;
  }

  /** Converts a server timestamp into this machine's clock. */
  toLocalTime(serverMs: number): number {
    return serverMs - this.clockOffsetMs;
  }

  disconnect(): void {
    this.wanted = false;
    this.stopTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.pending.length = 0;
    this.socket?.close(1000, 'client left');
    this.socket = null;
    this.emitStatus('offline');
  }
}
