import { describe, expect, it } from 'vitest';
import {
  baseDamage,
  canAfford,
  cooldownSeconds,
  offCooldown,
  offGlobalAttackCooldown,
  regenStamina,
  resolveAttack,
  staminaCost,
  windupSeconds,
} from '../src/combat.js';
import type { DefenceSnapshot, PendingAttack } from '../src/combat.js';
import { COOLDOWN, DAMAGE, STAMINA, TIMING, ZONE_DAMAGE } from '../src/constants.js';
import { ZONE_CENTER_ANGLE } from '../src/actions.js';
import type { HitZone } from '../src/actions.js';

const LANDS_AT = 10_000;

const attack = (over: Partial<PendingAttack> = {}): PendingAttack => ({
  id: 1,
  attacker: 0,
  kind: 'thrust',
  zone: 'torso',
  thrownAt: LANDS_AT - 260,
  landsAt: LANDS_AT,
  ...over,
});

/** A defender doing nothing at all. */
const openDefence = (over: Partial<DefenceSnapshot> = {}): DefenceSnapshot => ({
  guardZone: null,
  bladeAngle: 90,
  lastParryAt: -Infinity,
  dodgeStartedAt: null,
  dodgeDirection: null,
  ...over,
});

describe('damage table', () => {
  it('rewards the head and punishes nothing below the chip floor', () => {
    expect(baseDamage('thrust', 'head')).toBeGreaterThan(baseDamage('thrust', 'torso'));
    expect(baseDamage('thrust', 'torso')).toBeGreaterThan(baseDamage('thrust', 'left'));
  });

  it('makes a thrust hit harder than a slash to the same zone', () => {
    expect(baseDamage('thrust', 'torso')).toBeGreaterThan(baseDamage('slash', 'torso'));
  });

  it('gives a thrust a shorter windup than a slash', () => {
    // Thrust is the fast, committing option; slash is slower but sweeps.
    expect(windupSeconds('thrust')).toBeLessThan(windupSeconds('slash'));
  });
});

describe('resolveAttack - clean hit', () => {
  it('lands full damage on an open defender', () => {
    const r = resolveAttack(attack({ zone: 'head' }), openDefence(), LANDS_AT);
    expect(r.outcome).toBe('hit');
    expect(r.damage).toBe(Math.round(ZONE_DAMAGE.head * DAMAGE.thrustMultiplier));
    expect(r.whiff).toBe(false);
  });

  it('reports the zone that was actually struck', () => {
    for (const zone of ['head', 'torso', 'left', 'right'] as HitZone[]) {
      expect(resolveAttack(attack({ zone }), openDefence(), LANDS_AT).zone).toBe(zone);
    }
  });
});

describe('resolveAttack - guard', () => {
  it('cuts damage hard when the guard covers the attacked zone', () => {
    const guarded = resolveAttack(
      attack({ zone: 'head' }),
      openDefence({ guardZone: 'head', bladeAngle: ZONE_CENTER_ANGLE.head }),
      LANDS_AT,
    );
    const open = resolveAttack(attack({ zone: 'head' }), openDefence(), LANDS_AT);
    expect(guarded.outcome).toBe('guarded');
    expect(guarded.damage).toBeLessThan(open.damage * 0.5);
  });

  it('does nothing when the guard is on the wrong line', () => {
    const r = resolveAttack(
      attack({ zone: 'head' }),
      openDefence({ guardZone: 'torso', bladeAngle: ZONE_CENTER_ANGLE.torso }),
      LANDS_AT,
    );
    expect(r.outcome).toBe('hit');
  });

  it('always leaves chip damage, so guarding is not an invincibility button', () => {
    const r = resolveAttack(
      attack({ zone: 'left', kind: 'slash' }),
      openDefence({ guardZone: 'left', bladeAngle: ZONE_CENTER_ANGLE.left }),
      LANDS_AT,
    );
    expect(r.damage).toBeGreaterThanOrEqual(DAMAGE.minimumChip);
  });

  it('gives less protection to a blade clinging to the edge of the sector', () => {
    const centred = resolveAttack(
      attack({ zone: 'head' }),
      openDefence({ guardZone: 'head', bladeAngle: 90 }),
      LANDS_AT,
    );
    const edge = resolveAttack(
      attack({ zone: 'head' }),
      openDefence({ guardZone: 'head', bladeAngle: 124 }),
      LANDS_AT,
    );
    expect(edge.damage).toBeGreaterThan(centred.damage);
  });
});

