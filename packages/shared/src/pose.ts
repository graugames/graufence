/**
 * Turning MediaPipe landmarks into something the game can reason about.
 *
 * Two problems have to be solved before a gesture threshold means anything:
 *
 *  1. Scale. A player sitting close to a laptop lid fills the frame; a player
 *     standing back does not. Raw normalized-image coordinates therefore say
 *     nothing about how far a hand actually moved. Everything here is divided
 *     by the player's own shoulder width, so "0.3" always means "a third of my
 *     own shoulders" no matter the camera.
 *
 *  2. Origin. Where the player stands in frame is arbitrary. Positions are
 *     expressed relative to a *calibrated* neutral hip centre, which is what
 *     makes a sideways dodge detectable as displacement rather than as "the
 *     player happens to stand left of centre".
 *
 * Coordinates keep the screen convention (+y downward). `angleOf` in
 * ./vector.ts is the single place the flip to "90 degrees is up" happens.
 */

import type { Vec2 } from './vector.js';
import { distance, midpoint, sub, scale as vscale, clamp } from './vector.js';
import { OneEuroVec2 } from './filter.js';
import { POSE } from './constants.js';

/** The MediaPipe Pose landmark indices this game actually uses. */
export const LM = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
} as const;

/** One landmark as MediaPipe reports it: image-normalized x/y, relative z. */
export interface Landmark {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

export type Handedness = 'right' | 'left';

/** Reference pose captured on the calibration screen. */
export interface Calibration {
  /** Neutral hip centre, in raw image-normalized coordinates. */
  origin: Vec2;
  /** Shoulder width in raw image-normalized units. Never zero. */
  scale: number;
  /** Blade angle the player holds at rest - their personal "guard centre". */
  restGuardAngle: number;
  handedness: Handedness;
}

export const DEFAULT_CALIBRATION: Calibration = {
  origin: { x: 0.5, y: 0.6 },
  scale: 0.22,
  restGuardAngle: 70,
  handedness: 'right',
};

/**
 * A pose reduced to the handful of quantities the game needs, all in body
 * units relative to the calibrated neutral. This is what gesture detection,
 * rendering and the network layer all consume.
 */
export interface PoseFrame {
  /** Timestamp in milliseconds (same clock as the filters). */
  t: number;
  handedness: Handedness;
  /** Mean visibility across the landmarks we depend on, 0..1. */
  confidence: number;
  /** False when required landmarks are missing or below confidence. */
  valid: boolean;

  /** Dominant-hand chain. */
  wrist: Vec2;
  elbow: Vec2;
  shoulder: Vec2;
  /** Off hand, when visible - used only for the avatar's second arm. */
  offWrist: Vec2 | null;
  /** Off elbow, when visible - keeps the remote arm's bend faithful. */
  offElbow: Vec2 | null;

  /** Lower-body points used to keep the remote fighter's stance connected. */
  leftKnee: Vec2 | null;
  rightKnee: Vec2 | null;
  leftAnkle: Vec2 | null;
  rightAnkle: Vec2 | null;

  /** Body reference points. */
  hips: Vec2;
  shoulders: Vec2;
  head: Vec2;

  /**
   * Depth of the wrist relative to the torso, in body units.
   * Negative means "toward the camera" - that is what a thrust looks like.
   */
  wristDepth: number;

  /** Shape of the tracked arm, useful for separating a punch from a reach. */
  armExtension: number;
  armStraightness: number;

