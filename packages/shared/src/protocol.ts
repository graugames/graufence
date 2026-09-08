/**
 * The wire protocol.
 *
 * Two rules shape everything here:
 *
 *  1. **No video, ever.** Camera frames never leave the browser. What crosses
 *     the wire is a compact skeleton pose per update and a handful of bytes per
 *     action - a couple of kB/s, not a video stream.
 *
 *  2. **The server believes nothing.** Clients send *intent* ("I thrust at the
 *     head"); they never send health, damage or outcomes. Every inbound message
 *     is re-validated here before the match engine sees it, because the only
 *     thing on the other end of a WebSocket is a stranger's JavaScript.
 *
 * Messages carry `v` so a stale tab cannot half-speak an older dialect: the
 * server rejects a mismatched version at the handshake instead of guessing.
 */

import type { HitZone, SlashDirection, DodgeDirection } from './actions.js';
import { HIT_ZONES } from './actions.js';
import type { HitResult } from './combat.js';
import type { MatchPhase, MatchEvent, PoseSnapshot, Slot } from './match.js';
import { PROTOCOL_VERSION } from './constants.js';
import type { CharacterCustomization } from './character.js';

// PROTOCOL_VERSION itself is re-exported from ./constants.js by the barrel;
// it is imported here only to stamp and check outgoing/incoming handshakes.

// ---------------------------------------------------------------- client -> server

export interface CreateRoomMessage {
  type: 'create_room';
  v: number;
  name: string;
}

export interface JoinRoomMessage {
  type: 'join_room';
  v: number;
  code: string;
  name: string;
}

/** Re-attach to a slot being held open after a dropped connection. */
export interface RejoinMessage {
  type: 'rejoin';
  v: number;
  code: string;
  token: string;
}

export interface ReadyMessage {
  type: 'ready';
  ready: boolean;
}

export interface CustomizeMessage {
  type: 'customize';
  customization: CharacterCustomization;
}

/**
 * The high-rate channel: pose plus current guard, ~30/s.
 * Purely cosmetic on the receiving client except for `guard`, which the server
 * records as the defender's posture for the next attack that lands.
 */
export interface PoseMessage {
  type: 'pose';
  pose: PoseSnapshot;
  guard: HitZone | null;
}

export interface ActionMessage {
  type: 'action';
  kind: 'thrust' | 'slash' | 'parry' | 'dodge';
  zone?: HitZone;
  slash?: SlashDirection;
  dodge?: DodgeDirection;
  /** Client sequence number, echoed back so the client can reconcile. */
  seq: number;
}

export interface RematchMessage {
  type: 'rematch';
}

export interface LeaveMessage {
  type: 'leave';
}

export interface PingMessage {
  type: 'ping';
  /** Client timestamp, echoed verbatim in the pong. */
  t: number;
}

export type ClientMessage =
  | CreateRoomMessage
  | JoinRoomMessage
  | RejoinMessage
  | ReadyMessage
  | CustomizeMessage
  | PoseMessage
  | ActionMessage
  | RematchMessage
  | LeaveMessage
  | PingMessage;

export type ClientMessageType = ClientMessage['type'];

// ---------------------------------------------------------------- server -> client

export interface LobbyPlayer {
  slot: Slot;
  name: string;
  customization: CharacterCustomization;
  ready: boolean;
  connected: boolean;
  rematchWanted: boolean;
}

export interface JoinedMessage {
  type: 'joined';
  v: number;
  code: string;
  slot: Slot;
  /** Secret for this seat. Lets the same player reclaim it after a drop. */
  token: string;
  players: LobbyPlayer[];
}

export interface LobbyMessage {
  type: 'lobby';
  code: string;
  players: LobbyPlayer[];
  phase: MatchPhase;
}

/** One player's authoritative state, trimmed to what a client can render. */
export interface PlayerSnapshot {
  slot: Slot;
  name: string;
  customization: CharacterCustomization;
  connected: boolean;
  health: number;
  stamina: number;
  roundsWon: number;
  guard: HitZone | null;
  staggered: boolean;
  pose: PoseSnapshot | null;
}

