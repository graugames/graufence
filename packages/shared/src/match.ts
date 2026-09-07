/**
 * The match simulation.
 *
 * This is the authority. The server owns one instance per room and every health
 * point in the game comes out of it; the client runs the same class locally for
 * practice mode and for prediction, but never gets to tell the server a number.
 *
 * The engine has no clock and no timers - every entry point takes `now` in
 * milliseconds. That is what makes it deterministic: the same inputs at the
 * same timestamps always produce the same match, which is exactly what a test
 * needs and exactly what stops the two sides drifting apart.
 */

import type { AttackKind, HitZone, SlashDirection, DodgeDirection } from './actions.js';
import type { DefenceSnapshot, HitResult, PendingAttack } from './combat.js';
import {
  canAfford,
  offCooldown,
  offGlobalAttackCooldown,
  regenStamina,
  resolveAttack,
  staminaCost,
  windupSeconds,
} from './combat.js';
import { MATCH, TIMING } from './constants.js';
import { clamp } from './vector.js';

export type Slot = 0 | 1;
export const otherSlot = (s: Slot): Slot => (s === 0 ? 1 : 0);

export type MatchPhase =
  | 'lobby'
  | 'countdown'
  | 'live'
  | 'round_over'
  | 'match_over';

/** Compact pose readout mirrored to the opponent so their avatar can move. */
export interface PoseSnapshot {
  /** Dominant-hand angle in degrees, retained for the guard model. */
  a: number;
  /** Hip offset from neutral, body units. */
  h: number;
  /** Dominant wrist position, body units. */
  wx: number;
  wy: number;
  /** Dominant elbow position, body units. Optional for old room messages. */
  ex?: number;
  ey?: number;
  /** Off-hand position, body units. Optional for old room messages. */
  owx?: number;
  owy?: number;
  /** Off elbow position, body units. Optional for old room messages. */
  oex?: number;
  oey?: number;
  /** Head centre, shoulder centre, and hip centre. Optional for old rooms. */
  hx?: number;
  hy?: number;
  sx?: number;
  sy?: number;
  px?: number;
  py?: number;
  /** Knees and ankles keep the remote stance connected to the camera pose. */
  lkx?: number;
  lky?: number;
  rkx?: number;
  rky?: number;
  lax?: number;
  lay?: number;
  rax?: number;
  ray?: number;
  /** Tracking confidence 0..1. */
  c: number;
}

export interface PlayerState {
  slot: Slot;
  id: string;
  name: string;
  connected: boolean;
  ready: boolean;
  rematchWanted: boolean;
  health: number;
  stamina: number;
  roundsWon: number;

  guardZone: HitZone | null;
  bladeAngle: number;
  pose: PoseSnapshot | null;

  lastThrustAt: number;
  lastSlashAt: number;
  lastDodgeAt: number;
  lastParryAt: number;
  lastAttackAt: number;
  lastSpendAt: number;

  dodgeStartedAt: number | null;
  dodgeDirection: DodgeDirection | null;
  staggeredUntil: number;
}

export interface MatchState {
  phase: MatchPhase;
  /** 1-based round number. */
  round: number;
  /** When the current phase ends (countdown / inter-round). */
  phaseEndsAt: number;
  /** When the live round started, for the round clock. */
  roundStartedAt: number;
  players: [PlayerState, PlayerState];
  pending: PendingAttack[];
  roundWinner: Slot | null;
  matchWinner: Slot | null;
  /** Increments every state change; lets clients drop out-of-order updates. */
  seq: number;
  now: number;
}

export type RejectReason =
  | 'not_live'
  | 'cooldown'
  | 'stamina'
  | 'staggered'
  | 'disconnected'
  | 'malformed';

export type MatchEvent =
  | { type: 'countdown'; round: number; endsAt: number }
  | { type: 'round_start'; round: number }
  | { type: 'attack_thrown'; id: number; slot: Slot; kind: AttackKind; zone: HitZone; slash?: SlashDirection; landsAt: number }
  | { type: 'attack_resolved'; id: number; attacker: Slot; defender: Slot; result: HitResult }
  | { type: 'dodge'; slot: Slot; direction: DodgeDirection }
  | { type: 'parry'; slot: Slot }
  | { type: 'rejected'; slot: Slot; kind: string; reason: RejectReason }
  | { type: 'round_over'; round: number; winner: Slot | null; reason: 'health' | 'timeout' | 'forfeit' }
  | { type: 'match_over'; winner: Slot | null };

