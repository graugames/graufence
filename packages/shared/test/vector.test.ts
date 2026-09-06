import { describe, expect, it } from 'vitest';
import {
  angleBetween,
  angleDelta,
  angleOf,
  computeSword,
  distance,
  distanceToSegment,
  fromAngle,
  lerpAngle,
  meanAngle,
  normalize,
  normalizeAngle,
  segmentsIntersect,
} from '../src/vector.js';
import { POSE } from '../src/constants.js';

describe('vector basics', () => {
  it('normalizes to unit length', () => {
    const n = normalize({ x: 3, y: 4 });
    expect(distance(n, { x: 0, y: 0 })).toBeCloseTo(1);
    expect(n.x).toBeCloseTo(0.6);
  });

  it('returns zero rather than NaN for a zero-length vector', () => {
    // A degenerate forearm (arm pointed straight at the camera) hits this every
    // few frames; NaN here would poison the blade angle for the rest of the round.
    expect(normalize({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe('angles', () => {
  it('treats +y as down but reports 90 degrees as up', () => {
    expect(angleOf({ x: 1, y: 0 })).toBeCloseTo(0);
    expect(angleOf({ x: 0, y: -1 })).toBeCloseTo(90);
    expect(angleOf({ x: -1, y: 0 })).toBeCloseTo(180);
    expect(angleOf({ x: 0, y: 1 })).toBeCloseTo(-90);
  });

  it('round-trips through fromAngle', () => {
    for (const deg of [-179, -90, -12, 0, 37, 90, 179]) {
      expect(angleOf(fromAngle(deg))).toBeCloseTo(deg, 5);
    }
  });

  it('folds angles into (-180, 180]', () => {
    expect(normalizeAngle(370)).toBeCloseTo(10);
    expect(normalizeAngle(-370)).toBeCloseTo(-10);
    expect(normalizeAngle(540)).toBeCloseTo(180);
  });

  it('takes the short way round the seam', () => {
    expect(angleDelta(170, -170)).toBeCloseTo(20);
    expect(angleDelta(-170, 170)).toBeCloseTo(-20);
    expect(angleBetween(179, -179)).toBeCloseTo(2);
  });

  it('interpolates across the seam without spinning the long way', () => {
    // A blade sweeping past vertical crosses +/-180. Naive lerp would whip it
    // 340 degrees the wrong way, which looks like a bug on screen.
    expect(normalizeAngle(lerpAngle(170, -170, 0.5))).toBeCloseTo(180);
    expect(lerpAngle(10, 30, 0.5)).toBeCloseTo(20);
  });

  it('averages angles circularly', () => {
    expect(meanAngle([170, -170])).toBeCloseTo(180);
    expect(meanAngle([0, 90])).toBeCloseTo(45);
    expect(meanAngle([])).toBe(0);
  });
});

describe('computeSword', () => {
  it('extends the forearm line past the wrist', () => {
    // elbow below the wrist -> blade points up
    const sword = computeSword({ x: 0, y: 0 }, { x: 0, y: 1 }, 3);
    expect(sword.angle).toBeCloseTo(90);
    expect(sword.tip.y).toBeCloseTo(-3);
    expect(sword.length).toBeCloseTo(3);
    expect(sword.origin).toEqual({ x: 0, y: 0 });
  });

  it('scales the blade with the player, not with the camera', () => {
    // Same pose, twice the apparent size: the blade must be twice as long, so
    // that on-screen proportions stay identical.
    const near = computeSword({ x: 0, y: 0 }, { x: 0, y: 1 }, POSE.swordExtension);
    const far = computeSword({ x: 0, y: 0 }, { x: 0, y: 0.5 }, POSE.swordExtension);
    expect(near.length / far.length).toBeCloseTo(2);
    expect(near.angle).toBeCloseTo(far.angle);
  });

  it('falls back to the previous angle when the forearm is foreshortened', () => {
    const sword = computeSword({ x: 1, y: 1 }, { x: 1, y: 1 }, 3, 45);
    expect(sword.angle).toBeCloseTo(45);
    expect(Number.isFinite(sword.tip.x)).toBe(true);
    expect(Number.isFinite(sword.tip.y)).toBe(true);
  });

  it('points the blade where the forearm points, at any angle', () => {
    for (const deg of [-135, -45, 0, 60, 120, 175]) {
      const dir = fromAngle(deg);
      const wrist = { x: dir.x, y: dir.y };
      const sword = computeSword(wrist, { x: 0, y: 0 }, 2);
      expect(normalizeAngle(sword.angle - deg)).toBeCloseTo(0, 4);
    }
  });
});

describe('segment helpers', () => {
  it('measures distance to a segment, not to its infinite line', () => {
    expect(distanceToSegment({ x: 5, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(
      Math.hypot(4, 1),
    );
    expect(distanceToSegment({ x: 0.5, y: 2 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(2);
  });

  it('handles a degenerate segment', () => {
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(5);
  });

  it('detects crossing blades', () => {
    expect(
      segmentsIntersect({ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 }),
    ).toBe(true);
    expect(
      segmentsIntersect({ x: -1, y: 0 }, { x: -0.5, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 }),
    ).toBe(false);
  });
});