/** An attack in the air, so the defender has something to react to. */
export interface IncomingAttack {
  id: number;
  attacker: Slot;
  kind: 'thrust' | 'slash';
  zone: HitZone;
  landsAt: number;
}

export interface StateMessage {
  type: 'state';
  seq: number;
  /** Server clock in ms, so clients can convert `landsAt` to local time. */
  now: number;
  phase: MatchPhase;
  round: number;
  phaseEndsAt: number;
  players: [PlayerSnapshot, PlayerSnapshot];
  incoming: IncomingAttack[];
}

/** Discrete things that happened, for effects and the combat log. */
export interface EventsMessage {
  type: 'events';
  events: MatchEvent[];
}

export interface RoundResultMessage {
  type: 'round_result';
  round: number;
  winner: Slot | null;
  reason: 'health' | 'timeout' | 'forfeit';
  scores: [number, number];
}

export interface MatchOverMessage {
  type: 'match_over';
  winner: Slot | null;
  scores: [number, number];
}

export interface OpponentStatusMessage {
  type: 'opponent_status';
  slot: Slot;
  status: 'left' | 'disconnected' | 'reconnected';
  /** Seconds left to reconnect, when status is 'disconnected'. */
  graceSeconds?: number;
}

export interface PongMessage {
  type: 'pong';
  /** The client timestamp from the ping. */
  t: number;
  /** Server clock, for offset estimation. */
  now: number;
}

export type ErrorCode =
  | 'bad_message'
  | 'bad_version'
  | 'room_not_found'
  | 'room_full'
  | 'not_in_room'
  | 'rate_limited'
  | 'invalid_token'
  | 'server_error';

export interface ErrorMessage {
  type: 'error';
  code: ErrorCode;
  message: string;
  /** True when the connection is being closed as a result. */
  fatal?: boolean;
}

export type ServerMessage =
  | JoinedMessage
  | LobbyMessage
  | StateMessage
  | EventsMessage
  | RoundResultMessage
  | MatchOverMessage
  | OpponentStatusMessage
  | PongMessage
  | ErrorMessage;

export type ServerMessageType = ServerMessage['type'];


// ---------------------------------------------------------------- validation

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

const numberInRange = (v: unknown, lo: number, hi: number): v is number =>
  isFiniteNumber(v) && v >= lo && v <= hi;

const isZone = (v: unknown): v is HitZone =>
  typeof v === 'string' && (HIT_ZONES as readonly string[]).includes(v);

const OPTIONAL_POSE_PAIRS = [
  ['ex', 'ey'],
  ['owx', 'owy'],
  ['oex', 'oey'],
  ['hx', 'hy'],
  ['sx', 'sy'],
  ['px', 'py'],
  ['lkx', 'lky'],
  ['rkx', 'rky'],
  ['lax', 'lay'],
  ['rax', 'ray'],
] as const;

/**
 * Control characters (which can corrupt a terminal log) and the handful of
 * characters that read as markup. React escapes on render anyway; stripping
 * here keeps the value stored on the server clean too.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_AND_MARKUP = /[\u0000-\u001f\u007f<>&"'`\\]/g;

/** Names are shown to another human, so they are clamped and stripped here. */
export function sanitizeName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  // Strip control characters and anything that could be mistaken for markup.
  const cleaned = s
    .replace(CONTROL_AND_MARKUP, '')
    .trim()
    .slice(0, 16);
  return cleaned.length > 0 ? cleaned : 'Boxer';
}

export function sanitizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length >= 4 && code.length <= 8 ? code : null;
}

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; code: ErrorCode; reason: string };

const fail = (code: ErrorCode, reason: string): ParseResult => ({ ok: false, code, reason });

/**
 * Parses and validates one inbound frame.
 *
 * Never throws: malformed JSON, wrong types, hostile payloads and messages from
 * a future protocol version all come back as a typed failure. A server that
 * crashes on a bad frame is a server one bad frame away from being offline, so
 * this is the only place inbound data is allowed to be shapeless.
 *
 * @param raw the raw frame (string or Buffer-like).
 * @param maxBytes reject anything larger; a pose update is a few hundred bytes.
 */
