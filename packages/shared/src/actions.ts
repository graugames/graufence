/**
 * Gesture classification: clean pose frames in, fencing actions out.
 *
 * Everything is expressed in body units per second (1.0 = one shoulder width
 * per second), which is what lets one set of thresholds work across cameras,
 * distances and body sizes.
 *
 * The detector is deliberately conservative. A false positive in fencing is
 * worse than a missed input: an attack that fires because someone scratched
 * their nose spends stamina, starts a cooldown and leaves them open. So every
 * trigger requires (a) enough tracking confidence, (b) speed over a threshold,
 * and (c) that the motion is *mostly* along the axis of the action being
 * claimed - a wave that is half forward and half sideways is neither.
 */

import type { PoseFrame, Handedness } from './pose.js';
import type { Sword, Vec2 } from './vector.js';
import { angleDelta, clamp, computeSword, normalizeAngle, sub } from './vector.js';
import { AngleSmoother } from './filter.js';
import { COOLDOWN, GESTURE, POSE } from './constants.js';

/** The four places a punch can land (and a forearm can cover). */
export type HitZone = 'head' | 'torso' | 'left' | 'right';

export const HIT_ZONES: readonly HitZone[] = ['head', 'torso', 'left', 'right'];

export type AttackKind = 'thrust' | 'slash';
export type SlashDirection = 'lr' | 'rl';
export type DodgeDirection = 'left' | 'right';

export interface DetectedAction {
  kind: 'thrust' | 'slash' | 'parry' | 'dodge';
  /** Milliseconds, on the same clock as the pose frames. */
  t: number;
  /** Zone the attack is aimed at. Attacks only. */
  zone?: HitZone;
  /** Sweep direction for slashes. */
  slash?: SlashDirection;
  /** Side moved to for dodges. */
  dodge?: DodgeDirection;
  /** Tracking confidence at the moment of the trigger, 0..1. */
  confidence: number;
}

/** Continuous per-frame readout, separate from the discrete action events. */
export interface DetectorState {
  blade: Sword;
  /** Smoothed blade angle in degrees (90 = straight up). */
  bladeAngle: number;
  /** Signed blade angular speed, deg/s. Positive = counter-clockwise. */
  bladeAngularSpeed: number;
  /** Zone currently protected, or null when the blade is not held steady. */
  guardZone: HitZone | null;
  /** Wrist velocity in body units/second. */
  wristVelocity: Vec2;
  /** Forward (toward camera) wrist speed, body units/second. Positive = in. */
  forwardSpeed: number;
  /** Lateral hip offset from the calibrated neutral, in body units. */
  hipOffset: number;
  confidence: number;
  tracking: boolean;
  /** Set once tracking has been poor for a while - the UI nags on this. */
  lostTracking: boolean;
}

/**
 * Blade angle -> the zone that blade covers.
 *
 * Body space puts +x on the player's own right and 90 degrees straight up, so
 * the sectors read exactly as they look on screen:
 *
 *        head (55..125)
 *   left            right
 * (125..210)       (-30..55)
 *        torso (-150..-30, blade low)
 *
 * The same mapping is used for guarding and for aiming, which is the whole
 * mind-game: your blade cannot cover a line and threaten another at once.
 */
export function zoneForAngle(angleDeg: number): HitZone {
  const a = normalizeAngle(angleDeg);
  if (a >= 55 && a <= 125) return 'head';
  if (a > 125 || a <= -150) return 'left';
  if (a > -30 && a < 55) return 'right';
  return 'torso';
}

/** Centre angle of each zone's sector, for rendering guard indicators. */
export const ZONE_CENTER_ANGLE: Record<HitZone, number> = {
  head: 90,
  left: 165,
  right: 12,
  torso: -90,
};

/** Maps a normalized hand position to the body line it occupies in boxing. */
export function boxingZoneForHand(hand: Vec2): HitZone {
  if (hand.y < -0.72 && Math.abs(hand.x) < 0.95) return 'head';
  if (hand.y > -0.12 && Math.abs(hand.x) < 0.9) return 'torso';
  return hand.x < 0 ? 'left' : 'right';
}