  /** Raw shoulder width this frame, before normalization. Diagnostics only. */
  rawScale: number;
}

const vis = (l: Landmark | undefined): number => l?.visibility ?? 1;

const pt = (l: Landmark): Vec2 => ({ x: l.x, y: l.y });

/** An all-zero frame, used when tracking drops out entirely. */
export function emptyPoseFrame(t: number, handedness: Handedness): PoseFrame {
  return {
    t,
    handedness,
    confidence: 0,
    valid: false,
    wrist: { x: 0, y: 0 },
    elbow: { x: 0, y: 0 },
    shoulder: { x: 0, y: 0 },
    offWrist: null,
    offElbow: null,
    leftKnee: null,
    rightKnee: null,
    leftAnkle: null,
    rightAnkle: null,
    hips: { x: 0, y: 0 },
    shoulders: { x: 0, y: -1 },
    head: { x: 0, y: -1.4 },
    wristDepth: 0,
    armExtension: 0,
    armStraightness: 0,
    rawScale: 0,
  };
}

/**
 * Derives a calibration from a landmark set. Returns null when the shot is not
 * good enough to calibrate from - the calibration screen uses that to keep
 * saying "step back so your hips and shoulders are in frame".
 */
export function calibrationFromLandmarks(
  landmarks: readonly Landmark[],
  handedness: Handedness,
  restGuardAngle = DEFAULT_CALIBRATION.restGuardAngle,
): Calibration | null {
  const ls = landmarks[LM.leftShoulder];
  const rs = landmarks[LM.rightShoulder];
  const lh = landmarks[LM.leftHip];
  const rh = landmarks[LM.rightHip];
  if (!ls || !rs || !lh || !rh) return null;

  if ([ls, rs, lh, rh].some((l) => vis(l) < POSE.minLandmarkConfidence)) return null;

  const width = distance(pt(ls), pt(rs));
  // A shoulder width under ~4% of frame means the player is a speck: landmark
  // noise would be larger than the gestures we are trying to read.
  if (!Number.isFinite(width) || width < 0.04) return null;

  return {
    origin: midpoint(pt(lh), pt(rh)),
    scale: width,
    restGuardAngle,
    handedness,
  };
}

export interface NormalizerOptions {
  calibration?: Calibration;
  /**
   * How fast the neutral origin follows the player, in units/second. A player
   * who shuffles a step left should not read as permanently dodging, but a
   * real dodge (fast) must not be absorbed. Slow by design.
   */
  recenterPerSecond?: number;
  /** Mirror x, matching a mirrored ("selfie") camera preview. */
  mirror?: boolean;
}

/**
 * Stateful landmark -> PoseFrame converter: smoothing, confidence gating and
 * slow re-centering all live here, so the gesture detector downstream can be a
 * function of clean frames alone.
 */
export class PoseNormalizer {
  calibration: Calibration;
  mirror: boolean;
  private recenterPerSecond: number;
  private filters = new Map<string, OneEuroVec2>();
  private lastT = 0;
  private depthEma: number | null = null;

  constructor(opts: NormalizerOptions = {}) {
    this.calibration = opts.calibration ?? { ...DEFAULT_CALIBRATION };
    this.recenterPerSecond = opts.recenterPerSecond ?? 0.05;
    this.mirror = opts.mirror ?? true;
  }

  setCalibration(c: Calibration): void {
    this.calibration = c;
    this.reset();
  }

  setHandedness(h: Handedness): void {
    this.calibration = { ...this.calibration, handedness: h };
    this.reset();
  }

  reset(): void {
    for (const f of this.filters.values()) f.reset();
    this.filters.clear();
    this.depthEma = null;
    this.lastT = 0;
  }

  private smooth(key: string, p: Vec2, t: number): Vec2 {
    let f = this.filters.get(key);
    if (!f) {
      // Hips and shoulders are large, well-supported landmarks: MediaPipe puts
      // them within a pixel or two frame to frame. Filtering them as hard as a
      // wrist would swallow most of a 200 ms dodge before it is ever measured,
      // so they get a much more responsive filter.
      const steady = key === 'hips' || key === 'shoulders';
      f = new OneEuroVec2({
        minCutoff: steady ? POSE.steadyFilterMinCutoff : POSE.filterMinCutoff,
        beta: steady ? POSE.steadyFilterBeta : POSE.filterBeta,
        dCutoff: POSE.filterDCutoff,
      });
      this.filters.set(key, f);
    }
    return f.filter(p, t);
  }

  /** Raw image point -> body units relative to the calibrated neutral. */
  private toBody(p: Vec2): Vec2 {
    const { origin, scale: s } = this.calibration;
    const x = (p.x - origin.x) / s;
    return { x: this.mirror ? -x : x, y: (p.y - origin.y) / s };
  }

  // A tiny EMA rather than a full 1-Euro: z is noisy, but we only ever compare
  // its rate of change against a threshold, so cheap smoothing is enough.
  private smoothDepth(z: number): number {
    if (!Number.isFinite(z)) return this.depthEma ?? 0;
    this.depthEma = this.depthEma === null ? z : this.depthEma + (z - this.depthEma) * 0.35;
    return this.depthEma;
  }

