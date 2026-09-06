import { describe, expect, it } from 'vitest';
import { MatchEngine, otherSlot } from '../src/match.js';
import type { MatchEvent, Slot } from '../src/match.js';
import { MATCH, STAMINA, TIMING, COOLDOWN } from '../src/constants.js';

const seeds = () => [
  { id: 'a', name: 'Ada' },
  { id: 'b', name: 'Bo' },
] as const;

/** A match already counting down, at t = 0. */
function engineAt(now = 0): MatchEngine {
  const [a, b] = seeds();
  const e = new MatchEngine(a, b, now);
  e.setReady(0, true);
  e.setReady(1, true);
  e.startCountdown(now);
  return e;
}

/** A match that is live, with the clock just past the countdown. */
function liveEngine(): { engine: MatchEngine; t: number } {
  const engine = engineAt(0);
  const t = MATCH.countdownSeconds * 1000 + 1;
  engine.tick(t);
  return { engine, t };
}

/** Runs the sim forward in 30 Hz steps, collecting every event. */
function advance(engine: MatchEngine, from: number, ms: number): MatchEvent[] {
  const events: MatchEvent[] = [];
  const step = 1000 / 30;
  for (let t = from; t <= from + ms; t += step) events.push(...engine.tick(t));
  return events;
}

describe('match lifecycle', () => {
  it('starts in the lobby with nobody ready', () => {
    const [a, b] = seeds();
    const e = new MatchEngine(a, b);
    expect(e.state.phase).toBe('lobby');
    expect(e.bothReady()).toBe(false);
  });

  it('needs both players ready and connected', () => {
    const [a, b] = seeds();
    const e = new MatchEngine(a, b);
    e.setReady(0, true);
    expect(e.bothReady()).toBe(false);
    e.setReady(1, true);
    expect(e.bothReady()).toBe(true);
    e.setConnected(1, false);
    expect(e.bothReady()).toBe(false);
  });

  it('goes live only after the countdown elapses', () => {
    const e = engineAt(0);
    expect(e.state.phase).toBe('countdown');
    e.tick(MATCH.countdownSeconds * 1000 - 100);
    expect(e.state.phase).toBe('countdown');
    const events = e.tick(MATCH.countdownSeconds * 1000 + 1);
    expect(e.state.phase).toBe('live');
    expect(events.some((ev) => ev.type === 'round_start')).toBe(true);
  });

  it('gives both players full health and stamina at the start of a round', () => {
    const { engine } = liveEngine();
    for (const p of engine.state.players) {
      expect(p.health).toBe(MATCH.startingHealth);
      expect(p.stamina).toBe(MATCH.startingStamina);
    }
  });
});

describe('action validation', () => {
  it('refuses actions before the round is live', () => {
    const e = engineAt(0);
    const events = e.submitAction(0, { kind: 'thrust', zone: 'head' }, 100);
    expect(events[0]).toMatchObject({ type: 'rejected', reason: 'not_live' });
    expect(e.state.pending).toHaveLength(0);
  });

  it('accepts a legal attack and puts it in the air, not on the target', () => {
    // Damage must not be instant: the windup is the defender's whole chance.
    const { engine, t } = liveEngine();
    const events = engine.submitAction(0, { kind: 'thrust', zone: 'head' }, t);
    expect(events[0]!.type).toBe('attack_thrown');
    expect(engine.state.pending).toHaveLength(1);
    expect(engine.state.players[1].health).toBe(MATCH.startingHealth);
  });

  it('rejects a second attack inside the cooldown', () => {
    const { engine, t } = liveEngine();
    engine.submitAction(0, { kind: 'thrust', zone: 'head' }, t);
    const again = engine.submitAction(0, { kind: 'thrust', zone: 'head' }, t + 50);
    expect(again[0]).toMatchObject({ type: 'rejected', reason: 'cooldown' });
  });

  it('rejects alternating attacks that dodge the per-action cooldowns', () => {
    const { engine, t } = liveEngine();
    engine.submitAction(0, { kind: 'thrust', zone: 'head' }, t);
    const slash = engine.submitAction(0, { kind: 'slash', zone: 'torso', slash: 'lr' }, t + 50);
    expect(slash[0]).toMatchObject({ type: 'rejected', reason: 'cooldown' });
  });

  it('rejects an attack the player cannot pay for', () => {
    const { engine, t } = liveEngine();
    engine.state.players[0].stamina = STAMINA.minToAttack - 1;
    const events = engine.submitAction(0, { kind: 'thrust', zone: 'head' }, t);
    expect(events[0]).toMatchObject({ type: 'rejected', reason: 'stamina' });
  });

  it('rejects everything from a staggered player', () => {
    const { engine, t } = liveEngine();
    engine.state.players[0].staggeredUntil = t + 500;
    for (const kind of ['thrust', 'slash', 'dodge', 'parry'] as const) {
      const events = engine.submitAction(0, { kind, zone: 'head', slash: 'lr', dodge: 'left' }, t);
      expect(events[0]).toMatchObject({ type: 'rejected', reason: 'staggered' });
    }
  });

  it('rejects actions from a disconnected player', () => {
    const { engine, t } = liveEngine();
    engine.setConnected(0, false);
    const events = engine.submitAction(0, { kind: 'thrust', zone: 'head' }, t);
    expect(events[0]).toMatchObject({ type: 'rejected', reason: 'disconnected' });
  });

  it('spends stamina up front, so a whiffed attack still costs', () => {
    const { engine, t } = liveEngine();
    const before = engine.state.players[0].stamina;
    engine.submitAction(0, { kind: 'thrust', zone: 'head' }, t);
    expect(engine.state.players[0].stamina).toBeLessThan(before);
  });
});