export interface PlayerSeed {
  id: string;
  name: string;
}

function makePlayer(slot: Slot, seed: PlayerSeed): PlayerState {
  return {
    slot,
    id: seed.id,
    name: seed.name,
    connected: true,
    ready: false,
    rematchWanted: false,
    health: MATCH.startingHealth,
    stamina: MATCH.startingStamina,
    roundsWon: 0,
    guardZone: null,
    bladeAngle: 90,
    pose: null,
    lastThrustAt: -Infinity,
    lastSlashAt: -Infinity,
    lastDodgeAt: -Infinity,
    lastParryAt: -Infinity,
    lastAttackAt: -Infinity,
    lastSpendAt: -Infinity,
    dodgeStartedAt: null,
    dodgeDirection: null,
    staggeredUntil: -Infinity,
  };
}

export interface ActionInput {
  kind: 'thrust' | 'slash' | 'parry' | 'dodge';
  zone?: HitZone;
  slash?: SlashDirection;
  dodge?: DodgeDirection;
}

export class MatchEngine {
  state: MatchState;
  private nextAttackId = 1;
  private lastTickAt: number;

  constructor(a: PlayerSeed, b: PlayerSeed, now = 0) {
    this.state = {
      phase: 'lobby',
      round: 0,
      phaseEndsAt: 0,
      roundStartedAt: 0,
      players: [makePlayer(0, a), makePlayer(1, b)],
      pending: [],
      roundWinner: null,
      matchWinner: null,
      seq: 0,
      now,
    };
    this.lastTickAt = now;
  }

  private player(slot: Slot): PlayerState {
    return this.state.players[slot];
  }

  private bump(): void {
    this.state.seq++;
  }

  // ------------------------------------------------------------------ lobby

  setReady(slot: Slot, ready: boolean): void {
    if (this.state.phase !== 'lobby') return;
    const player = this.player(slot);
    if (player.ready === ready) return;
    player.ready = ready;
    this.bump();
  }

  setConnected(slot: Slot, connected: boolean): void {
    const player = this.player(slot);
    if (player.connected === connected) return;
    player.connected = connected;
    this.bump();
  }

  bothReady(): boolean {
    return this.state.players.every((p) => p.ready && p.connected);
  }

  /** Starts round 1 (or the next round) with a countdown. */
  startCountdown(now: number): MatchEvent[] {
    const s = this.state;
    // Only a finished round advances the counter; anything else is round 1.
    s.round = s.phase === 'round_over' ? s.round + 1 : 1;
    s.phase = 'countdown';
    s.phaseEndsAt = now + MATCH.countdownSeconds * 1000;
    s.roundWinner = null;
    s.pending = [];
    for (const p of s.players) {
      p.health = MATCH.startingHealth;
      p.stamina = MATCH.startingStamina;
      p.dodgeStartedAt = null;
      p.dodgeDirection = null;
      p.staggeredUntil = -Infinity;
      p.lastThrustAt = -Infinity;
      p.lastSlashAt = -Infinity;
      p.lastDodgeAt = -Infinity;
      p.lastParryAt = -Infinity;
      p.lastAttackAt = -Infinity;
      p.lastSpendAt = -Infinity;
    }
    this.lastTickAt = now;
    this.bump();
    return [{ type: 'countdown', round: s.round, endsAt: s.phaseEndsAt }];
  }

  /** Wipes round wins and returns both players to the lobby for a rematch. */
  resetForRematch(): void {
    const s = this.state;
    s.phase = 'lobby';
    s.round = 0;
    s.roundWinner = null;
    s.matchWinner = null;
    s.pending = [];
    for (const p of s.players) {
      p.roundsWon = 0;
      p.ready = false;
      p.rematchWanted = false;
      p.health = MATCH.startingHealth;
      p.stamina = MATCH.startingStamina;
    }
    this.bump();
  }

  // ------------------------------------------------------------- continuous

  /** Guard and blade angle stream in every frame; they are never validated
   *  as "actions" because holding a blade somewhere costs nothing but stamina. */
  setDefence(slot: Slot, guardZone: HitZone | null, bladeAngle: number): void {
    const p = this.player(slot);
    p.guardZone = guardZone;
    p.bladeAngle = bladeAngle;
  }