  /**
   * @param landmarks MediaPipe pose landmarks (33 entries) or an empty array.
   * @param t timestamp in milliseconds.
   */
  process(landmarks: readonly Landmark[], t: number): PoseFrame {
    const { handedness } = this.calibration;
    const right = handedness === 'right';

    const wristL = landmarks[right ? LM.rightWrist : LM.leftWrist];
    const elbowL = landmarks[right ? LM.rightElbow : LM.leftElbow];
    const shoulderL = landmarks[right ? LM.rightShoulder : LM.leftShoulder];
    const otherShoulderL = landmarks[right ? LM.leftShoulder : LM.rightShoulder];
    const offWristL = landmarks[right ? LM.leftWrist : LM.rightWrist];
    const offElbowL = landmarks[right ? LM.leftElbow : LM.rightElbow];
    const leftHipL = landmarks[LM.leftHip];
    const rightHipL = landmarks[LM.rightHip];
    const noseL = landmarks[LM.nose];
    const leftKneeL = landmarks[LM.leftKnee];
    const rightKneeL = landmarks[LM.rightKnee];
    const leftAnkleL = landmarks[LM.leftAnkle];
    const rightAnkleL = landmarks[LM.rightAnkle];

    if (
      !wristL || !elbowL || !shoulderL || !otherShoulderL || !leftHipL || !rightHipL
    ) {
      return emptyPoseFrame(t, handedness);
    }

    // Confidence gate. The dominant wrist is counted twice: a frame where the
    // hips are crisp but the sword hand is a guess must not arm an attack.
    const visScores = [
      vis(wristL),
      vis(wristL),
      vis(elbowL),
      vis(shoulderL),
      vis(otherShoulderL),
      vis(leftHipL),
      vis(rightHipL),
    ];
    // The off arm and head are not required to keep playing, but when they are
    // present they are useful confidence evidence for the articulated avatar.
    if (offWristL) visScores.push(vis(offWristL));
    if (offElbowL) visScores.push(vis(offElbowL));
    if (noseL) visScores.push(vis(noseL));
    const confidence = clamp(
      visScores.reduce((a, b) => a + b, 0) / visScores.length,
      0,
      1,
    );

    const rawShoulders = midpoint(pt(shoulderL), pt(otherShoulderL));
    const rawHips = midpoint(pt(leftHipL), pt(rightHipL));
    const rawScale = distance(pt(shoulderL), pt(otherShoulderL));

    // Slowly walk the calibrated origin toward where the player actually is.
    // Skipped while confidence is poor, so a bad frame cannot drag the neutral.
    if (this.lastT > 0 && confidence >= POSE.minTrackingConfidence) {
      const dt = clamp((t - this.lastT) / 1000, 0, 0.25);
      const k = clamp(this.recenterPerSecond * dt, 0, 0.5);
      this.calibration = {
        ...this.calibration,
        origin: {
          x: this.calibration.origin.x + (rawHips.x - this.calibration.origin.x) * k,
          y: this.calibration.origin.y + (rawHips.y - this.calibration.origin.y) * k,
        },
      };
    }
    this.lastT = t;

    const wrist = this.smooth('wrist', this.toBody(pt(wristL)), t);
    const elbow = this.smooth('elbow', this.toBody(pt(elbowL)), t);
    const shoulder = this.smooth('shoulder', this.toBody(pt(shoulderL)), t);
    const hips = this.smooth('hips', this.toBody(rawHips), t);
    const shoulders = this.smooth('shoulders', this.toBody(rawShoulders), t);

    const offWrist =
      offWristL && vis(offWristL) >= POSE.minLandmarkConfidence
        ? this.smooth('offWrist', this.toBody(pt(offWristL)), t)
        : null;
    const offElbow =
      offElbowL && vis(offElbowL) >= POSE.minLandmarkConfidence
        ? this.smooth('offElbow', this.toBody(pt(offElbowL)), t)
        : null;

    const optionalPoint = (key: string, landmark: Landmark | undefined): Vec2 | null =>
      landmark && vis(landmark) >= POSE.minLandmarkConfidence
        ? this.smooth(key, this.toBody(pt(landmark)), t)
        : null;

    const leftKnee = optionalPoint('leftKnee', leftKneeL);
    const rightKnee = optionalPoint('rightKnee', rightKneeL);
    const leftAnkle = optionalPoint('leftAnkle', leftAnkleL);
    const rightAnkle = optionalPoint('rightAnkle', rightAnkleL);

    const head =
      noseL && vis(noseL) >= POSE.minLandmarkConfidence
        ? this.smooth('head', this.toBody(pt(noseL)), t)
        : vscale(sub(shoulders, hips), 1.35);

    // MediaPipe's z is roughly "depth behind the hip centre", in the same
    // units as x. Referencing the wrist to the shoulder removes whole-body
    // drift and leaves arm extension - which is exactly the thrust signal.
    const rawDepth =
      this.calibration.scale > 1e-6
        ? ((wristL.z ?? 0) - (shoulderL.z ?? 0)) / this.calibration.scale
        : 0;

    const upperArm = distance(shoulder, elbow);
    const forearm = distance(elbow, wrist);
    const armReach = distance(shoulder, wrist);
    const armLength = Math.max(upperArm + forearm, 1e-3);

    return {
      t,
      handedness,
      confidence,
      valid: confidence >= POSE.minTrackingConfidence && rawScale >= 0.04,
      wrist,
      elbow,
      shoulder,
      offWrist,
      offElbow,
      leftKnee,
      rightKnee,
      leftAnkle,
      rightAnkle,
      hips,
      shoulders,
      head,
      wristDepth: this.smoothDepth(rawDepth),
      armExtension: clamp(armReach / armLength, 0, 1),
      armStraightness: clamp(armReach / armLength, 0, 1),
      rawScale,
    };
  }
}