export function parseClientMessage(raw: unknown, maxBytes = 4096): ParseResult {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (raw instanceof Uint8Array) text = new TextDecoder().decode(raw);
  else if (raw !== null && typeof raw === 'object' && 'toString' in raw) {
    text = String(raw);
  } else {
    return fail('bad_message', 'unsupported frame type');
  }

  if (text.length > maxBytes) return fail('bad_message', 'frame too large');

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return fail('bad_message', 'invalid JSON');
  }
  if (!isObject(data)) return fail('bad_message', 'not an object');

  const type = data['type'];
  if (typeof type !== 'string') return fail('bad_message', 'missing type');

  switch (type) {
    case 'create_room': {
      if (data['v'] !== PROTOCOL_VERSION) {
        return fail('bad_version', `expected protocol v${PROTOCOL_VERSION}`);
      }
      return {
        ok: true,
        message: { type: 'create_room', v: PROTOCOL_VERSION, name: sanitizeName(data['name']) },
      };
    }

    case 'join_room': {
      if (data['v'] !== PROTOCOL_VERSION) {
        return fail('bad_version', `expected protocol v${PROTOCOL_VERSION}`);
      }
      const code = sanitizeRoomCode(data['code']);
      if (!code) return fail('bad_message', 'invalid room code');
      return {
        ok: true,
        message: { type: 'join_room', v: PROTOCOL_VERSION, code, name: sanitizeName(data['name']) },
      };
    }

    case 'rejoin': {
      if (data['v'] !== PROTOCOL_VERSION) {
        return fail('bad_version', `expected protocol v${PROTOCOL_VERSION}`);
      }
      const code = sanitizeRoomCode(data['code']);
      const token = data['token'];
      if (!code) return fail('bad_message', 'invalid room code');
      if (typeof token !== 'string' || token.length < 8 || token.length > 64) {
        return fail('bad_message', 'invalid token');
      }
      return { ok: true, message: { type: 'rejoin', v: PROTOCOL_VERSION, code, token } };
    }

    case 'ready': {
      if (typeof data['ready'] !== 'boolean') return fail('bad_message', 'ready must be boolean');
      return { ok: true, message: { type: 'ready', ready: data['ready'] } };
    }

    case 'customize': {
      const raw = data['customization'];
      if (!isObject(raw)) return fail('bad_message', 'customization must be an object');
      const fields = ['skinTone', 'height', 'build', 'hair', 'gloves'] as const;
      for (const field of fields) {
        if (!numberInRange(raw[field], 0, 1)) {
          return fail('bad_message', `customization ${field} must be between 0 and 1`);
        }
      }
      return {
        ok: true,
        message: {
          type: 'customize',
          customization: {
            skinTone: raw.skinTone as number,
            height: raw.height as number,
            build: raw.build as number,
            hair: raw.hair as number,
            gloves: raw.gloves as number,
          },
        },
      };
    }

    case 'pose': {
      const p = data['pose'];
      if (!isObject(p)) return fail('bad_message', 'pose must be an object');
      // Every field is range-checked. Unbounded numbers would let a hostile
      // client push NaN or 1e308 into the opponent's renderer.
      if (
        !numberInRange(p['a'], -360, 360) ||
        !numberInRange(p['h'], -8, 8) ||
        !numberInRange(p['wx'], -8, 8) ||
        !numberInRange(p['wy'], -8, 8) ||
        !numberInRange(p['c'], 0, 1)
      ) {
        return fail('bad_message', 'pose values out of range');
      }
      const optionalPose: Partial<PoseSnapshot> = {};
      for (const [xKey, yKey] of OPTIONAL_POSE_PAIRS) {
        const hasX = p[xKey] !== undefined;
        const hasY = p[yKey] !== undefined;
        if (hasX !== hasY) return fail('bad_message', `pose ${xKey}/${yKey} must be paired`);
        if (hasX && (!numberInRange(p[xKey], -8, 8) || !numberInRange(p[yKey], -8, 8))) {
          return fail('bad_message', `pose ${xKey}/${yKey} out of range`);
        }
        if (hasX) {
          const poseFields = optionalPose as Record<string, number>;
          poseFields[xKey] = p[xKey] as number;
          poseFields[yKey] = p[yKey] as number;
        }
      }
      const guardRaw = data['guard'];
      const guard = guardRaw === null || guardRaw === undefined ? null : guardRaw;
      if (guard !== null && !isZone(guard)) return fail('bad_message', 'invalid guard zone');
      return {
        ok: true,
        message: {
          type: 'pose',
          pose: {
            a: p['a'] as number,
            h: p['h'] as number,
            wx: p['wx'] as number,
            wy: p['wy'] as number,
            ...optionalPose,
            c: p['c'] as number,
          },
          guard,
        },
      };
    }

    case 'action': {
      const kind = data['kind'];
      if (kind !== 'thrust' && kind !== 'slash' && kind !== 'parry' && kind !== 'dodge') {
        return fail('bad_message', 'unknown action kind');
      }
      const seq = data['seq'];
      if (!numberInRange(seq, 0, Number.MAX_SAFE_INTEGER)) {
        return fail('bad_message', 'invalid seq');
      }
      const msg: ActionMessage = { type: 'action', kind, seq };

      if (kind === 'thrust' || kind === 'slash') {
        const zone = data['zone'];
        if (!isZone(zone)) return fail('bad_message', 'attack needs a valid zone');
        msg.zone = zone;
      }
      if (kind === 'slash') {
        const slash = data['slash'];
        if (slash !== 'lr' && slash !== 'rl') return fail('bad_message', 'invalid slash direction');
        msg.slash = slash;
      }
      if (kind === 'dodge') {
        const dodge = data['dodge'];
        if (dodge !== 'left' && dodge !== 'right') return fail('bad_message', 'invalid dodge direction');
        msg.dodge = dodge;
      }
      return { ok: true, message: msg };
    }

    case 'rematch':
      return { ok: true, message: { type: 'rematch' } };

    case 'leave':
      return { ok: true, message: { type: 'leave' } };

    case 'ping': {
      if (!isFiniteNumber(data['t'])) return fail('bad_message', 'ping needs t');
      return { ok: true, message: { type: 'ping', t: data['t'] } };
    }

    default:
      return fail('bad_message', `unknown message type: ${type.slice(0, 32)}`);
  }
}