/**
 * A block is physical: one of the player's forearms has to be parked on a
 * line. A moving punch does not count as a block, and an arm hanging in the
 * neutral pocket leaves the body open.
 */
export function boxingGuardForPose(frame: PoseFrame, movingSpeed: number): HitZone | null {
  if (movingSpeed >= 1.2) return null;
  const hands = [frame.wrist, frame.offWrist].filter((hand): hand is Vec2 => hand !== null);
  for (const hand of hands) {
    if (hand.y < -0.72 || hand.y > -0.12 || Math.abs(hand.x) > 0.25) {
      return boxingZoneForHand(hand);
    }
  }
  return null;
}

export interface DetectorOptions {
  handedness?: Handedness;
  /** Scales every speed threshold. >1 = harder to trigger. */
  sensitivity?: number;
}

interface Sample {
  t: number;
  wrist: Vec2;
  hips: Vec2;
  depth: number;
  armExtension: number;
  armStraightness: number;
}

const HISTORY = 8;

export class ActionDetector {
  private history: Sample[] = [];
  private angle = new AngleSmoother(0.4);
  private lowConfidenceFrames = 0;
  /** Timestamp at which the current run of good tracking began, 0 if none. */
  private trackingSince = 0;
  private lastFire: Record<DetectedAction['kind'], number> = {
    thrust: -Infinity,
    slash: -Infinity,
    parry: -Infinity,
    dodge: -Infinity,
  };
  private lastAnyAttack = -Infinity;
  /** Guard has to be *held*: this is when the blade last entered its sector. */
  private guardSince = 0;
  private guardCandidate: HitZone | null = null;
  /** A straight punch must reset before another one can be recognized. */
  private punchArmed = true;
  private sensitivity: number;

  state: DetectorState;

  constructor(opts: DetectorOptions = {}) {
    this.sensitivity = opts.sensitivity ?? 1;
    this.state = {
      blade: computeSword({ x: 0, y: 0 }, { x: 0, y: 0.4 }, POSE.swordExtension),
      bladeAngle: 90,
      bladeAngularSpeed: 0,
      guardZone: null,
      wristVelocity: { x: 0, y: 0 },
      forwardSpeed: 0,
      hipOffset: 0,
      confidence: 0,
      tracking: false,
      lostTracking: false,
    };
  }

  setSensitivity(s: number): void {
    this.sensitivity = clamp(s, 0.4, 2.5);
  }

  reset(): void {
    this.history = [];
    this.angle.reset();
    this.lowConfidenceFrames = 0;
    this.trackingSince = 0;
    this.guardCandidate = null;
    this.punchArmed = true;
    for (const k of Object.keys(this.lastFire) as DetectedAction['kind'][]) {
      this.lastFire[k] = -Infinity;
    }
    this.lastAnyAttack = -Infinity;
  }