  setPose(slot: Slot, pose: PoseSnapshot): void {
    this.player(slot).pose = pose;
  }

  // ----------------------------------------------------------- discrete acts

  /**
   * The one door every attack comes through - on the server this is the only
   * thing standing between a modified client and infinite damage.
   */
  submitAction(slot: Slot, action: ActionInput, now: number): MatchEvent[] {
    const s = this.state;
    const p = this.player(slot);
    const reject = (reason: RejectReason): MatchEvent[] => [
      { type: 'rejected', slot, kind: action.kind, reason },
    ];

    if (s.phase !== 'live') return reject('not_live');
    if (!p.connected) return reject('disconnected');
    if (now < p.staggeredUntil) return reject('staggered');

    switch (action.kind) {
      case 'parry': {
        if (!offCooldown('parry', p.lastParryAt, now)) return reject('cooldown');
        p.lastParryAt = now;
        this.bump();
        return [{ type: 'parry', slot }];
      }

      case 'dodge': {
        if (!offCooldown('dodge', p.lastDodgeAt, now)) return reject('cooldown');
        if (!canAfford(p.stamina, 'dodge')) return reject('stamina');
        p.lastDodgeAt = now;
        p.stamina = clamp(p.stamina - staminaCost('dodge'), 0, 100);
        p.lastSpendAt = now;
        p.dodgeStartedAt = now;
        p.dodgeDirection = action.dodge ?? 'left';
        this.bump();
        return [{ type: 'dodge', slot, direction: p.dodgeDirection }];
      }

      case 'thrust':
      case 'slash': {
        const kind: AttackKind = action.kind;
        const lastSame = kind === 'thrust' ? p.lastThrustAt : p.lastSlashAt;
        if (!offCooldown(kind, lastSame, now)) return reject('cooldown');
        if (!offGlobalAttackCooldown(p.lastAttackAt, now)) return reject('cooldown');
        if (!canAfford(p.stamina, kind)) return reject('stamina');

        p.stamina = clamp(p.stamina - staminaCost(kind), 0, 100);
        p.lastSpendAt = now;
        p.lastAttackAt = now;
        if (kind === 'thrust') p.lastThrustAt = now;
        else p.lastSlashAt = now;

        const attack: PendingAttack = {
          id: this.nextAttackId++,
          attacker: slot,
          kind,
          zone: action.zone ?? 'torso',
          ...(action.slash ? { slash: action.slash } : {}),
          thrownAt: now,
          landsAt: now + windupSeconds(kind) * 1000,
        };
        s.pending.push(attack);
        this.bump();
        return [
          {
            type: 'attack_thrown',
            id: attack.id,
            slot,
            kind,
            zone: attack.zone,
            ...(attack.slash ? { slash: attack.slash } : {}),
            landsAt: attack.landsAt,
          },
        ];
      }

      default:
        return reject('malformed');
    }
  }

  // ------------------------------------------------------------------- tick

