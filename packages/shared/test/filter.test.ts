import { describe, expect, it } from 'vitest';
import { AngleSmoother, OneEuroFilter, OneEuroVec2 } from '../src/filter.js';

/** Feeds a signal through a filter at a fixed rate and returns the outputs. */
function run(f: OneEuroFilter, values: number[], fps = 30, t0 = 1000): number[] {
  const step = 1000 / fps;
  return values.map((v, i) => f.filter(v, t0 + i * step));
}

describe('OneEuroFilter', () => {
  it('passes the first sample straight through', () => {
    const f = new OneEuroFilter();
    expect(f.filter(0.42, 1000)).toBe(0.42);
  });

  it('suppresses jitter on a still signal', () => {
    // +/-0.01 noise around 0.5 - roughly what a still hand looks like.
    const noisy = Array.from({ length: 60 }, (_, i) => 0.5 + (i % 2 === 0 ? 0.01 : -0.01));
    const out = run(new OneEuroFilter({ minCutoff: 1.0, beta: 0.0 }), noisy);
    const tail = out.slice(30);
    const spread = Math.max(...tail) - Math.min(...tail);
    expect(spread).toBeLessThan(0.006);
    expect(tail[tail.length - 1]).toBeCloseTo(0.5, 2);
  });

  it('keeps up with a fast ramp better than a fixed low-pass would', () => {
    // The whole point of 1-Euro: lag must shrink as speed grows. A slash that
    // arrives 100 ms late is a slash the player did not throw.
    const ramp = Array.from({ length: 20 }, (_, i) => i * 0.1);
    const responsive = run(new OneEuroFilter({ minCutoff: 1.0, beta: 0.4 }), ramp);
    const sluggish = run(new OneEuroFilter({ minCutoff: 1.0, beta: 0.0 }), ramp);
    const target = ramp[ramp.length - 1]!;
    const responsiveLag = target - responsive[responsive.length - 1]!;
    const sluggishLag = target - sluggish[sluggish.length - 1]!;
    expect(responsiveLag).toBeLessThan(sluggishLag);
  });

  it('survives duplicate and backwards timestamps', () => {
    const f = new OneEuroFilter();
    f.filter(1, 1000);
    expect(Number.isFinite(f.filter(2, 1000))).toBe(true);
    expect(Number.isFinite(f.filter(3, 900))).toBe(true);
  });

  it('survives a long gap, as after a backgrounded tab', () => {
    const f = new OneEuroFilter();
    f.filter(0, 1000);
    const out = f.filter(1, 60_000);
    expect(Number.isFinite(out)).toBe(true);
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThanOrEqual(1);
  });

  it('resets cleanly', () => {
    const f = new OneEuroFilter();
    run(f, [0, 0, 0, 0]);
    f.reset();
    expect(f.filter(9, 5000)).toBe(9);
  });
});

describe('OneEuroVec2', () => {
  it('filters both axes independently', () => {
    const f = new OneEuroVec2();
    f.filter({ x: 0, y: 0 }, 1000);
    const out = f.filter({ x: 1, y: -1 }, 1033);
    expect(out.x).toBeGreaterThan(0);
    expect(out.y).toBeLessThan(0);
  });
});

describe('AngleSmoother', () => {
  it('crosses the +/-180 seam the short way', () => {
    const s = new AngleSmoother(0.5);
    s.push(170, 1000);
    const out = s.push(-170, 1016);
    // Short way is 170 -> 180 -> -170. Anything near 0 means it spun backwards
    // through the whole circle.
    expect(Math.abs(out)).toBeGreaterThan(170);
  });

  it('reports angular velocity in degrees per second', () => {
    const s = new AngleSmoother(1); // no smoothing: follow the input exactly
    s.push(0, 1000);
    s.push(90, 1100); // 90 degrees in 0.1 s
    expect(s.angularVelocity).toBeCloseTo(900, 0);
  });

  it('feels the same at 30 fps and at 120 fps', () => {
    // Responsiveness is scaled by frame time, so a high-refresh display must
    // not make the blade snappier than a 60 Hz one.
    const slow = new AngleSmoother(0.3);
    const fast = new AngleSmoother(0.3);
    slow.push(0, 0);
    fast.push(0, 0);
    for (let i = 1; i <= 6; i++) slow.push(90, i * (1000 / 30));
    for (let i = 1; i <= 24; i++) fast.push(90, i * (1000 / 120));
    expect(slow.current).toBeCloseTo(fast.current, 1);
  });

  it('starts at the first value it sees', () => {
    const s = new AngleSmoother();
    expect(s.push(42, 1000)).toBeCloseTo(42);
  });
});
