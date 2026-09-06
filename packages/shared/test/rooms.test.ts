import { describe, expect, it } from 'vitest';
import { generateRoomCode, Room } from '../src/rooms.js';
import { NET, MATCH } from '../src/constants.js';

const room = (now = 0, grace = 30) =>
  new Room('AB12', now, { reconnectGraceSeconds: grace });

describe('generateRoomCode', () => {
  it('uses the agreed alphabet and length', () => {
    const code = generateRoomCode(new Set());
    expect(code).toHaveLength(NET.roomCodeLength);
    for (const ch of code) expect(NET.roomCodeAlphabet).toContain(ch);
  });

  it('never uses characters people confuse when reading a code aloud', () => {
    for (const banned of ['O', '0', 'I', '1']) {
      expect(NET.roomCodeAlphabet).not.toContain(banned);
    }
  });

  it('avoids codes that are already taken', () => {
    // An rng that keeps proposing the same code must not hand out a duplicate.
    const taken = new Set(['AAAA']);
    const code = generateRoomCode(taken, (() => {
      let calls = 0;
      return () => (calls++ < 4 ? 0 : 0.5);
    })());
    expect(taken.has(code)).toBe(false);
  });

  it('still returns something when the space is saturated', () => {
    const always = () => 0;
    const everything = new Set([generateRoomCode(new Set(), always)]);
    const code = generateRoomCode(everything, always);
    expect(code.length).toBeGreaterThan(NET.roomCodeLength);
  });

  it('does not collide across many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateRoomCode(seen));
    expect(seen.size).toBe(500);
  });
});

describe('joining', () => {
  it('seats the first player in slot 0 and the second in slot 1', () => {
    const r = room();
    const a = r.join('Ada', 0);
    const b = r.join('Bo', 10);
    expect(a.ok && a.seat.slot).toBe(0);
    expect(b.ok && b.seat.slot).toBe(1);
    expect(r.isFull).toBe(true);
  });

  it('turns away a third player', () => {
    const r = room();
    r.join('Ada', 0);
    r.join('Bo', 0);
    const c = r.join('Cy', 0);
    expect(c).toEqual({ ok: false, reason: 'room_full' });
  });

  it('gives each seat a distinct token', () => {
    const r = room();
    const a = r.join('Ada', 0);
    const b = r.join('Bo', 0);
    expect(a.ok && b.ok && a.seat.token).not.toBe(b.seat.token);
  });

  it('has no match engine until there are two people to simulate', () => {
    const r = room();
    r.join('Ada', 0);
    expect(r.engine).toBeNull();
    expect(r.stateMessage(0)).toBeNull();
    r.join('Bo', 0);
    expect(r.engine).not.toBeNull();
  });

  it('reuses a slot freed by someone who left', () => {
    const r = room();
    r.join('Ada', 0);
    const b = r.join('Bo', 0);
    r.leave((b as { ok: true; seat: { slot: 0 | 1 } }).seat.slot, 100);
    const c = r.join('Cy', 200);
    expect(c.ok && c.seat.slot).toBe(1);
  });
});