describe('resolveAttack - parry', () => {
  it('scores a perfect parry inside the tight window', () => {
    const r = resolveAttack(
      attack(),
      openDefence({ lastParryAt: LANDS_AT - TIMING.perfectParryWindowSeconds * 1000 + 5 }),
      LANDS_AT,
    );
    expect(r.outcome).toBe('perfect_parry');
    expect(r.damage).toBe(0);
    expect(r.stagger).toBe(true);
  });

  it('still saves the defender on a late parry, without the riposte', () => {
    const r = resolveAttack(
      attack(),
      openDefence({ lastParryAt: LANDS_AT - TIMING.parryWindowSeconds * 1000 + 5 }),
      LANDS_AT,
    );
    expect(r.outcome).toBe('parried');
    expect(r.stagger).toBe(false);
  });

  it('does nothing when the parry was far too early', () => {
    const r = resolveAttack(attack(), openDefence({ lastParryAt: LANDS_AT - 2000 }), LANDS_AT);
    expect(r.outcome).toBe('hit');
  });

  it('counts a parry thrown slightly late, since reactions overshoot', () => {
    const r = resolveAttack(
      attack(),
      openDefence({ lastParryAt: LANDS_AT + TIMING.perfectParryWindowSeconds * 1000 - 5 }),
      LANDS_AT,
    );
    expect(r.outcome).toBe('perfect_parry');
  });

  it('beats a guard on the same line - the harder read wins', () => {
    const r = resolveAttack(
      attack({ zone: 'head' }),
      openDefence({
        guardZone: 'head',
        lastParryAt: LANDS_AT - 20,
      }),
      LANDS_AT,
    );
    expect(r.outcome).toBe('perfect_parry');
  });
});

describe('resolveAttack - dodge', () => {
  it('avoids an attack aimed anywhere but the side dodged into', () => {
    const r = resolveAttack(
      attack({ zone: 'torso' }),
      openDefence({ dodgeStartedAt: LANDS_AT - 100, dodgeDirection: 'left' }),
      LANDS_AT,
    );
    expect(r.outcome).toBe('dodged');
    expect(r.damage).toBe(0);
    expect(r.whiff).toBe(true);
  });

  it('walks straight into a blade aimed at the side dodged toward', () => {
    const r = resolveAttack(
      attack({ zone: 'right' }),
      openDefence({ dodgeStartedAt: LANDS_AT - 100, dodgeDirection: 'right' }),
      LANDS_AT,
    );
    expect(r.outcome).toBe('hit');
  });

  it('stops protecting once the invulnerability window has passed', () => {
    const r = resolveAttack(
      attack(),
      openDefence({
        dodgeStartedAt: LANDS_AT - TIMING.dodgeInvulnSeconds * 1000 - 50,
        dodgeDirection: 'left',
      }),
      LANDS_AT,
    );
    expect(r.outcome).toBe('hit');
  });

  it('does not protect against an attack that lands before the dodge starts', () => {
    const r = resolveAttack(
      attack(),
      openDefence({ dodgeStartedAt: LANDS_AT + 50, dodgeDirection: 'left' }),
      LANDS_AT,
    );
    expect(r.outcome).toBe('hit');
  });
});