  /** Average velocity over the history window, in units/second. */
  private velocity(pick: (s: Sample) => number, windowMs = 120): number {
    if (this.history.length < 2) return 0;
    const last = this.history[this.history.length - 1]!;
    // Walk back to the oldest sample still inside the window. Averaging over a
    // window instead of differencing two frames means one dropped frame or one
    // noisy landmark cannot fake an attack.
    let first = last;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const s = this.history[i]!;
      if (last.t - s.t > windowMs) break;
      first = s;
    }
    const dt = (last.t - first.t) / 1000;
    if (dt < 1e-3) return 0;
    return (pick(last) - pick(first)) / dt;
  }

  /**
   * True once tracking has been good for long enough to trust motion.
   *
   * When a player steps back into frame, the very first good landmark set is an
   * enormous jump away from the last one. Clearing history stops that jump
   * being *measured*, but the frame right after it would still produce a
   * hundred-body-widths-per-second velocity. Requiring a few consecutive good
   * frames is what actually stops "walked back to the desk" from landing a hit.
   */
  private warmedUp(t: number): boolean {
    return (
      this.history.length >= POSE.warmupFrames &&
      this.trackingSince > 0 &&
      t - this.trackingSince >= POSE.warmupMs
    );
  }

  private canFire(kind: DetectedAction['kind'], t: number): boolean {
    if (!this.warmedUp(t)) return false;
    const cd = COOLDOWN[kind] * 1000;
    if (t - this.lastFire[kind] < cd) return false;
    if ((kind === 'thrust' || kind === 'slash') &&
        t - this.lastAnyAttack < COOLDOWN.globalAttack * 1000) {
      return false;
    }
    return true;
  }

  private fire(a: DetectedAction, out: DetectedAction[]): void {
    this.lastFire[a.kind] = a.t;
    if (a.kind === 'thrust' || a.kind === 'slash') this.lastAnyAttack = a.t;
    out.push(a);
  }

  /**
   * Feed one pose frame.
   * @returns the actions triggered by this frame (usually none).
   */
  update(frame: PoseFrame): DetectedAction[] {
    const out: DetectedAction[] = [];
    const t = frame.t;

    // ---- confidence gating -------------------------------------------------
    // Low-confidence frames still update the "are we tracking" story, but they
    // never reach the trigger logic, and they wipe the motion history so that
    // the jump back into frame is not read as a lightning-fast slash.
    if (!frame.valid || frame.confidence < POSE.minTrackingConfidence) {
      this.lowConfidenceFrames++;
      this.history.length = 0;
      this.trackingSince = 0;
      this.guardCandidate = null;
      this.punchArmed = true;
      this.state = {
        ...this.state,
        confidence: frame.confidence,
        tracking: false,
        lostTracking: this.lowConfidenceFrames >= POSE.lostTrackingFrames,
        guardZone: null,
      };
      return out;
    }
    this.lowConfidenceFrames = 0;
    if (this.trackingSince === 0) this.trackingSince = t;

    // ---- blade -------------------------------------------------------------
    const blade = computeSword(
      frame.wrist,
      frame.elbow,
      POSE.swordExtension,
      this.angle.current,
    );
    const bladeAngle = this.angle.push(blade.angle, t);
    const angularSpeed = this.angle.angularVelocity;

    this.history.push({
      t,
      wrist: frame.wrist,
      hips: frame.hips,
      depth: frame.wristDepth,
      armExtension: frame.armExtension,
      armStraightness: frame.armStraightness,
    });
    if (this.history.length > HISTORY) this.history.shift();

    const vx = this.velocity((s) => s.wrist.x);
    const vy = this.velocity((s) => s.wrist.y);
    // wristDepth is negative toward the camera, so a *decrease* is forward.
    // A projected arm getting longer is a useful secondary signal when the
    // model's z estimate jitters. It is deliberately an assist, not a second
    // attack path: a lateral reach still has to be fast and mostly forward.
    const depthForwardSpeed = -this.velocity((s) => s.depth);
    const extensionSpeed = this.velocity((s) => s.armExtension);
    const forwardSpeed =
      depthForwardSpeed + Math.max(0, extensionSpeed) * GESTURE.punchExtensionAssist;
    const hipVx = this.velocity((s) => s.hips.x);
    const hipOffset = frame.hips.x;

    const lateral = Math.abs(vx);
    const planar = Math.hypot(vx, vy);
    const total = Math.hypot(planar, Math.abs(forwardSpeed));

    const punchZone = boxingZoneForHand(frame.wrist);
    const k = this.sensitivity;

    // ---- guard -------------------------------------------------------------
    // A guard is a blade held still inside a sector, not merely a blade that
    // passed through one. Requiring both a steady angle and a short dwell
    // stops a slash's follow-through from counting as a free block.
    let guardZone: HitZone | null = null;
    const heldBoxingZone = boxingGuardForPose(frame, planar);
    if (Math.abs(angularSpeed) <= GESTURE.guardMaxAngularSpeed * k && heldBoxingZone !== null) {
      if (this.guardCandidate !== heldBoxingZone) {
        this.guardCandidate = heldBoxingZone;
        this.guardSince = t;
      }
      if (t - this.guardSince >= 90) guardZone = heldBoxingZone;
    } else {
      this.guardCandidate = null;
    }

    // ---- thrust ------------------------------------------------------------
    // Forward wrist travel that dominates the motion, with the body committing
    // behind it. The body-assist term is what separates a thrust from simply
    // reaching out to adjust the webcam.
    const forwardRatio = total > 1e-3 ? Math.abs(forwardSpeed) / total : 0;
    const bodyCommit =
      Math.max(0, extensionSpeed) * GESTURE.punchExtensionAssist +
      Math.max(0, depthForwardSpeed) * 0.5;

    if (!this.punchArmed && forwardSpeed <= GESTURE.punchResetSpeed) {
      this.punchArmed = true;
    }

    if (
      forwardSpeed >= GESTURE.thrustWristSpeed * k &&
      forwardRatio >= GESTURE.thrustForwardRatio &&
      bodyCommit >= GESTURE.thrustBodyAssist * k &&
      (frame.armStraightness >= GESTURE.punchMinStraightness ||
        forwardSpeed >= GESTURE.thrustWristSpeed * k * 1.15) &&
      this.punchArmed &&
      this.canFire('thrust', t)
    ) {
      this.fire({ kind: 'thrust', t, zone: punchZone, confidence: frame.confidence }, out);
      this.punchArmed = false;
    }

    // ---- slash -------------------------------------------------------------
    // Fast travel across the body. Direction is named from the player's own
    // point of view: "lr" sweeps from their left toward their right.
    const lateralRatio = total > 1e-3 ? lateral / total : 0;
    if (
      lateral >= GESTURE.slashWristSpeed * k &&
      lateralRatio >= GESTURE.slashLateralRatio &&
      this.canFire('slash', t)
    ) {
      this.fire(
        {
          kind: 'slash',
          t,
          zone: punchZone,
          slash: vx > 0 ? 'lr' : 'rl',
          confidence: frame.confidence,
        },
        out,
      );
    }

    // ---- dodge -------------------------------------------------------------
    // Torso displacement, not a step: the hips must both be *away* from
    // neutral and still moving, so leaning back does not re-trigger forever.
    if (
      Math.abs(hipOffset) >= GESTURE.dodgeHipOffset * k &&
      Math.abs(hipVx) >= GESTURE.dodgeHipSpeed * k &&
      Math.sign(hipVx) === Math.sign(hipOffset) &&
      this.canFire('dodge', t)
    ) {
      this.fire(
        {
          kind: 'dodge',
          t,
          dodge: hipOffset > 0 ? 'right' : 'left',
          confidence: frame.confidence,
        },
        out,
      );
    }

    // ---- parry -------------------------------------------------------------
    // A deliberate sweep of the blade across the line. Checked last and only
    // when nothing else fired, and not during the follow-through of the
    // player's own swing: a slash rotates the forearm hard enough to clear this
    // threshold too, and one motion must not be both a swing and a block.
    //
    // This only reports the *gesture*. Whether it actually cancels anything is
    // the match engine's call, since only the server knows what is incoming.
    if (
      out.length === 0 &&
      t - this.lastAnyAttack >= GESTURE.parryLockoutAfterAttackMs &&
      Math.abs(angularSpeed) >= GESTURE.parryAngularSpeed * k &&
      this.canFire('parry', t)
    ) {
      this.fire({ kind: 'parry', t, confidence: frame.confidence }, out);
    }

    this.state = {
      blade,
      bladeAngle,
      bladeAngularSpeed: angularSpeed,
      guardZone,
      wristVelocity: { x: vx, y: vy },
      forwardSpeed,
      hipOffset,
      confidence: frame.confidence,
      tracking: true,
      lostTracking: false,
    };

    return out;
  }
}

/**
 * How well a blade at `bladeAngle` covers `zone`, 0..1.
 * Used for partial-guard credit and for drawing the guard arc.
 */
export function guardCoverage(bladeAngle: number, zone: HitZone): number {
  const off = Math.abs(angleDelta(ZONE_CENTER_ANGLE[zone], bladeAngle));
  return clamp(1 - off / (GESTURE.guardSectorHalfWidthDeg * 2), 0, 1);
}

/** Convenience for tests and the keyboard fallback: a blade at a fixed angle. */
export function bladeAtAngle(angleDeg: number, origin: Vec2 = { x: 0.35, y: -0.2 }): Sword {
  const elbow = sub(origin, {
    x: Math.cos((angleDeg * Math.PI) / 180) * 0.4,
    y: -Math.sin((angleDeg * Math.PI) / 180) * 0.4,
  });
  return computeSword(origin, elbow, POSE.swordExtension, angleDeg);
}
