/**
 * Room state - who is sitting in which seat, and what the match between them
 * is doing.
 *
 * There is not a single socket reference in this file. The server owns the
 * transport and maps sockets onto seats; everything that can go *wrong* about
 * a room (a full room, a duplicate join, a disconnect during the grace window,
 * a player who never comes back, an empty room that must be reaped) is decided
 * here, where it can be tested by calling methods in a loop.
 */

import { MatchEngine } from './match.js';
import type { MatchEvent, PoseSnapshot, Slot } from './match.js';
import type { HitZone } from './actions.js';
import type { LobbyPlayer, PlayerSnapshot, StateMessage } from './protocol.js';
import { NET } from './constants.js';

export interface Seat {
  slot: Slot;
  /** Stable id for this player within the room. */
  id: string;
  name: string;
  /** Secret that lets the same person reclaim the seat after a drop. */
  token: string;
  connected: boolean;
  /** When the socket dropped, or null while connected. */
  disconnectedAt: number | null;
}

export type JoinResult =
  | { ok: true; seat: Seat }
  | { ok: false; reason: 'room_full' };

export type RejoinResult =
  | { ok: true; seat: Seat }
  | { ok: false; reason: 'invalid_token' | 'expired' };

/**
 * Picks an unused room code.
 *
 * The alphabet has no O/0 or I/1 because these codes get read out loud. With a
 * 32-character alphabet and length 4 there are ~1M codes; `taken` keeps the
 * collision impossible rather than merely unlikely, and the attempt cap stops
 * a nearly-full space from spinning forever.
 */
export function generateRoomCode(
  taken: ReadonlySet<string>,
  rng: () => number = Math.random,
): string {
  const { roomCodeAlphabet: alpha, roomCodeLength: len } = NET;
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    for (let i = 0; i < len; i++) {
      code += alpha[Math.floor(rng() * alpha.length) % alpha.length];
    }
    if (!taken.has(code)) return code;
  }
  // Space is crowded: fall back to a longer code rather than failing a player.
  let code = '';
  for (let i = 0; i < len + 2; i++) {
    code += alpha[Math.floor(rng() * alpha.length) % alpha.length];
  }
  return code;
}

let tokenCounter = 0;
/** Opaque seat token. Not a security boundary beyond "hard to guess by hand". */
export function generateToken(rng: () => number = Math.random): string {
  const rand = () => Math.floor(rng() * 0xffffffff).toString(36);
  return `${rand()}${rand()}${(tokenCounter++).toString(36)}`.padEnd(16, '0').slice(0, 24);
}

export interface RoomOptions {
  /** Seconds a dropped player's seat is held before the room gives up on them. */
  reconnectGraceSeconds?: number;
  rng?: () => number;
}

export class Room {
  readonly code: string;
  readonly createdAt: number;
  seats: [Seat | null, Seat | null] = [null, null];
  engine: MatchEngine | null = null;
  lastActivityAt: number;
  private graceMs: number;
  private rng: () => number;

  constructor(code: string, now: number, opts: RoomOptions = {}) {
    this.code = code;
    this.createdAt = now;
    this.lastActivityAt = now;
    this.graceMs = (opts.reconnectGraceSeconds ?? 30) * 1000;
    this.rng = opts.rng ?? Math.random;
  }

  touch(now: number): void {
    this.lastActivityAt = now;
  }

  get playerCount(): number {
    return this.seats.filter((s) => s !== null).length;
  }

  get isFull(): boolean {
    return this.playerCount >= 2;
  }

  seatFor(token: string): Seat | null {
    return this.seats.find((s) => s?.token === token) ?? null;
  }

  join(name: string, now: number): JoinResult {
    const slot = this.seats.findIndex((s) => s === null);
    if (slot === -1) return { ok: false, reason: 'room_full' };
    const seat: Seat = {
      slot: slot as Slot,
      id: `p${slot}-${generateToken(this.rng).slice(0, 6)}`,
      name,
      token: generateToken(this.rng),
      connected: true,
      disconnectedAt: null,
    };
    this.seats[slot as Slot] = seat;
    this.touch(now);

    // The engine only exists once there are two people to simulate. Creating
    // it here (rather than at room creation) keeps "waiting for an opponent"
    // a state of the room, not a half-initialized match.
    if (this.isFull) {
      const [a, b] = this.seats as [Seat, Seat];
      this.engine = new MatchEngine(
        { id: a.id, name: a.name },
        { id: b.id, name: b.name },
        now,
      );
    }
    return { ok: true, seat };
  }

