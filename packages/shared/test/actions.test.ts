import { describe, expect, it } from 'vitest';
import { ActionDetector, guardCoverage, zoneForAngle } from '../src/actions.js';
import type { DetectedAction } from '../src/actions.js';
import { calibrationFromLandmarks, PoseNormalizer } from '../src/pose.js';
import type { BodyOptions } from './helpers.js';
import { hold, makeLandmarks, makeLowConfidenceLandmarks, ramp } from './helpers.js';

/** A normalizer + detector pair driven by mock landmarks, as in the real client. */
function rig() {
  const cal = calibrationFromLandmarks(makeLandmarks(), 'right')!;
  const normalizer = new PoseNormalizer({ calibration: cal, recenterPerSecond: 0 });
  const detector = new ActionDetector();
  let t = 1000;
  const play = (frames: BodyOptions[], fps = 25): DetectedAction[] => {
    const fired: DetectedAction[] = [];
    for (const f of frames) {
      fired.push(...detector.update(normalizer.process(makeLandmarks(f), t)));
      t += 1000 / fps;
    }
    return fired;
  };
  const playRaw = (landmarks: ReturnType<typeof makeLandmarks>[], fps = 25) => {
    const fired: DetectedAction[] = [];
    for (const lm of landmarks) {
      fired.push(...detector.update(normalizer.process(lm, t)));
      t += 1000 / fps;
    }
    return fired;
  };
  return { detector, play, playRaw, now: () => t };
}

const NEUTRAL: BodyOptions = { wrist: { x: 0.45, y: -0.5 }, wristZ: 0 };

/** Settle the filters before asking anything of the detector. */
const settle = (play: ReturnType<typeof rig>['play']) => play(hold(NEUTRAL, 10));

describe('zoneForAngle', () => {
  it('splits the circle into four readable sectors', () => {
    expect(zoneForAngle(90)).toBe('head');
    expect(zoneForAngle(60)).toBe('head');
    expect(zoneForAngle(10)).toBe('right');
    expect(zoneForAngle(-20)).toBe('right');
    expect(zoneForAngle(170)).toBe('left');
    expect(zoneForAngle(-170)).toBe('left');
    expect(zoneForAngle(-90)).toBe('torso');
  });

  it('is total - every angle lands in exactly one zone', () => {
    for (let a = -180; a <= 180; a += 0.5) {
      expect(['head', 'torso', 'left', 'right']).toContain(zoneForAngle(a));
    }
  });

  it('does not flicker across the +/-180 seam', () => {
    expect(zoneForAngle(179.9)).toBe(zoneForAngle(-179.9));
  });
});

describe('guardCoverage', () => {
  it('is best dead-centre in the sector and falls off toward its edge', () => {
    expect(guardCoverage(90, 'head')).toBeCloseTo(1);
    expect(guardCoverage(120, 'head')).toBeLessThan(1);
    expect(guardCoverage(120, 'head')).toBeGreaterThan(0);
    expect(guardCoverage(-90, 'head')).toBe(0);
  });
});

describe('ActionDetector - confidence gating', () => {
  it('fires nothing while tracking confidence is low', () => {
    const { detector, playRaw } = rig();
    // A textbook slash, but every landmark is a guess.
    const fired = playRaw(Array.from({ length: 12 }, () => makeLowConfidenceLandmarks()));
    expect(fired).toHaveLength(0);
    expect(detector.state.tracking).toBe(false);
  });

  it('reports lost tracking after a sustained dropout', () => {
    const { detector, playRaw } = rig();
    playRaw(Array.from({ length: 20 }, () => makeLowConfidenceLandmarks()));
    expect(detector.state.lostTracking).toBe(true);
  });

  it('does not read re-entering the frame as a slash', () => {
    // Tracking drops, the player walks back in, and the landmark jump from
    // "nothing" to "here" is enormous. Wiping history on a bad frame is what
    // stops that jump from registering as a supersonic swing.
    const { playRaw } = rig();
    playRaw(Array.from({ length: 10 }, () => makeLowConfidenceLandmarks()));
    const fired = playRaw([
      makeLandmarks({ wrist: { x: -1.2, y: -0.5 } }),
      makeLandmarks({ wrist: { x: 1.2, y: -0.5 } }),
    ]);
    expect(fired).toHaveLength(0);
  });
});

describe('ActionDetector - guard', () => {
  it('registers a held blade as a guard in the sector it covers', () => {
    const { detector, play } = rig();
    // Wrist above the elbow -> blade points up -> head guard.
    play(hold({ wrist: { x: 0.4, y: -0.9 }, elbow: { x: 0.4, y: -0.45 } }, 12));
    expect(detector.state.guardZone).toBe('head');
  });

  it('drops the guard while the blade is in motion', () => {
    const { detector, play } = rig();
    play(hold({ wrist: { x: 0.4, y: -0.9 }, elbow: { x: 0.4, y: -0.45 } }, 10));
    expect(detector.state.guardZone).toBe('head');
    play(
      ramp(
        { wrist: { x: 0.4, y: -0.9 }, elbow: { x: 0.4, y: -0.45 } },
        { wrist: { x: -1.1, y: -0.5 }, elbow: { x: -0.3, y: -0.3 } },
        3,
      ),
    );
    expect(detector.state.guardZone).toBeNull();
  });
});

