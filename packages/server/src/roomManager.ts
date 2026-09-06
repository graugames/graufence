/**
 * The registry of live rooms, and the bridge between rooms and sockets.
 *
 * `Room` (in @graufence/shared) knows about seats and matches but nothing about
 * transport. This class owns the other half: which socket is sitting in which
 * seat, who to broadcast to, and the tick loop that drives every room forward.
 *
 * Keeping the split means the interesting failure modes - a player dropping
 * mid-round, a room emptying, a grace window expiring - are all testable
 * against `Room` alone, without standing up a WebSocket server.
 */

import { generateRoomCode, Room } from '@graufence/shared';
import type {
  MatchEvent,
  ServerMessage,
  Slot,
} from '@graufence/shared';
import { MATCH, NET } from '@graufence/shared';

/** Anything that can receive a server message. A WebSocket satisfies this. */
export interface Sink {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly open: boolean;
}

interface Occupant {
  sink: Sink;
  slot: Slot;
}

interface Entry {
  room: Room;
  /** Sockets currently attached, by slot. A seat can be held with no socket. */
  occupants: Map<Slot, Occupant>;
}

export interface RoomManagerOptions {
  reconnectGraceSeconds?: number;
  maxRooms?: number;
  now?: () => number;
  rng?: () => number;
  /** Called for anything worth seeing in the logs. */
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export class RoomManager {
  private rooms = new Map<string, Entry>();
  private now: () => number;
  private rng: () => number;
  private graceSeconds: number;
  private maxRooms: number;
  private log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Last broadcast `seq` per room, so an unchanged state is not re-sent. */
  private lastSentSeq = new Map<string, number>();

  constructor(opts: RoomManagerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.rng = opts.rng ?? Math.random;
    this.graceSeconds = opts.reconnectGraceSeconds ?? 30;
    this.maxRooms = opts.maxRooms ?? 500;
    this.log = opts.log ?? (() => {});
  }

  get size(): number {
    return this.rooms.size;
  }

  get(code: string): Room | null {
    return this.rooms.get(code)?.room ?? null;
  }

  /** @returns the new room, or null when the server is at capacity. */
  create(): Room | null {
    if (this.rooms.size >= this.maxRooms) return null;
    const code = generateRoomCode(new Set(this.rooms.keys()), this.rng);
    const room = new Room(code, this.now(), {
      reconnectGraceSeconds: this.graceSeconds,
      rng: this.rng,
    });
    this.rooms.set(code, { room, occupants: new Map() });
    this.log('room created', { code, rooms: this.rooms.size });
    return room;
  }

  attach(code: string, slot: Slot, sink: Sink): Sink | null {
    const entry = this.rooms.get(code);
    if (!entry) return null;
    const previous = entry.occupants.get(slot)?.sink ?? null;
    entry.occupants.set(slot, { sink, slot });
    return previous;
  }

  detach(code: string, slot: Slot): void {
    const entry = this.rooms.get(code);
    if (!entry) return;
    entry.occupants.delete(slot);
  }

  // ------------------------------------------------------------- broadcasting

  private sendEncoded(sink: Sink, data: string): void {
    if (!sink.open) return;
    try {
      sink.send(data);
    } catch (err) {
      // A socket that fails mid-write is already gone; the close handler will
      // clean up the seat. Never let it take the tick loop down with it.
      this.log('send failed', { error: String(err) });
    }
  }

  send(sink: Sink, message: ServerMessage): void {
    this.sendEncoded(sink, JSON.stringify(message));
  }

  broadcast(code: string, message: ServerMessage): void {
    const entry = this.rooms.get(code);
    if (!entry) return;
    // Encode once per broadcast, not once per player. State snapshots are the
    // hottest server message and every room has the same payload for both
    // occupants.
    const data = JSON.stringify(message);
    for (const occ of entry.occupants.values()) this.sendEncoded(occ.sink, data);
  }

  sendTo(code: string, slot: Slot, message: ServerMessage): void {
    const occ = this.rooms.get(code)?.occupants.get(slot);
    if (occ) this.send(occ.sink, message);
  }

  broadcastLobby(code: string): void {
    const entry = this.rooms.get(code);
    if (!entry) return;
    this.broadcast(code, {
      type: 'lobby',
      code,
      players: entry.room.lobbyPlayers(),
      phase: entry.room.engine?.state.phase ?? 'lobby',
    });
  }

  /** Pushes the authoritative snapshot, skipping rooms that have not changed. */
  broadcastState(code: string, force = false): void {
    this.broadcastStateAt(code, force, this.now());
  }

  /** Broadcasts one snapshot per room, regardless of how many sockets it has. */
  broadcastStates(): void {
    const now = this.now();
    for (const code of this.rooms.keys()) this.broadcastStateAt(code, false, now);
  }

  private broadcastStateAt(code: string, force: boolean, now: number): void {
    const entry = this.rooms.get(code);
    // Disconnected seats remain in the room for reconnect grace, but there is
    // nobody to receive a snapshot while the occupant map is empty.
    if (!entry || entry.occupants.size === 0) return;
    const state = entry.room.stateMessage(now);
    if (!state) return;
    // During a live round the clock itself is state (health bars, timers), so
    // updates always go out. Between rounds, an unchanged seq means nothing to
    // say, and staying quiet keeps an idle lobby at nearly zero bandwidth.
    const quiet = state.phase === 'lobby' || state.phase === 'match_over';
    if (!force && quiet && this.lastSentSeq.get(code) === state.seq) return;
    this.lastSentSeq.set(code, state.seq);
    this.broadcast(code, state);
  }

  // -------------------------------------------------------------------- tick

  /**
   * Advances every room by one step.
   *
   * Wrapped per room in a try/catch: one room throwing must not stop the other
   * rooms' matches, and it must certainly not kill the interval that drives
   * the whole server.
   */
  tickAll(): void {
    const now = this.now();
    for (const [code, entry] of this.rooms) {
      try {
        this.tickRoom(code, entry, now);
      } catch (err) {
        this.log('room tick failed', { code, error: String(err) });
      }
    }
  }

  private tickRoom(code: string, entry: Entry, now: number): void {
    const { room } = entry;

    // A player whose grace window ran out has really gone. Forfeit and free
    // the seat, so the room can be reused or reaped.
    for (const seat of room.expiredSeats(now)) {
      this.log('reconnect grace expired', { code, slot: seat.slot });
      const events = room.engine?.forfeit(seat.slot, now) ?? [];
      room.leave(seat.slot, now);
      this.detach(code, seat.slot);
      this.emit(code, events);
      this.broadcast(code, { type: 'opponent_status', slot: seat.slot, status: 'left' });
      this.broadcastLobby(code);
    }

    const events = room.tick(now);
    if (events.length > 0) this.emit(code, events);

    if (room.isDisposable(now)) {
      this.rooms.delete(code);
      this.lastSentSeq.delete(code);
      this.log('room disposed', { code, rooms: this.rooms.size });
    }
  }

  /**
   * Turns engine events into client messages.
   *
   * `rejected` events are deliberately private: the player who threw an
   * illegal action is told, and the opponent learns nothing, so a rejection
   * cannot be used as a probe for what the other side is doing.
   */
  emit(code: string, events: MatchEvent[]): void {
    if (events.length === 0) return;
    const entry = this.rooms.get(code);
    if (!entry) return;

    const shared = events.filter((e) => e.type !== 'rejected');
    for (const e of events) {
      if (e.type === 'rejected') this.sendTo(code, e.slot, { type: 'events', events: [e] });
    }
    if (shared.length > 0) this.broadcast(code, { type: 'events', events: shared });

    const engine = entry.room.engine;
    for (const e of shared) {
      if (e.type === 'round_over' && engine) {
        this.broadcast(code, {
          type: 'round_result',
          round: e.round,
          winner: e.winner,
          reason: e.reason,
          scores: [engine.state.players[0].roundsWon, engine.state.players[1].roundsWon],
        });
      }
      if (e.type === 'match_over' && engine) {
        this.broadcast(code, {
          type: 'match_over',
          winner: e.winner,
          scores: [engine.state.players[0].roundsWon, engine.state.players[1].roundsWon],
        });
      }
    }
    // Rejected actions do not change the world. Do not force an identical
    // snapshot onto both clients just because one player pressed too early.
    if (shared.length > 0) this.broadcastState(code, true);
  }

  /**
   * Starts the round when both players have readied up.
   * @returns true when a countdown was started.
   */
  maybeStart(code: string): boolean {
    const entry = this.rooms.get(code);
    const engine = entry?.room.engine;
    if (!entry || !engine) return false;
    const phase = engine.state.phase;
    // A finished match must go through the explicit rematch handshake. Starting
    // directly from match_over would keep the old score and matchWinner while
    // resetting only the round health, producing an impossible hybrid match.
    if (phase !== 'lobby') return false;
    if (!entry.room.bothReady()) return false;
    this.emit(code, engine.startCountdown(this.now()));
    return true;
  }

  /** Both players asked for a rematch: wipe the score and go back to the lobby. */
  maybeRematch(code: string): boolean {
    const entry = this.rooms.get(code);
    const engine = entry?.room.engine;
    if (!entry || !engine) return false;
    if (!engine.state.players.every((p) => p.rematchWanted && p.connected)) return false;
    engine.resetForRematch();
    this.broadcastLobby(code);
    this.broadcastState(code, true);
    return true;
  }

  /**
   * A player is leaving on purpose.
   *
   * Mid-match this is a forfeit; in the lobby it just frees the seat. Either
   * way the seat is released immediately rather than held for reconnection,
   * because they told us they were going.
   */
  leave(code: string, slot: Slot, owner?: Sink): void {
    const entry = this.rooms.get(code);
    if (!entry) return;
    if (owner && entry.occupants.get(slot)?.sink !== owner) return;
    const now = this.now();
    const engine = entry.room.engine;
    const inMatch =
      engine && engine.state.phase !== 'lobby' && engine.state.phase !== 'match_over';
    if (inMatch) this.emit(code, engine.forfeit(slot, now));
    entry.room.leave(slot, now);
    this.detach(code, slot);
    this.broadcast(code, { type: 'opponent_status', slot, status: 'left' });
    this.broadcastLobby(code);
  }

  /** A socket dropped without saying goodbye. Hold the seat for a while. */
  dropped(code: string, slot: Slot, owner?: Sink): void {
    const entry = this.rooms.get(code);
    if (!entry) return;
    if (owner && entry.occupants.get(slot)?.sink !== owner) return;
    const now = this.now();
    entry.room.markDisconnected(slot, now);
    this.detach(code, slot);
    this.broadcast(code, {
      type: 'opponent_status',
      slot,
      status: 'disconnected',
      graceSeconds: Math.round(entry.room.graceRemaining(slot, now)),
    });
    this.broadcastLobby(code);
  }

  /** Everything the health endpoint reports. */
  stats(): { rooms: number; players: number; sockets: number } {
    let players = 0;
    let sockets = 0;
    for (const entry of this.rooms.values()) {
      players += entry.room.playerCount;
      sockets += entry.occupants.size;
    }
    return { rooms: this.rooms.size, players, sockets };
  }
}

export const TICK_INTERVAL_MS = Math.round(1000 / NET.tickHz);
export const STATE_INTERVAL_MS = Math.round(1000 / NET.stateHz);
export const ROUNDS_TO_WIN = MATCH.roundsToWin;