/** Rounds pose numbers before sending; 2 dp is well past what a body can show. */
export function compactPose(p: PoseSnapshot): PoseSnapshot {
  const r = (n: number, dp = 2): number => {
    const f = 10 ** dp;
    return Math.round(n * f) / f;
  };
  return {
    a: r(p.a, 1),
    h: r(p.h),
    wx: r(p.wx),
    wy: r(p.wy),
    ...(p.ex !== undefined && p.ey !== undefined ? { ex: r(p.ex), ey: r(p.ey) } : {}),
    ...(p.owx !== undefined && p.owy !== undefined ? { owx: r(p.owx), owy: r(p.owy) } : {}),
    ...(p.oex !== undefined && p.oey !== undefined ? { oex: r(p.oex), oey: r(p.oey) } : {}),
    ...(p.hx !== undefined && p.hy !== undefined ? { hx: r(p.hx), hy: r(p.hy) } : {}),
    ...(p.sx !== undefined && p.sy !== undefined ? { sx: r(p.sx), sy: r(p.sy) } : {}),
    ...(p.px !== undefined && p.py !== undefined ? { px: r(p.px), py: r(p.py) } : {}),
    ...(p.lkx !== undefined && p.lky !== undefined ? { lkx: r(p.lkx), lky: r(p.lky) } : {}),
    ...(p.rkx !== undefined && p.rky !== undefined ? { rkx: r(p.rkx), rky: r(p.rky) } : {}),
    ...(p.lax !== undefined && p.lay !== undefined ? { lax: r(p.lax), lay: r(p.lay) } : {}),
    ...(p.rax !== undefined && p.ray !== undefined ? { rax: r(p.rax), ray: r(p.ray) } : {}),
    c: r(p.c),
  };
}