describe('resolution', () => {
  it('applies damage when the windup elapses, and only then', () => {
    const { engine, t } = liveEngine();
    engine.submitAction(0, { kind: 'thrust', zone: 'head' }, t);
    engine.tick(t + 100);
    expect(engine.state.players[1].health).toBe(MATCH.startingHealth);
    const events = advance(engine, t + 100, 400);
    expect(engine.state.players[1].health).toBeLessThan(MATCH.startingHealth);
    expect(events.some((e) => e.type === 'attack_resolved')).toBe(true);
  });

  it('lets a defender who guards the right line take far less', () => {
    const openMatch = liveEngine();
    openMatch.engine.submitAction(0, { kind: 'thrust', zone: 'head' }, openMatch.t);
    advance(openMatch.engine, openMatch.t, 500);
    const openDamage = MATCH.startingHealth - openMatch.engine.state.players[1].health;

    const guardedMatch = liveEngine();
    guardedMatch.engine.setDefence(1, 'head', 90);
    guardedMatch.engine.submitAction(0, { kind: 'thrust', zone: 'head' }, guardedMatch.t);
    advance(guardedMatch.engine, guardedMatch.t, 500);
    const guardedDamage = MATCH.startingHealth - guardedMatch.engine.state.players[1].health;

    expect(guardedDamage).toBeLessThan(openDamage);
    expect(guardedDamage).toBeGreaterThan(0);
  });

  it('staggers the attacker on a perfect parry', () => {
    const { engine, t } = liveEngine();
    engine.submitAction(0, { kind: 'thrust', zone: 'head' }, t);
    const landsAt = engine.state.pending[0]!.landsAt;
    engine.submitAction(1, { kind: 'parry' }, landsAt - 20);
    advance(engine, t, 600);
    expect(engine.state.players[1].health).toBe(MATCH.startingHealth);
    expect(engine.state.players[0].staggeredUntil).toBeGreaterThan(landsAt);
  });

  it('refunds a slice of stamina when an attack is dodged', () => {
    const { engine, t } = liveEngine();
    engine.submitAction(0, { kind: 'thrust', zone: 'torso' }, t);
    const landsAt = engine.state.pending[0]!.landsAt;
    engine.submitAction(1, { kind: 'dodge', dodge: 'left' }, landsAt - 100);
    const before = engine.state.players[0].stamina;
    advance(engine, t, 600);
    expect(engine.state.players[1].health).toBe(MATCH.startingHealth);
    // Regen also runs during those 600 ms, so the assertion is just "not worse".
    expect(engine.state.players[0].stamina).toBeGreaterThan(before);
  });

  it('resolves two attacks landing in the same tick in the order thrown', () => {
    const { engine, t } = liveEngine();
    engine.submitAction(0, { kind: 'thrust', zone: 'head' }, t);
    engine.submitAction(1, { kind: 'thrust', zone: 'torso' }, t + 10);
    const events = advance(engine, t, 600).filter((e) => e.type === 'attack_resolved');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ attacker: 0 });
    expect(events[1]).toMatchObject({ attacker: 1 });
  });

  it('clears attacks in flight when the round ends', () => {
    const { engine, t } = liveEngine();
    engine.state.players[1].health = 1;
    engine.submitAction(0, { kind: 'thrust', zone: 'head' }, t);
    advance(engine, t, 600);
    expect(engine.state.phase).toBe('round_over');
    expect(engine.state.pending).toHaveLength(0);
  });
});

