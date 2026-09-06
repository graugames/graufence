/**
 * Combat resolution: pure functions, no state, no clock of their own.
 *
 * The server calls these to decide what actually happened; the client calls the
 * exact same functions to predict what it is about to be told. Keeping them
 * pure is what makes that agreement possible - and what makes the whole damage
 * model testable without a socket, a camera or a running match.
 */

import type { AttackKind, HitZone, SlashDirection } from './actions.js';
import { guardCoverage } from './actions.js';
import { COOLDOWN, DAMAGE, STAMINA, TIMING, ZONE_DAMAGE } from './constants.js';
import { clamp, lerp } from './vector.js';

/** An attack in flight: thrown, not yet landed. */
export interface PendingAttack {
  id: number;
  /** Slot index of the attacker, 0 or 1. */
  attacker: 0 | 1;
  kind: AttackKind;
  zone: HitZone;
  slash?: SlashDirection;
  /** Milliseconds (server clock). */
  thrownAt: number;
  /** When the blade arrives, and therefore when it can be parried. */
  landsAt: number;
}

/** Everything about the defender that changes the outcome of one attack. */
export interface DefenceSnapshot {
  /** Zone the defender's blade is covering right now, if any. */
  guardZone: HitZone | null;
  /** Defender's blade angle in degrees, for partial-coverage credit. */
  bladeAngle: number;
  /** When the defender last threw a parry, or -Infinity. */
  lastParryAt: number;
  /** When the defender's current dodge started, or null if not dodging. */
  dodgeStartedAt: number | null;
  /** Side the defender dodged toward. */
  dodgeDirection: 'left' | 'right' | null;
}

export type HitOutcome = 'hit' | 'guarded' | 'dodged' | 'parried' | 'perfect_parry';

export interface HitResult {
  outcome: HitOutcome;
  zone: HitZone;
  /** Damage actually dealt, already rounded to a whole number. */
  damage: number;
  /** True when the attacker should be staggered (perfect parry riposte). */
  stagger: boolean;
  /** True when nothing was touched, so the attacker gets a stamina refund. */
  whiff: boolean;
}

/** Windup for each attack kind, in seconds. */
export function windupSeconds(kind: AttackKind): number {
  return kind === 'thrust' ? TIMING.thrustWindupSeconds : TIMING.slashWindupSeconds;
}

export function baseDamage(kind: AttackKind, zone: HitZone): number {
  const mult = kind === 'thrust' ? DAMAGE.thrustMultiplier : DAMAGE.slashMultiplier;
  return ZONE_DAMAGE[zone] * mult;
}

export function staminaCost(kind: 'thrust' | 'slash' | 'dodge'): number {
  if (kind === 'thrust') return STAMINA.thrustCost;
  if (kind === 'slash') return STAMINA.slashCost;
  return STAMINA.dodgeCost;
}

export function cooldownSeconds(kind: 'thrust' | 'slash' | 'dodge' | 'parry'): number {
  return COOLDOWN[kind];
}

/**
 * Decides what an attack does at the instant it lands.
 *
 * Precedence is parry > dodge > guard, cheapest-to-hardest last. A parry beats
 * a dodge because timing a blade onto an incoming line is the harder read and
 * should out-rank simply not being there.
 *
 * @param now the moment the attack lands (usually `attack.landsAt`).
 */
export function resolveAttack(
  attack: PendingAttack,
  defence: DefenceSnapshot,
  now: number,
): HitResult {
  const zone = attack.zone;
  const base = baseDamage(attack.kind, zone);

  // ---- parry --------------------------------------------------------------
  const sinceParry = Math.abs(now - defence.lastParryAt);
  if (Number.isFinite(defence.lastParryAt)) {
    if (sinceParry <= TIMING.perfectParryWindowSeconds * 1000) {
      return {
        outcome: 'perfect_parry',
        zone,
        damage: 0,
        stagger: true,
        whiff: false,
      };
    }
    if (sinceParry <= TIMING.parryWindowSeconds * 1000) {
      return {
        outcome: 'parried',
        zone,
        damage: Math.round(base * DAMAGE.parriedMultiplier),
        stagger: false,
        whiff: false,
      };
    }
  }

  // ---- dodge --------------------------------------------------------------
  // Moving out of the line works, with one catch: dodging *into* the attacked
  // side puts you exactly where the blade already is. That is the risk that
  // stops dodge from being a free answer to everything.
  if (defence.dodgeStartedAt !== null) {
    const elapsed = now - defence.dodgeStartedAt;
    const dodgedIntoIt =
      (defence.dodgeDirection === 'left' && zone === 'left') ||
      (defence.dodgeDirection === 'right' && zone === 'right');
    if (elapsed >= 0 && elapsed <= TIMING.dodgeInvulnSeconds * 1000 && !dodgedIntoIt) {
      return { outcome: 'dodged', zone, damage: 0, stagger: false, whiff: true };
    }
  }

  // ---- guard --------------------------------------------------------------
  if (defence.guardZone === zone) {
    // Partial credit: a blade parked dead-centre in the sector blocks far
    // better than one clinging to the sector's edge.
    const coverage = guardCoverage(defence.bladeAngle, zone);
    const mult = lerp(1, DAMAGE.guardedMultiplier, coverage);
    return {
      outcome: 'guarded',
      zone,
      damage: Math.max(DAMAGE.minimumChip, Math.round(base * mult)),
      stagger: false,
      whiff: false,
    };
  }

  return { outcome: 'hit', zone, damage: Math.round(base), stagger: false, whiff: false };
}

/**
 * Stamina regeneration over one tick.
 *
 * Regen is suppressed briefly after any spend, which is the actual anti-spam
 * mechanism: back-to-back attacks never let the bar start refilling.
 */
export function regenStamina(
  current: number,
  dtSeconds: number,
  lastSpendAt: number,
  now: number,
  guarding = false,
): number {
  let next = current;
  if (guarding) next -= STAMINA.guardDrainPerSecond * dtSeconds;

  // Credit only the slice of this tick that falls *after* the suppression
  // window. Crediting the whole tick would hand a laggy client - or a server
  // that just did a long GC - free stamina it never waited for, which is
  // exactly the hole the delay exists to close.
  const tickStart = now - dtSeconds * 1000;
  const regenFrom = Math.max(tickStart, lastSpendAt + STAMINA.regenDelaySeconds * 1000);
  const regenSeconds = clamp((now - regenFrom) / 1000, 0, dtSeconds);
  next += STAMINA.regenPerSecond * regenSeconds;

  return clamp(next, 0, 100);
}

export function canAfford(stamina: number, kind: 'thrust' | 'slash' | 'dodge'): boolean {
  return stamina >= Math.max(STAMINA.minToAttack, staminaCost(kind));
}

/**
 * Whether an action may be started, given the last time it was used.
 * The client uses this for greying out UI; the server uses it as a veto.
 */
export function offCooldown(
  kind: 'thrust' | 'slash' | 'dodge' | 'parry',
  lastAt: number,
  now: number,
): boolean {
  return now - lastAt >= cooldownSeconds(kind) * 1000;
}

/** Global attack lockout, shared by thrust and slash. */
export function offGlobalAttackCooldown(lastAttackAt: number, now: number): boolean {
  return now - lastAttackAt >= COOLDOWN.globalAttack * 1000;
}
