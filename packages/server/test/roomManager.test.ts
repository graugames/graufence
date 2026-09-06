/**
 * Room manager tests.
 *
 * Nothing here opens a port. `FakeSink` stands in for a WebSocket, which means
 * the interesting cases - a player dropping mid-round, a grace window closing,
 * a room emptying out - run instantly and deterministically instead of racing
 * a real socket.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { RoomManager } from '../src/roomManager.js';
import type { Sink } from '../src/roomManager.js';
import { MATCH } from '@graufence/shared';
import type { ServerMessage } from '@graufence/shared';

class FakeSink implements Sink {
  sent: ServerMessage[] = [];
  open = true;
  closedWith: number | undefined;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }

  close(code?: number): void {
    this.open = false;
    this.closedWith = code;
  }

  ofType<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
  }

  clear(): void {
    this.sent = [];
  }
}

/** A manager with a clock the test drives by hand. */
function setup(graceSeconds = 30) {
  let clock = 1000;
  const logs: string[] = [];
  const manager = new RoomManager({
    reconnectGraceSeconds: graceSeconds,
    now: () => clock,
    log: (m) => logs.push(m),
  });
  return {
    manager,
    logs,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    set: (ms: number) => {
      clock = ms;
    },
  };
}

/** Seats two players and returns everything a test needs to drive them. */
function twoPlayers(graceSeconds = 30) {
  const ctx = setup(graceSeconds);
  const room = ctx.manager.create()!;
  const a = new FakeSink();
  const b = new FakeSink();
  room.join('Ada', ctx.now());
  room.join('Bo', ctx.now());
  ctx.manager.attach(room.code, 0, a);
  ctx.manager.attach(room.code, 1, b);
  return { ...ctx, room, a, b };
}

describe('room creation', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('hands out a room with a code', () => {
    const room = ctx.manager.create();
    expect(room).not.toBeNull();
    expect(ctx.manager.get(room!.code)).toBe(room);
    expect(ctx.manager.size).toBe(1);
  });

  it('never hands out the same code twice', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) codes.add(ctx.manager.create()!.code);
    expect(codes.size).toBe(100);
  });

  it('refuses to create past the room cap, rather than falling over', () => {
    const small = new RoomManager({ maxRooms: 2, now: ctx.now });
    expect(small.create()).not.toBeNull();
    expect(small.create()).not.toBeNull();
    expect(small.create()).toBeNull();
  });

  it('returns null for an unknown code', () => {
    expect(ctx.manager.get('ZZZZ')).toBeNull();
  });
});

describe('broadcasting', () => {
  it('sends state to both seats', () => {
    const { manager, room, a, b } = twoPlayers();
    manager.broadcastState(room.code, true);
    expect(a.ofType('state')).toHaveLength(1);
    expect(b.ofType('state')).toHaveLength(1);
  });

  it('never puts a seat token on the wire in a broadcast', () => {
    const { manager, room, a } = twoPlayers();
    manager.broadcastLobby(room.code);
    manager.broadcastState(room.code, true);
    const wire = JSON.stringify(a.sent);
    for (const seat of room.seats) {
      if (seat) expect(wire).not.toContain(seat.token);
    }
  });

  it('stays quiet in an idle lobby instead of spraying identical snapshots', () => {
    const { manager, room, a } = twoPlayers();
    manager.broadcastState(room.code, true);
    a.clear();
    for (let i = 0; i < 20; i++) manager.broadcastState(room.code);
    expect(a.ofType('state')).toHaveLength(0);
  });

  it('keeps sending during a live round, because the clock is state too', () => {
    const { manager, room, a, set } = twoPlayers();
    room.setReady(0, true, 0);
    room.setReady(1, true, 0);
    manager.maybeStart(room.code);
    set(1000 + MATCH.countdownSeconds * 1000 + 100);
    manager.tickAll();
    a.clear();
    for (let i = 0; i < 5; i++) manager.broadcastState(room.code);
    expect(a.ofType('state').length).toBeGreaterThan(1);
  });

  it('tolerates a socket that has already gone away', () => {
    const { manager, room, a, b } = twoPlayers();
    a.open = false;
    expect(() => manager.broadcastState(room.code, true)).not.toThrow();
    expect(b.ofType('state')).toHaveLength(1);
  });

  it('keeps a rejection private to the player who caused it', () => {
    // Otherwise a rejection doubles as a probe: throw illegal actions and read
    // the opponent's timing off the replies.
    const { manager, room, a, b } = twoPlayers();
    a.clear();
    b.clear();
    manager.emit(room.code, [{ type: 'rejected', slot: 0, kind: 'thrust', reason: 'cooldown' }]);
    expect(a.ofType('events')).toHaveLength(1);
    expect(b.ofType('events')).toHaveLength(0);
  });
});

describe('starting a match', () => {
  it('waits for both players to ready up', () => {
    const { manager, room } = twoPlayers();
    room.setReady(0, true, 0);
    expect(manager.maybeStart(room.code)).toBe(false);
    room.setReady(1, true, 0);
    expect(manager.maybeStart(room.code)).toBe(true);
    expect(room.engine!.state.phase).toBe('countdown');
  });

  it('does not restart a match already under way', () => {
    const { manager, room } = twoPlayers();
    room.setReady(0, true, 0);
    room.setReady(1, true, 0);
    manager.maybeStart(room.code);
    expect(manager.maybeStart(room.code)).toBe(false);
  });

  it('tells both clients the countdown has begun', () => {
    const { manager, room, a, b } = twoPlayers();
    room.setReady(0, true, 0);
    room.setReady(1, true, 0);
    manager.maybeStart(room.code);
    for (const sink of [a, b]) {
      const events = sink.ofType('events').flatMap((m) => m.events);
      expect(events.some((e) => e.type === 'countdown')).toBe(true);
    }
  });
});