describe('ActionDetector - thrust', () => {
  it('fires on a committed forward extension', () => {
    const { play } = rig();
    settle(play);
    const fired = play(ramp(NEUTRAL, { ...NEUTRAL, wristZ: -0.12 }, 5));
    const thrusts = fired.filter((a) => a.kind === 'thrust');
    expect(thrusts).toHaveLength(1);
    expect(thrusts[0]!.zone).toBeDefined();
    expect(thrusts[0]!.confidence).toBeGreaterThan(0.5);
  });

  it('ignores a slow reach', () => {
    // Reaching out to move the laptop is the same shape as a thrust, an order
    // of magnitude slower. Only the speed separates them.
    const { play } = rig();
    settle(play);
    const fired = play(ramp(NEUTRAL, { ...NEUTRAL, wristZ: -0.12 }, 40));
    expect(fired.filter((a) => a.kind === 'thrust')).toHaveLength(0);
  });

  it('respects its cooldown', () => {
    const { play } = rig();
    settle(play);
    const first = play(ramp(NEUTRAL, { ...NEUTRAL, wristZ: -0.12 }, 5));
    const second = play(ramp({ ...NEUTRAL, wristZ: -0.12 }, { ...NEUTRAL, wristZ: -0.24 }, 5));
    expect(first.filter((a) => a.kind === 'thrust')).toHaveLength(1);
    expect(second.filter((a) => a.kind === 'thrust')).toHaveLength(0);
  });
});

describe('ActionDetector - slash', () => {
  it('classifies a left-to-right sweep', () => {
    const { play } = rig();
    const start = { wrist: { x: -0.9, y: -0.5 } };
    play(hold(start, 10));
    const fired = play(ramp(start, { wrist: { x: 0.9, y: -0.5 } }, 4));
    const slashes = fired.filter((a) => a.kind === 'slash');
    expect(slashes).toHaveLength(1);
    expect(slashes[0]!.slash).toBe('lr');
  });

  it('classifies a right-to-left sweep', () => {
    const { play } = rig();
    const start = { wrist: { x: 0.9, y: -0.5 } };
    play(hold(start, 10));
    const fired = play(ramp(start, { wrist: { x: -0.9, y: -0.5 } }, 4));
    const slashes = fired.filter((a) => a.kind === 'slash');
    expect(slashes).toHaveLength(1);
    expect(slashes[0]!.slash).toBe('rl');
  });

  it('does not fire on a slow lateral drift', () => {
    const { play } = rig();
    const start = { wrist: { x: -0.9, y: -0.5 } };
    play(hold(start, 10));
    const fired = play(ramp(start, { wrist: { x: 0.9, y: -0.5 } }, 45));
    expect(fired.filter((a) => a.kind === 'slash')).toHaveLength(0);
  });

  it('never reports one motion as both a slash and a parry', () => {
    const { play } = rig();
    const start = { wrist: { x: -0.9, y: -0.5 }, elbow: { x: -0.5, y: -0.1 } };
    play(hold(start, 10));
    const fired = play(
      ramp(start, { wrist: { x: 0.9, y: -0.5 }, elbow: { x: 0.5, y: -0.1 } }, 4),
    );
    const kinds = fired.map((a) => a.kind);
    expect(kinds).not.toContain('parry');
  });
});

describe('ActionDetector - dodge', () => {
  it('fires on a fast lateral hip displacement, with a direction', () => {
    const { play } = rig();
    settle(play);
    // cx *decreasing* in image space is the player moving to their own right.
    const fired = play(ramp({ cx: 0.5 }, { cx: 0.5 - 0.22 * 0.55 }, 5));
    const dodges = fired.filter((a) => a.kind === 'dodge');
    expect(dodges).toHaveLength(1);
    expect(dodges[0]!.dodge).toBe('right');
  });

  it('does not re-fire while the player stays leaned over', () => {
    // Displacement alone is not a dodge - the hips have to still be moving,
    // or a player standing off-centre would dodge forever for free.
    const { play } = rig();
    settle(play);
    play(ramp({ cx: 0.5 }, { cx: 0.5 - 0.22 * 0.55 }, 5));
    const held = play(hold({ cx: 0.5 - 0.22 * 0.55 }, 40));
    expect(held.filter((a) => a.kind === 'dodge')).toHaveLength(0);
  });

  it('ignores a slow weight shift', () => {
    const { play } = rig();
    settle(play);
    const fired = play(ramp({ cx: 0.5 }, { cx: 0.5 - 0.22 * 0.55 }, 50));
    expect(fired.filter((a) => a.kind === 'dodge')).toHaveLength(0);
  });
});

describe('ActionDetector - sensitivity', () => {
  it('can be made strict enough to reject a gesture it would otherwise take', () => {
    const strict = rig();
    strict.detector.setSensitivity(2.5);
    settle(strict.play);
    const fired = strict.play(ramp(NEUTRAL, { ...NEUTRAL, wristZ: -0.12 }, 5));
    expect(fired.filter((a) => a.kind === 'thrust')).toHaveLength(0);
  });

  it('still fires at the loosest setting a slider can reach', () => {
    // The settings slider is clamped to [0.4, 2.5]; make sure a player who
    // drags it to either end still has a working game rather than a dead one.
    const loose = rig();
    loose.detector.setSensitivity(-99);
    settle(loose.play);
    const fired = loose.play(ramp(NEUTRAL, { ...NEUTRAL, wristZ: -0.12 }, 5));
    expect(fired.filter((a) => a.kind === 'thrust').length).toBeGreaterThan(0);
  });
});
