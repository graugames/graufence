/**
 * The practice opponent.
 *
 * Not an AI - a metronome with opinions. Its job is to let someone calibrate
 * their camera and learn what a thrust feels like without needing a second
 * person, so it has to be readable above all: it telegraphs, it pauses, and it
 * punishes standing still without ever being unfair.
 *
 * It plays through exactly the same `submitAction` door as a human, so it is
 * bound by the same cooldowns, stamina and validation.
 */

import type { ActionInput, HitZone, MatchEngine, Slot } from '@graufence/shared';
import { HIT_ZONES } from '@graufence/shared';

export type BotDifficulty = 'gentle' | 'even' | 'sharp';

interface Tuning {
  /** Seconds between decisions. */
  interval: number;
  /** Chance of answering an incoming attack with a parry. */
  parryChance: number;
  /** Chance of dodging instead. */
  dodgeChance: number;
  /** Chance of guarding the line it expects to be attacked on. */
  guardChance: number;
}

const TUNING: Record<BotDifficulty, Tuning> = {
  gentle: { interval: 1.9, parryChance: 0.1, dodgeChance: 0.12, guardChance: 0.35 },
  even: { interval: 1.35, parryChance: 0.28, dodgeChance: 0.22, guardChance: 0.6 },
  sharp: { interval: 0.95, parryChance: 0.45, dodgeChance: 0.3, guardChance: 0.8 },
};

export class PracticeBot {
  private nextDecisionAt = 0;
  private guard: HitZone = 'head';
  private handledAttacks = new Set<number>();

  constructor(
    private slot: Slot,
    private difficulty: BotDifficulty = 'even',
    private rng: () => number = Math.random,
  ) {}

  setDifficulty(d: BotDifficulty): void {
    this.difficulty = d;
  }

  get currentGuard(): HitZone {
    return this.guard;
  }

  /** Blade angle to render, derived from whatever line it is holding. */
  get bladeAngle(): number {
    return { head: 90, left: 165, right: 12, torso: -90 }[this.guard];
  }

  /** Called once per frame with the engine it is playing in. */
  update(engine: MatchEngine, now: number): void {
    const state = engine.state;
    if (state.phase !== 'live') {
      this.handledAttacks.clear();
      return;
    }
    const tuning = TUNING[this.difficulty];
    const me = state.players[this.slot];

    // React to anything already in the air before thinking about attacking.
    for (const attack of state.pending) {
      if (attack.attacker === this.slot || this.handledAttacks.has(attack.id)) continue;
      this.handledAttacks.add(attack.id);

      const roll = this.rng();
      // Parry timing is deliberately imperfect: it aims for the window rather
      // than hitting it exactly, so a good player can bait it.
      if (roll < tuning.parryChance) {
        const jitter = (this.rng() - 0.5) * 120;
        const at = attack.landsAt - 40 + jitter;
        if (at > now) {
          setTimeoutSafe(() => engine.submitAction(this.slot, { kind: 'parry' }, Date.now()), at - now);
        }
      } else if (roll < tuning.parryChance + tuning.dodgeChance) {
        // Never dodge into the line being attacked - that is the player's trap
        // to fall for, not the bot's.
        const away = attack.zone === 'right' ? 'left' : 'right';
        engine.submitAction(this.slot, { kind: 'dodge', dodge: away }, now);
      } else if (this.rng() < tuning.guardChance) {
        this.guard = attack.zone;
      }
      engine.setDefence(this.slot, this.guard, this.bladeAngle);
    }

    if (now < this.nextDecisionAt) return;
    this.nextDecisionAt = now + tuning.interval * 1000 * (0.75 + this.rng() * 0.5);

    // Do not attack on fumes; being caught empty is worse than waiting.
    if (me.stamina < 40) {
      this.guard = pick(this.rng, HIT_ZONES);
      engine.setDefence(this.slot, this.guard, this.bladeAngle);
      return;
    }

    const zone = pick(this.rng, HIT_ZONES);
    const action: ActionInput =
      this.rng() < 0.55
        ? { kind: 'thrust', zone }
        : { kind: 'slash', zone, slash: this.rng() < 0.5 ? 'lr' : 'rl' };
    engine.submitAction(this.slot, action, now);
    this.guard = zone;
    engine.setDefence(this.slot, this.guard, this.bladeAngle);
  }
}

function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length) % list.length]!;
}

/** setTimeout that never throws in a torn-down page. */
function setTimeoutSafe(fn: () => void, ms: number): void {
  if (ms <= 0 || ms > 5000) return;
  setTimeout(() => {
    try {
      fn();
    } catch {
      // The match may have ended while this was queued; nothing to do.
    }
  }, ms);
}