describe('disconnect and reconnect', () => {
  it('holds the seat open during the grace window', () => {
    const r = room(0, 30);
    r.join('Ada', 0);
    const b = r.join('Bo', 0);
    const token = (b as { ok: true; seat: { token: string } }).seat.token;

    r.markDisconnected(1, 1000);
    expect(r.graceRemaining(1, 1000)).toBeCloseTo(30, 0);
    const back = r.rejoin(token, 5000);
    expect(back.ok).toBe(true);
    expect(r.seats[1]!.connected).toBe(true);
  });

  it('tells the match engine the player is gone, and back', () => {
    const r = room();
    r.join('Ada', 0);
    const b = r.join('Bo', 0);
    const token = (b as { ok: true; seat: { token: string } }).seat.token;
    r.markDisconnected(1, 1000);
    expect(r.engine!.state.players[1].connected).toBe(false);
    r.rejoin(token, 2000);
    expect(r.engine!.state.players[1].connected).toBe(true);
  });

  it('refuses a rejoin once the grace window has closed', () => {
    const r = room(0, 5);
    r.join('Ada', 0);
    const b = r.join('Bo', 0);
    const token = (b as { ok: true; seat: { token: string } }).seat.token;
    r.markDisconnected(1, 1000);
    expect(r.rejoin(token, 1000 + 5001)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses an unknown token', () => {
    const r = room();
    r.join('Ada', 0);
    expect(r.rejoin('not-a-real-token', 0)).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('lists seats whose grace has run out, so the server can forfeit them', () => {
    const r = room(0, 5);
    r.join('Ada', 0);
    r.join('Bo', 0);
    r.markDisconnected(1, 1000);
    expect(r.expiredSeats(2000)).toHaveLength(0);
    expect(r.expiredSeats(1000 + 5001)).toHaveLength(1);
  });

  it('reports no grace remaining for a connected player', () => {
    const r = room();
    r.join('Ada', 0);
    expect(r.graceRemaining(0, 5000)).toBe(0);
  });
});

describe('cleanup', () => {
  it('reaps a room nobody ever joined', () => {
    const r = room(0);
    expect(r.isDisposable(1000)).toBe(false);
    expect(r.isDisposable(10_000)).toBe(true);
  });

  it('does not reap a room in the instant between creation and the first join', () => {
    // The creator's join arrives a moment after the room exists. Reaping in
    // that gap would make "create room" fail at random.
    const r = room(0);
    expect(r.isDisposable(100)).toBe(false);
  });

  it('does not reap a room with someone connected in it', () => {
    const r = room(0);
    r.join('Ada', 0);
    expect(r.isDisposable(10_000_000)).toBe(false);
  });

  it('reaps a room where everyone dropped and stayed gone', () => {
    const r = room(0);
    r.join('Ada', 0);
    r.join('Bo', 0);
    r.markDisconnected(0, 1000);
    r.markDisconnected(1, 1000);
    expect(r.isDisposable(2000)).toBe(false);
    expect(r.isDisposable(1000 + 61_000)).toBe(true);
  });

  it('counts activity, so a busy room is never considered idle', () => {
    const r = room(0);
    r.join('Ada', 0);
    r.markDisconnected(0, 1000);
    r.touch(500_000);
    expect(r.isDisposable(500_100)).toBe(false);
  });
});

describe('state broadcast', () => {
  it('rounds health and stamina, and never leaks internals', () => {
    const r = room();
    r.join('Ada', 0);
    r.join('Bo', 0);
    r.engine!.state.players[0].health = 63.7;
    const msg = r.stateMessage(1234)!;
    expect(msg.type).toBe('state');
    expect(msg.players[0].health).toBe(64);
    expect(msg.now).toBe(1234);
    // Tokens are per-seat secrets; they must never appear in a broadcast.
    expect(JSON.stringify(msg)).not.toContain(r.seats[0]!.token);
  });

  it('telegraphs attacks in the air so the defender can react', () => {
    const r = room();
    r.join('Ada', 0);
    r.join('Bo', 0);
    const e = r.engine!;
    e.setReady(0, true);
    e.setReady(1, true);
    e.startCountdown(0);
    const t = MATCH.countdownSeconds * 1000 + 1;
    e.tick(t);
    e.submitAction(0, { kind: 'thrust', zone: 'head' }, t);
    const msg = r.stateMessage(t)!;
    expect(msg.incoming).toHaveLength(1);
    expect(msg.incoming[0]).toMatchObject({ attacker: 0, zone: 'head', kind: 'thrust' });
    expect(msg.incoming[0]!.landsAt).toBeGreaterThan(t);
  });

  it('lists lobby players with their readiness', () => {
    const r = room();
    r.join('Ada', 0);
    r.join('Bo', 0);
    r.setReady(0, true, 0);
    const players = r.lobbyPlayers();
    expect(players).toHaveLength(2);
    expect(players[0]).toMatchObject({ name: 'Ada', ready: true });
    expect(players[1]).toMatchObject({ name: 'Bo', ready: false });
  });

  it('reports a solo lobby without pretending there is a match', () => {
    const r = room();
    r.join('Ada', 0);
    expect(r.lobbyPlayers()).toHaveLength(1);
    expect(r.bothReady()).toBe(false);
  });

  it('records a pose as both cosmetic state and the defender guard', () => {
    const r = room();
    r.join('Ada', 0);
    r.join('Bo', 0);
    r.setPose(1, { a: 90, h: 0.1, wx: 0.4, wy: -0.5, c: 0.9 }, 'head');
    expect(r.engine!.state.players[1].guardZone).toBe('head');
    expect(r.engine!.state.players[1].bladeAngle).toBe(90);
    expect(r.engine!.state.players[1].pose).toMatchObject({ c: 0.9 });
  });

  it('ignores a pose sent before the room has two players', () => {
    const r = room();
    r.join('Ada', 0);
    expect(() => r.setPose(0, { a: 0, h: 0, wx: 0, wy: 0, c: 1 }, null)).not.toThrow();
  });
});
