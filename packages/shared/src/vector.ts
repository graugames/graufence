/**
 * 2-D vector maths and the sword geometry built on top of it.
 *
 * Angles are in degrees, measured screen-style: 0 deg points right (+x),
 * 90 deg points *up*. Screen y grows downward, so the sign flip lives in
 * `angleOf` and nowhere else — every consumer can then reason in ordinary
 * "90 is up" terms.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): Vec2 => ({ x, y });

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
/** 2-D cross product (z of the 3-D cross). Sign tells you which side b is on. */
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const length = (a: Vec2): number => Math.hypot(a.x, a.y);
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const midpoint = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const lerpVec = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
});

/** Unit vector. A zero-length input returns (0,0) rather than NaN. */
export function normalize(a: Vec2): Vec2 {
  const len = length(a);
  if (len < 1e-9) return { x: 0, y: 0 };
  return { x: a.x / len, y: a.y / len };
}

/**
 * Direction of `a` in degrees, with +y treated as up.
 *
 * The result is always in (-180, 180]: `atan2` returns -180 for a vector
 * pointing left (because of negative zero), and having the same direction
 * reported as both -180 and 180 depending on rounding would make the "blade
 * points left" sector flicker.
 */
export function angleOf(a: Vec2): number {
  return normalizeAngle((Math.atan2(-a.y, a.x) * 180) / Math.PI);
}

/** Unit vector pointing along `deg` (screen convention: 90 deg is up). */
export function fromAngle(deg: number, len = 1): Vec2 {
  const r = (deg * Math.PI) / 180;
  return { x: Math.cos(r) * len, y: -Math.sin(r) * len };
}

/** Fold any angle into (-180, 180]. */
export function normalizeAngle(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Signed shortest rotation from `a` to `b`, in (-180, 180]. */
export function angleDelta(a: number, b: number): number {
  return normalizeAngle(b - a);
}

/** Unsigned shortest angle between two directions, in [0, 180]. */
export function angleBetween(a: number, b: number): number {
  return Math.abs(angleDelta(a, b));
}

/** Interpolate between angles the short way round — no 359->1 spin. */
export function lerpAngle(a: number, b: number, t: number): number {
  return normalizeAngle(a + angleDelta(a, b) * t);
}

/** Circular mean of a set of angles, safe across the +/-180 seam. */
export function meanAngle(degs: readonly number[]): number {
  if (degs.length === 0) return 0;
  let sx = 0;
  let sy = 0;
  for (const d of degs) {
    const r = (d * Math.PI) / 180;
    sx += Math.cos(r);
    sy += Math.sin(r);
  }
  if (Math.hypot(sx, sy) < 1e-9) return 0;
  return (Math.atan2(sy, sx) * 180) / Math.PI;
}

// ------------------------------------------------------------ sword geometry

export interface Sword {
  /** Hilt — sits at the wrist. */
  origin: Vec2;
  /** Point of the blade. */
  tip: Vec2;
  /** Unit vector from hilt to tip. */
  direction: Vec2;
  /** Blade direction in degrees (90 = straight up). */
  angle: number;
  /** Blade length in the same units as the inputs. */
  length: number;
}

/**
 * Builds the blade from the forearm: it starts at the wrist and continues the
 * elbow -> wrist line outward. `extension` is a multiple of forearm length, so
 * the blade scales with the player instead of with the camera.
 *
 * A degenerate forearm (elbow and wrist on top of each other, which happens
 * when the arm points at the camera) has no usable direction; `fallbackAngle`
 * keeps the blade pointing somewhere sane instead of collapsing to a dot.
 */
export function computeSword(
  wrist: Vec2,
  elbow: Vec2,
  extension: number,
  fallbackAngle = 90,
): Sword {
  const forearm = sub(wrist, elbow);
  const forearmLen = length(forearm);
  const direction = forearmLen < 1e-6 ? fromAngle(fallbackAngle) : normalize(forearm);
  // Even a fully foreshortened forearm should produce a blade of believable
  // length, hence the floor on the length used for the extension.
  const bladeLength = Math.max(forearmLen, 1e-3) * extension;
  const tip = add(wrist, scale(direction, bladeLength));
  return {
    origin: { ...wrist },
    tip,
    direction,
    angle: angleOf(direction),
    length: bladeLength,
  };
}

/**
 * Shortest distance from point `p` to the segment `a`->`b`.
 * Used for blade-crosses-attack-line parry checks and for blade hit tests.
 */
export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const lenSq = dot(ab, ab);
  if (lenSq < 1e-12) return distance(p, a);
  const t = clamp(dot(sub(p, a), ab) / lenSq, 0, 1);
  return distance(p, add(a, scale(ab, t)));
}

/** True when segments a1->a2 and b1->b2 properly intersect. */
export function segmentsIntersect(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): boolean {
  const d1 = cross(sub(a2, a1), sub(b1, a1));
  const d2 = cross(sub(a2, a1), sub(b2, a1));
  const d3 = cross(sub(b2, b1), sub(a1, b1));
  const d4 = cross(sub(b2, b1), sub(a2, b1));
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
