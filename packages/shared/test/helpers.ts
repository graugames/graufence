/**
 * Mock pose data.
 *
 * Every gesture test in this suite runs off synthetic landmarks rather than a
 * camera: `npm test` has to pass on CI, on a laptop with the lid shut, and for
 * anyone who cloned the repo and has not granted webcam permission.
 *
 * The generators here produce landmark sets in the same shape MediaPipe emits
 * (image-normalized x/y, a relative z, a visibility score), so the code under
 * test is the real pipeline - normalizer included - not a stub of it.
 */

import { LM } from '../src/pose.js';
import type { Landmark } from '../src/pose.js';

export interface BodyOptions {
  /** Centre of the body in image space. */
  cx?: number;
  cy?: number;
  /** Shoulder width in image units. */
  width?: number;
  /** Dominant wrist position, in body units relative to the hip centre. */
  wrist?: { x: number; y: number };
  /** Elbow position, in body units. Defaults to a sensible bend. */
  elbow?: { x: number; y: number };
  /** Wrist depth (MediaPipe z). Negative is toward the camera. */
  wristZ?: number;
  visibility?: number;
}

/**
 * Builds a 33-landmark array for a body standing at `cx`, with the dominant
 * (right) arm placed where the caller asks.
 *
 * Body units in, image units out - the inverse of what PoseNormalizer does, so
 * a test can say "wrist half a shoulder-width to the right" and trust that the
 * pipeline sees exactly that.
 */
export function makeLandmarks(opts: BodyOptions = {}): Landmark[] {
  const {
    cx = 0.5,
    cy = 0.6,
    width = 0.22,
    wrist = { x: 0.5, y: -0.4 },
    elbow,
    wristZ = 0,
    visibility = 0.95,
  } = opts;

  const lm: Landmark[] = Array.from({ length: 33 }, () => ({
    x: cx,
    y: cy,
    z: 0,
    visibility,
  }));

  const toImage = (bx: number, by: number) => ({
    // The normalizer mirrors x, so a positive body-x (the player's right) maps
    // to a *smaller* image x. Inverting that here keeps the round trip honest.
    x: cx - bx * width,
    y: cy + by * width,
  });

  const put = (i: number, bx: number, by: number, z = 0) => {
    const p = toImage(bx, by);
    lm[i] = { x: p.x, y: p.y, z, visibility };
  };

  // Shoulders one shoulder-width apart, a shoulder-width above the hips.
  put(LM.rightShoulder, 0.5, -1.0);
  put(LM.leftShoulder, -0.5, -1.0);
  put(LM.rightHip, 0.35, 0);
  put(LM.leftHip, -0.35, 0);
  put(LM.nose, 0, -1.5);
  put(LM.leftWrist, -0.6, -0.4);
  put(LM.leftElbow, -0.55, -0.7);

  const el = elbow ?? { x: wrist.x - 0.05, y: wrist.y + 0.45 };
  put(LM.rightElbow, el.x, el.y);
  put(LM.rightWrist, wrist.x, wrist.y, wristZ);

  return lm;
}

/** Landmarks with every visibility score below the confidence gate. */
export function makeLowConfidenceLandmarks(): Landmark[] {
  return makeLandmarks({ visibility: 0.1 });
}

/** A body so small in frame that calibration should refuse it. */
export function makeTinyLandmarks(): Landmark[] {
  return makeLandmarks({ width: 0.01 });
}

/**
 * Plays a sequence of poses through a callback at a fixed frame rate.
 * @param frames body options per frame
 * @param fn receives (landmarks, timestampMs)
 */
export function playSequence<T>(
  frames: BodyOptions[],
  fn: (lm: Landmark[], t: number) => T,
  { fps = 25, startAt = 1000 }: { fps?: number; startAt?: number } = {},
): T[] {
  const step = 1000 / fps;
  return frames.map((f, i) => fn(makeLandmarks(f), startAt + i * step));
}

/** Linear ramp of `n` frames between two body option snapshots. */
export function ramp(
  from: BodyOptions,
  to: BodyOptions,
  n: number,
): BodyOptions[] {
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 1 : i / (n - 1);
    return {
      cx: lerp(from.cx ?? 0.5, to.cx ?? 0.5, t),
      cy: lerp(from.cy ?? 0.6, to.cy ?? 0.6, t),
      width: lerp(from.width ?? 0.22, to.width ?? 0.22, t),
      wristZ: lerp(from.wristZ ?? 0, to.wristZ ?? 0, t),
      visibility: lerp(from.visibility ?? 0.95, to.visibility ?? 0.95, t),
      wrist: {
        x: lerp(from.wrist?.x ?? 0.5, to.wrist?.x ?? 0.5, t),
        y: lerp(from.wrist?.y ?? -0.4, to.wrist?.y ?? -0.4, t),
      },
      ...(from.elbow || to.elbow
        ? {
            elbow: {
              x: lerp(from.elbow?.x ?? 0.45, to.elbow?.x ?? 0.45, t),
              y: lerp(from.elbow?.y ?? 0.05, to.elbow?.y ?? 0.05, t),
            },
          }
        : {}),
    };
  });
}

/** Repeats one pose for `n` frames - a body holding still. */
export function hold(pose: BodyOptions, n: number): BodyOptions[] {
  return Array.from({ length: n }, () => ({ ...pose }));
}