describe('stamina', () => {
  it('charges more for a dodge than for a slash', () => {
    expect(staminaCost('dodge')).toBeGreaterThan(staminaCost('slash'));
    expect(staminaCost('thrust')).toBeGreaterThan(staminaCost('slash'));
  });

  it('refuses an attack the player cannot pay for', () => {
    expect(canAfford(STAMINA.minToAttack - 1, 'slash')).toBe(false);
    expect(canAfford(100, 'slash')).toBe(true);
  });

  it('does not regenerate during the post-spend delay', () => {
    const spentAt = 5000;
    const during = regenStamina(50, 0.1, spentAt, spentAt + 100);
    expect(during).toBe(50);
  });

  it('regenerates once the delay has passed', () => {
    const spentAt = 5000;
    const settled = spentAt + STAMINA.regenDelaySeconds * 1000;
    const after = regenStamina(50, 1, spentAt, settled + 1000);
    expect(after).toBeCloseTo(50 + STAMINA.regenPerSecond, 1);
  });

  it('never exceeds 100 or drops below 0', () => {
    expect(regenStamina(99, 10, 0, 100_000)).toBe(100);
    expect(regenStamina(1, 10, 100_000, 100_001, true)).toBe(0);
  });

  it('drains slowly while guarding, so turtling has a cost', () => {
    const held = regenStamina(50, 1, 0, 100, true);
    const idle = regenStamina(50, 1, 0, 100, false);
    expect(held).toBeLessThan(idle);
  });

  it('cannot be spammed: an attack every cooldown drains the bar dry', () => {
    // The anti-spam property stated as a property rather than as a threshold:
    // a player mashing attack the instant each cooldown expires must run out.
    // Simulated at the server's real 30 Hz tick rate.
    let stamina = 100;
    let lastSpendAt = -Infinity;
    let now = 0;
    let landed = 0;
    const tick = 1000 / 30;
    for (let step = 0; step < 400; step++) {
      if (canAfford(stamina, 'thrust') && offCooldown('thrust', lastSpendAt, now)) {
        stamina -= staminaCost('thrust');
        lastSpendAt = now;
        landed++;
      }
      now += tick;
      stamina = regenStamina(stamina, tick / 1000, lastSpendAt, now);
    }
    // Over ~13 seconds an unlimited player would land 20 attacks; stamina
    // holds it to a fraction of that.
    expect(landed).toBeGreaterThan(3);
    expect(landed).toBeLessThan(14);
  });

  it('credits only the part of a long tick that is past the delay', () => {
    // A 1 s tick right after a spend must not pay out a full second of regen.
    const spentAt = 1000;
    const lagged = regenStamina(0, 1, spentAt, spentAt + 1000);
    expect(lagged).toBeCloseTo(STAMINA.regenPerSecond * (1 - STAMINA.regenDelaySeconds), 1);
  });
});

describe('cooldowns', () => {
  it('blocks a repeat inside the window and allows it after', () => {
    const at = 1000;
    expect(offCooldown('thrust', at, at + COOLDOWN.thrust * 1000 - 1)).toBe(false);
    expect(offCooldown('thrust', at, at + COOLDOWN.thrust * 1000 + 1)).toBe(true);
  });

  it('allows the very first use of an action', () => {
    expect(offCooldown('slash', -Infinity, 0)).toBe(true);
  });

  it('stops alternating thrust and slash from dodging the cooldowns', () => {
    // Per-action cooldowns alone would let a player alternate forever. The
    // global attack lockout is what closes that hole.
    const thrustAt = 1000;
    const soonAfter = thrustAt + 100;
    expect(offCooldown('slash', -Infinity, soonAfter)).toBe(true);
    expect(offGlobalAttackCooldown(thrustAt, soonAfter)).toBe(false);
  });

  it('exposes the same numbers the client uses to grey out its UI', () => {
    expect(cooldownSeconds('dodge')).toBe(COOLDOWN.dodge);
  });
});
