/**
 * Landmark smoothing.
 *
 * Raw pose landmarks jitter by a couple of pixels every frame even when the
 * player is perfectly still, which makes a 2.6x-extended blade wobble wildly at
 * the tip. A plain low-pass fixes the wobble but adds lag exactly when it hurts
 * most — during a fast slash.
 *
 * The 1-Euro filter (Casiez, Roussel & Vogel, CHI 2012) solves both: its cutoff
 * frequency rises with the signal's own speed, so it smooths hard when the hand
 * is still and gets out of the way when the hand moves. This is the same
 * approach used for the blade in GrauNinja, generalized here to 2-D points.
 */

import type { Vec2 } from './vector.js';
import { lerpAngle, normalizeAngle } from './vector.js';

const alphaFor = (cutoffHz: number, dt: number): number => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dt);
};

export interface OneEuroOptions {
  /** Cutoff at zero speed. Lower = smoother but laggier when still. */
  minCutoff?: number;
  /** How aggressively the cutoff opens up with speed. Higher = less lag. */
  beta?: number;
  /** Cutoff of the derivative's own filter. */
  dCutoff?: number;
}

export class OneEuroFilter {
  minCutoff: number;
  beta: number;
  dCutoff: number;
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor({ minCutoff = 1.6, beta = 0.05, dCutoff = 1.0 }: OneEuroOptions = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
  }

  /** @param t timestamp in milliseconds. */
  filter(x: number, t: number): number {
    if (this.xPrev === null || !Number.isFinite(this.xPrev)) {
      this.xPrev = x;
      this.tPrev = t;
      return x;
    }
    // Clamp dt: a tab that was backgrounded returns with a huge gap, and a
    // duplicated timestamp would divide by zero.
    const dt = Math.min(0.25, Math.max(1e-3, (t - this.tPrev) / 1000));
    this.tPrev = t;

    const dx = (x - this.xPrev) / dt;
    this.dxPrev = alphaFor(this.dCutoff, dt) * dx + (1 - alphaFor(this.dCutoff, dt)) * this.dxPrev;

    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxPrev);
    const a = alphaFor(cutoff, dt);
    const out = a * x + (1 - a) * this.xPrev;
    this.xPrev = out;
    return out;
  }

  /** Speed estimate (units/second) from the last filtered step. */
  get speed(): number {
    return this.dxPrev;
  }
}

/** A 1-Euro filter per axis, for smoothing landmark positions. */
export class OneEuroVec2 {
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;

  constructor(opts: OneEuroOptions = {}) {
    this.fx = new OneEuroFilter(opts);
    this.fy = new OneEuroFilter(opts);
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }

  filter(p: Vec2, t: number): Vec2 {
    return { x: this.fx.filter(p.x, t), y: this.fy.filter(p.y, t) };
  }

  get velocity(): Vec2 {
    return { x: this.fx.speed, y: this.fy.speed };
  }
}

/**
 * Exponential smoothing for angles, done the short way round the circle.
 *
 * The blade angle gets this rather than a 1-Euro filter: a blade sweeping past
 * vertical crosses the +/-180 seam, and a per-component filter would spin the
 * blade the long way round when it does.
 */
export class AngleSmoother {
  private value: number | null = null;
  private lastT = 0;
  private velocity = 0;

  /** @param responsiveness 0..1 — share of the gap closed per 60 Hz frame. */
  constructor(private responsiveness = 0.35) {}

  reset(): void {
    this.value = null;
    this.velocity = 0;
  }

  /** @returns the smoothed angle in degrees. */
  push(angleDeg: number, t: number): number {
    if (this.value === null) {
      this.value = normalizeAngle(angleDeg);
      this.lastT = t;
      return this.value;
    }
    const dt = Math.min(0.25, Math.max(1e-3, (t - this.lastT) / 1000));
    this.lastT = t;
    // Scale the per-frame responsiveness to the actual frame time so the feel
    // does not change between a 30 Hz and a 144 Hz display.
    const k = 1 - Math.pow(1 - this.responsiveness, dt * 60);
    const next = lerpAngle(this.value, angleDeg, k);
    this.velocity = normalizeAngle(next - this.value) / dt;
    this.value = next;
    return next;
  }

  get current(): number {
    return this.value ?? 0;
  }

  /** Angular speed in degrees/second, signed (positive = counter-clockwise). */
  get angularVelocity(): number {
    return this.velocity;
  }
}