describe('disconnects', () => {
  it('holds the seat and warns the opponent', () => {
    const { manager, room, b } = twoPlayers();
    b.clear();
    manager.dropped(room.code, 0);
    const status = b.ofType('opponent_status');
    expect(status[0]).toMatchObject({ slot: 0, status: 'disconnected' });
    expect(status[0]!.graceSeconds).toBeGreaterThan(0);
    expect(room.seats[0]).not.toBeNull();
  });

  it('forfeits the match once the grace window closes', () => {
    const { manager, room, b, set, advance } = twoPlayers(5);
    room.setReady(0, true, 0);
    room.setReady(1, true, 0);
    manager.maybeStart(room.code);
    set(1000 + MATCH.countdownSeconds * 1000 + 100);
    manager.tickAll();

    manager.dropped(room.code, 0);
    b.clear();
    advance(6000);
    manager.tickAll();

    expect(room.engine!.state.matchWinner).toBe(1);
    expect(b.ofType('match_over')[0]).toMatchObject({ winner: 1 });
    expect(room.seats[0]).toBeNull();
  });

  it('lets a player reclaim their seat inside the window', () => {
    const { manager, room, advance } = twoPlayers(30);
    const token = room.seats[0]!.token;
    manager.dropped(room.code, 0);
    advance(5000);
    manager.tickAll();
    const back = room.rejoin(token, 6000);
    expect(back.ok).toBe(true);
    expect(room.engine!.state.players[0].connected).toBe(true);
  });

  it('treats leaving on purpose as an immediate forfeit', () => {
    const { manager, room, b, set } = twoPlayers();
    room.setReady(0, true, 0);
    room.setReady(1, true, 0);
    manager.maybeStart(room.code);
    set(1000 + MATCH.countdownSeconds * 1000 + 100);
    manager.tickAll();
    b.clear();

    manager.leave(room.code, 0);
    expect(room.engine!.state.matchWinner).toBe(1);
    expect(b.ofType('opponent_status')[0]).toMatchObject({ slot: 0, status: 'left' });
  });

  it('does not forfeit someone leaving from the lobby', () => {
    const { manager, room } = twoPlayers();
    manager.leave(room.code, 1);
    expect(room.engine!.state.matchWinner).toBeNull();
    expect(room.seats[1]).toBeNull();
  });

  it('ignores a leave for a room that is already gone', () => {
    const { manager } = twoPlayers();
    expect(() => manager.leave('NOPE', 0)).not.toThrow();
    expect(() => manager.dropped('NOPE', 1)).not.toThrow();
  });
});

describe('rematch', () => {
  it('needs both players to ask', () => {
    const { manager, room } = twoPlayers();
    const engine = room.engine!;
    engine.state.players[0].rematchWanted = true;
    expect(manager.maybeRematch(room.code)).toBe(false);
    engine.state.players[1].rematchWanted = true;
    expect(manager.maybeRematch(room.code)).toBe(true);
    expect(engine.state.phase).toBe('lobby');
    expect(engine.state.players.every((p) => p.roundsWon === 0)).toBe(true);
  });

  it('will not start a rematch with a disconnected player', () => {
    const { manager, room } = twoPlayers();
    const engine = room.engine!;
    engine.state.players[0].rematchWanted = true;
    engine.state.players[1].rematchWanted = true;
    manager.dropped(room.code, 1);
    expect(manager.maybeRematch(room.code)).toBe(false);
  });
});

describe('cleanup', () => {
  it('reaps a room nobody ever joined', () => {
    const ctx = setup();
    const room = ctx.manager.create()!;
    ctx.advance(60_000);
    ctx.manager.tickAll();
    expect(ctx.manager.get(room.code)).toBeNull();
    expect(ctx.manager.size).toBe(0);
  });

  it('keeps a room with players in it', () => {
    const { manager, room, advance } = twoPlayers();
    advance(600_000);
    manager.tickAll();
    expect(manager.get(room.code)).not.toBeNull();
  });

  it('reaps the room once both players have left', () => {
    const { manager, room, advance } = twoPlayers();
    manager.leave(room.code, 0);
    manager.leave(room.code, 1);
    advance(60_000);
    manager.tickAll();
    expect(manager.get(room.code)).toBeNull();
  });

  it('survives a room that throws during its tick', () => {
    // One broken room must not stop every other match on the server.
    const { manager, room, logs } = twoPlayers();
    const healthy = manager.create()!;
    Object.defineProperty(room, 'engine', {
      get() {
        throw new Error('boom');
      },
    });
    expect(() => manager.tickAll()).not.toThrow();
    expect(logs.some((l) => l.includes('tick failed'))).toBe(true);
    expect(manager.get(healthy.code)).not.toBeNull();
  });
});

describe('stats', () => {
  it('counts rooms, seated players and live sockets', () => {
    const { manager } = twoPlayers();
    expect(manager.stats()).toMatchObject({ rooms: 1, players: 2, sockets: 2 });
  });
});
