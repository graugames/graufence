import { describe, expect, it } from 'vitest';
import {
  calibrationFromLandmarks,
  emptyPoseFrame,
  PoseNormalizer,
} from '../src/pose.js';
import { POSE } from '../src/constants.js';
import { hold, makeLandmarks, makeLowConfidenceLandmarks, makeTinyLandmarks, playSequence } from './helpers.js';

describe('calibrationFromLandmarks', () => {
  it('reads the neutral origin and scale off a good frame', () => {
    const cal = calibrationFromLandmarks(makeLandmarks({ cx: 0.4, cy: 0.55, width: 0.3 }), 'right');
    expect(cal).not.toBeNull();
    expect(cal!.origin.x).toBeCloseTo(0.4, 2);
    expect(cal!.origin.y).toBeCloseTo(0.55, 2);
    expect(cal!.scale).toBeCloseTo(0.3, 2);
    expect(cal!.handedness).toBe('right');
  });

  it('refuses a low-confidence frame', () => {
    expect(calibrationFromLandmarks(makeLowConfidenceLandmarks(), 'right')).toBeNull();
  });

  it('refuses a body that is a speck in frame', () => {
    // Calibrating off this would bake landmark noise into every threshold.
    expect(calibrationFromLandmarks(makeTinyLandmarks(), 'right')).toBeNull();
  });

  it('refuses an empty landmark set', () => {
    expect(calibrationFromLandmarks([], 'right')).toBeNull();
  });
});

describe('PoseNormalizer', () => {
  const calibrate = (opts = {}) => {
    const lm = makeLandmarks(opts);
    const cal = calibrationFromLandmarks(lm, 'right')!;
    return new PoseNormalizer({ calibration: cal, recenterPerSecond: 0 });
  };

  it('puts the hips at the origin when the player stands neutral', () => {
    const n = calibrate();
    const frames = playSequence(hold({}, 6), (lm, t) => n.process(lm, t));
    const last = frames[frames.length - 1]!;
    expect(last.hips.x).toBeCloseTo(0, 1);
    expect(last.hips.y).toBeCloseTo(0, 1);
    expect(last.valid).toBe(true);
  });

  it('reports the same body units regardless of distance from the camera', () => {
    // The identical pose, once filling the frame and once far away. If these
    // disagree, every gesture threshold in the game is camera-dependent.
    const near = calibrate({ width: 0.4 });
    const far = calibrate({ width: 0.12 });
    const wrist = { x: 0.8, y: -0.6 };
    const a = playSequence(hold({ width: 0.4, wrist }, 8), (lm, t) => near.process(lm, t)).pop()!;
    const b = playSequence(hold({ width: 0.12, wrist }, 8), (lm, t) => far.process(lm, t)).pop()!;
    expect(a.wrist.x).toBeCloseTo(b.wrist.x, 1);
    expect(a.wrist.y).toBeCloseTo(b.wrist.y, 1);
  });

  it('mirrors so that positive x is the player own right hand side', () => {
    const n = calibrate();
    const out = playSequence(hold({ wrist: { x: 0.9, y: -0.4 } }, 8), (lm, t) =>
      n.process(lm, t),
    ).pop()!;
    expect(out.wrist.x).toBeGreaterThan(0.5);
  });

  it('flags frames below the confidence gate as invalid', () => {
    const n = calibrate();
    const frame = n.process(makeLowConfidenceLandmarks(), 1000);
    expect(frame.valid).toBe(false);
    expect(frame.confidence).toBeLessThan(POSE.minTrackingConfidence);
  });

  it('returns an empty frame when required landmarks are missing', () => {
    const n = calibrate();
    const frame = n.process([], 1000);
    expect(frame.valid).toBe(false);
    expect(frame.confidence).toBe(0);
  });

  it('switches arms with handedness', () => {
    const n = calibrate();
    const rightArm = playSequence(hold({ wrist: { x: 0.9, y: -0.4 } }, 6), (lm, t) =>
      n.process(lm, t),
    ).pop()!;
    n.setHandedness('left');
    const leftArm = playSequence(hold({ wrist: { x: 0.9, y: -0.4 } }, 6), (lm, t) =>
      n.process(lm, t),
    ).pop()!;
    // The mock puts the off hand out to the player's left, so flipping
    // handedness must move the tracked wrist to the other side of the body.
    expect(rightArm.wrist.x).toBeGreaterThan(0);
    expect(leftArm.wrist.x).toBeLessThan(0);
    expect(leftArm.handedness).toBe('left');
  });

  it('slowly re-centres on a player who resettles, without eating a dodge', () => {
    // Standing a third of a body-width left for two seconds should decay
    // toward neutral; the same displacement over 200 ms should not.
    const drifting = new PoseNormalizer({
      calibration: calibrationFromLandmarks(makeLandmarks(), 'right')!,
      recenterPerSecond: 0.5,
    });
    const shifted = { cx: 0.5 + 0.22 * 0.35 };
    const quick = playSequence(hold(shifted, 5), (lm, t) => drifting.process(lm, t)).pop()!;
    const settled = playSequence(hold(shifted, 60), (lm, t) => drifting.process(lm, t), {
      startAt: 1200,
    }).pop()!;
    expect(Math.abs(quick.hips.x)).toBeGreaterThan(Math.abs(settled.hips.x));
  });

  it('reads a wrist moving toward the camera as negative depth change', () => {
    const n = calibrate();
    const frames = playSequence(
      [
        { wristZ: 0 },
        { wristZ: -0.02 },
        { wristZ: -0.05 },
        { wristZ: -0.09 },
      ],
      (lm, t) => n.process(lm, t),
    );
    expect(frames[3]!.wristDepth).toBeLessThan(frames[0]!.wristDepth);
  });
});

describe('emptyPoseFrame', () => {
  it('is inert but structurally complete', () => {
    const f = emptyPoseFrame(123, 'left');
    expect(f.valid).toBe(false);
    expect(f.confidence).toBe(0);
    expect(f.handedness).toBe('left');
    expect(f.offWrist).toBeNull();
    expect(f.offElbow).toBeNull();
    expect(Number.isFinite(f.wrist.x)).toBe(true);
  });
});