  /** Advances the simulation to `now`. Safe to call at any rate. */
  tick(now: number): MatchEvent[] {
    const s = this.state;
    const events: MatchEvent[] = [];
    const dt = clamp((now - this.lastTickAt) / 1000, 0, 0.25);
    this.lastTickAt = now;
    s.now = now;

    // phase transitions ------------------------------------------------------
    if (s.phase === 'countdown' && now >= s.phaseEndsAt) {
      s.phase = 'live';
      s.roundStartedAt = now;
      this.bump();
      events.push({ type: 'round_start', round: s.round });
    }

    if (s.phase === 'round_over' && now >= s.phaseEndsAt) {
      if (s.matchWinner !== null) {
        s.phase = 'match_over';
        this.bump();
      } else {
        events.push(...this.startCountdown(now));
      }
    }

    if (s.phase !== 'live') return events;

    // stamina and expiring states -------------------------------------------
    for (const p of s.players) {
      const guarding = p.guardZone !== null;
      p.stamina = regenStamina(p.stamina, dt, p.lastSpendAt, now, guarding);
      if (
        p.dodgeStartedAt !== null &&
        now - p.dodgeStartedAt > TIMING.dodgeInvulnSeconds * 1000
      ) {
        p.dodgeStartedAt = null;
        p.dodgeDirection = null;
      }
    }

    // land attacks whose windup has elapsed ---------------------------------
    // Sorted so that two attacks landing in the same tick resolve in the order
    // they were actually thrown, not in arbitrary array order.
    const landed = s.pending.filter((a) => a.landsAt <= now).sort((x, y) => x.landsAt - y.landsAt);
    if (landed.length > 0) {
      s.pending = s.pending.filter((a) => a.landsAt > now);
      for (const attack of landed) {
        const defenderSlot = otherSlot(attack.attacker);
        const defender = this.player(defenderSlot);
        const attacker = this.player(attack.attacker);
        const result = resolveAttack(attack, snapshotDefence(defender), attack.landsAt);

        defender.health = clamp(defender.health - result.damage, 0, MATCH.startingHealth);
        if (result.stagger) {
          attacker.staggeredUntil = attack.landsAt + TIMING.staggerSeconds * 1000;
        }
        if (result.whiff) {
          // Small refund so a dodged attack is a lost tempo, not a lost round.
          attacker.stamina = clamp(
            attacker.stamina + staminaCost(attack.kind) * 0.25,
            0,
            100,
          );
        }
        events.push({
          type: 'attack_resolved',
          id: attack.id,
          attacker: attack.attacker,
          defender: defenderSlot,
          result,
        });
      }
      this.bump();
    }

    // round end --------------------------------------------------------------
    const dead = s.players.filter((p) => p.health <= 0);
    const timedOut = now - s.roundStartedAt >= MATCH.roundTimeLimitSeconds * 1000;

    if (dead.length > 0 || timedOut) {
      let winner: Slot | null = null;
      let reason: 'health' | 'timeout' = 'health';
      if (dead.length === 1) {
        winner = otherSlot(dead[0]!.slot);
      } else if (dead.length === 0 && timedOut) {
        reason = 'timeout';
        const [a, b] = s.players;
        winner = a.health === b.health ? null : a.health > b.health ? 0 : 1;
      }
      // dead.length === 2 (a double) leaves winner null: nobody takes the round.
      events.push(...this.endRound(winner, reason, now));
    }

    return events;
  }

  /** Ends the current round. Exposed so a disconnect can forfeit it. */
  endRound(
    winner: Slot | null,
    reason: 'health' | 'timeout' | 'forfeit',
    now: number,
  ): MatchEvent[] {
    const s = this.state;
    if (s.phase === 'round_over' || s.phase === 'match_over') return [];
    const events: MatchEvent[] = [];

    s.phase = 'round_over';
    s.roundWinner = winner;
    s.pending = [];
    s.phaseEndsAt = now + MATCH.interRoundSeconds * 1000;
    if (winner !== null) this.player(winner).roundsWon++;

    events.push({ type: 'round_over', round: s.round, winner, reason });

    const champion = s.players.find((p) => p.roundsWon >= MATCH.roundsToWin);
    const exhausted = s.round >= MATCH.maxRounds;
    if (champion) {
      s.matchWinner = champion.slot;
      events.push({ type: 'match_over', winner: champion.slot });
    } else if (exhausted) {
      const [a, b] = s.players;
      s.matchWinner = a.roundsWon === b.roundsWon ? null : a.roundsWon > b.roundsWon ? 0 : 1;
      events.push({ type: 'match_over', winner: s.matchWinner });
    }
    this.bump();
    return events;
  }

  /** A player left for good: the other one takes the match. */
  forfeit(slot: Slot, now: number): MatchEvent[] {
    const s = this.state;
    if (s.phase === 'match_over') return [];
    const winner = otherSlot(slot);
    const events = this.endRound(winner, 'forfeit', now);
    if (s.matchWinner === null) {
      s.matchWinner = winner;
      s.phase = 'match_over';
      this.bump();
      events.push({ type: 'match_over', winner });
    }
    return events;
  }
}

export function snapshotDefence(p: PlayerState): DefenceSnapshot {
  return {
    guardZone: p.guardZone,
    bladeAngle: p.bladeAngle,
    lastParryAt: p.lastParryAt,
    dodgeStartedAt: p.dodgeStartedAt,
    dodgeDirection: p.dodgeDirection,
  };
}