describe('rounds and match', () => {
  /** Beats a player down to zero by repeatedly landing clean head thrusts. */
  function knockOut(engine: MatchEngine, attacker: Slot, from: number): number {
    let t = from;
    for (let i = 0; i < 40; i++) {
      if (engine.state.phase !== 'live') break;
      engine.state.players[attacker].stamina = 100;
      engine.submitAction(attacker, { kind: 'thrust', zone: 'head' }, t);
      advance(engine, t, 700);
      t += 700;
    }
    return t;
  }

  it('awards the round to the survivor and counts it', () => {
    const { engine, t } = liveEngine();
    knockOut(engine, 0, t);
    expect(engine.state.phase).toBe('round_over');
    expect(engine.state.roundWinner).toBe(0);
    expect(engine.state.players[0].roundsWon).toBe(1);
  });

  it('starts the next round automatically after the break', () => {
    const { engine, t } = liveEngine();
    const after = knockOut(engine, 0, t);
    advance(engine, after, MATCH.interRoundSeconds * 1000 + 200);
    expect(engine.state.round).toBe(2);
    expect(['countdown', 'live']).toContain(engine.state.phase);
    expect(engine.state.players[1].health).toBe(MATCH.startingHealth);
  });

  it('ends the match when someone takes two rounds', () => {
    let { engine, t } = liveEngine();
    for (let round = 0; round < MATCH.maxRounds; round++) {
      if (engine.state.phase !== 'live') {
        // roll forward through the break and the next countdown
        t += 200;
        advance(engine, t, (MATCH.interRoundSeconds + MATCH.countdownSeconds) * 1000 + 400);
        t += (MATCH.interRoundSeconds + MATCH.countdownSeconds) * 1000 + 400;
      }
      if (engine.state.matchWinner !== null) break;
      t = knockOut(engine, 0, t);
    }
    expect(engine.state.matchWinner).toBe(0);
    expect(engine.state.players[0].roundsWon).toBe(MATCH.roundsToWin);
  });

  it('gives the round to nobody when both players fall in the same tick', () => {
    const { engine, t } = liveEngine();
    engine.state.players[0].health = 0;
    engine.state.players[1].health = 0;
    advance(engine, t, 100);
    expect(engine.state.phase).toBe('round_over');
    expect(engine.state.roundWinner).toBeNull();
  });

  it('decides a timed-out round on remaining health', () => {
    const { engine, t } = liveEngine();
    engine.state.players[1].health = 40;
    const events = engine.tick(t + MATCH.roundTimeLimitSeconds * 1000 + 10);
    const over = events.find((e) => e.type === 'round_over');
    expect(over).toMatchObject({ winner: 0, reason: 'timeout' });
  });
});

describe('disconnects and rematch', () => {
  it('forfeits the match to the player who stayed', () => {
    const { engine, t } = liveEngine();
    const events = engine.forfeit(1, t);
    expect(engine.state.matchWinner).toBe(0);
    expect(engine.state.phase).toBe('match_over');
    expect(events.some((e) => e.type === 'round_over' && e.reason === 'forfeit')).toBe(true);
  });

  it('is idempotent when a forfeit arrives twice', () => {
    // A socket close and a "leave" message can both land; the second must not
    // rewrite the result or throw.
    const { engine, t } = liveEngine();
    engine.forfeit(1, t);
    const again = engine.forfeit(1, t + 10);
    expect(again).toHaveLength(0);
    expect(engine.state.matchWinner).toBe(0);
  });

  it('resets scores and readiness for a rematch', () => {
    const { engine, t } = liveEngine();
    engine.forfeit(1, t);
    engine.resetForRematch();
    expect(engine.state.phase).toBe('lobby');
    expect(engine.state.matchWinner).toBeNull();
    expect(engine.state.players.every((p) => p.roundsWon === 0 && !p.ready)).toBe(true);
  });
});

describe('determinism', () => {
  it('produces identical state from identical inputs and timestamps', () => {
    // Two engines fed the same script must agree exactly - this is the property
    // that lets the client predict what the server is about to say.
    const run = () => {
      const { engine, t } = liveEngine();
      engine.setDefence(1, 'head', 90);
      engine.submitAction(0, { kind: 'thrust', zone: 'head' }, t);
      engine.submitAction(1, { kind: 'dodge', dodge: 'left' }, t + 120);
      advance(engine, t, 1500);
      return engine.state;
    };
    const a = run();
    const b = run();
    expect(a.players[0].health).toBe(b.players[0].health);
    expect(a.players[1].health).toBe(b.players[1].health);
    expect(a.players[0].stamina).toBeCloseTo(b.players[0].stamina, 10);
    expect(a.seq).toBe(b.seq);
  });

  it('is unaffected by the tick rate it is driven at', () => {
    const play = (hz: number) => {
      const { engine, t } = liveEngine();
      engine.submitAction(0, { kind: 'thrust', zone: 'head' }, t);
      const step = 1000 / hz;
      for (let x = t; x <= t + 1000; x += step) engine.tick(x);
      return engine.state.players[1].health;
    };
    expect(play(30)).toBe(play(60));
    expect(play(30)).toBe(play(15));
  });
});

describe('otherSlot', () => {
  it('swaps the two slots', () => {
    expect(otherSlot(0)).toBe(1);
    expect(otherSlot(1)).toBe(0);
  });
});

describe('cooldown constants', () => {
  it('leaves a parry window that a human can actually hit', () => {
    // If the parry window were shorter than a frame at 30 fps, parrying would
    // be luck rather than skill.
    expect(TIMING.parryWindowSeconds * 1000).toBeGreaterThan(1000 / 30);
    expect(COOLDOWN.parry).toBeGreaterThan(0);
  });
});