  /** Socket dropped. The seat is kept warm for the grace window. */
  markDisconnected(slot: Slot, now: number): void {
    const seat = this.seats[slot];
    if (!seat) return;
    seat.connected = false;
    seat.disconnectedAt = now;
    this.engine?.setConnected(slot, false);
    this.touch(now);
  }

  rejoin(token: string, now: number): RejoinResult {
    const seat = this.seatFor(token);
    if (!seat) return { ok: false, reason: 'invalid_token' };
    if (seat.disconnectedAt !== null && now - seat.disconnectedAt > this.graceMs) {
      return { ok: false, reason: 'expired' };
    }
    seat.connected = true;
    seat.disconnectedAt = null;
    this.engine?.setConnected(seat.slot, true);
    this.touch(now);
    return { ok: true, seat };
  }

  /** Deliberate exit (leave button or expired grace). The seat is freed. */
  leave(slot: Slot, now: number): void {
    this.seats[slot] = null;
    this.engine?.setConnected(slot, false);
    this.touch(now);
  }

  /** Seats whose grace window has run out. The server forfeits these. */
  expiredSeats(now: number): Seat[] {
    return this.seats.filter(
      (s): s is Seat =>
        s !== null && s.disconnectedAt !== null && now - s.disconnectedAt > this.graceMs,
    );
  }

  /** Seconds a disconnected player still has to come back. */
  graceRemaining(slot: Slot, now: number): number {
    const seat = this.seats[slot];
    if (!seat || seat.disconnectedAt === null) return 0;
    return Math.max(0, (this.graceMs - (now - seat.disconnectedAt)) / 1000);
  }

  /**
   * True when the room should be destroyed: nobody is sitting in it, and it
   * has been quiet long enough that nobody is about to. The idle window stops
   * a room being reaped in the instant between "created" and "creator's join".
   */
  isDisposable(now: number, idleMs = 60_000): boolean {
    if (this.playerCount === 0) return now - this.lastActivityAt > 5_000;
    const allGone = this.seats.every((s) => s === null || !s.connected);
    return allGone && now - this.lastActivityAt > idleMs;
  }

  bothReady(): boolean {
    return this.isFull && (this.engine?.bothReady() ?? false);
  }

  setReady(slot: Slot, ready: boolean, now: number): void {
    this.engine?.setReady(slot, ready);
    this.touch(now);
  }

  setPose(slot: Slot, pose: PoseSnapshot, guard: HitZone | null): void {
    const e = this.engine;
    if (!e) return;
    e.setPose(slot, pose);
    e.setDefence(slot, guard, pose.a);
  }

  tick(now: number): MatchEvent[] {
    return this.engine?.tick(now) ?? [];
  }

  lobbyPlayers(): LobbyPlayer[] {
    const engine = this.engine;
    return this.seats
      .filter((s): s is Seat => s !== null)
      .map((s) => ({
        slot: s.slot,
        name: s.name,
        connected: s.connected,
        ready: engine?.state.players[s.slot].ready ?? false,
        rematchWanted: engine?.state.players[s.slot].rematchWanted ?? false,
      }));
  }

  /** The authoritative snapshot broadcast to both clients. */
  stateMessage(now: number): StateMessage | null {
    const e = this.engine;
    if (!e) return null;
    const s = e.state;
    const snap = (slot: Slot): PlayerSnapshot => {
      const p = s.players[slot];
      return {
        slot,
        name: p.name,
        connected: p.connected,
        health: Math.round(p.health),
        stamina: Math.round(p.stamina),
        roundsWon: p.roundsWon,
        guard: p.guardZone,
        staggered: now < p.staggeredUntil,
        pose: p.pose,
      };
    };
    return {
      type: 'state',
      seq: s.seq,
      now,
      phase: s.phase,
      round: s.round,
      phaseEndsAt: s.phaseEndsAt,
      players: [snap(0), snap(1)],
      incoming: s.pending.map((a) => ({
        id: a.id,
        attacker: a.attacker,
        kind: a.kind,
        zone: a.zone,
        landsAt: a.landsAt,
      })),
    };
  }
}
