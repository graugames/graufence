/**
 * Optional OpenCV.js preprocessing for the camera preview.
 *
 * What this is for, and what it is deliberately not:
 *
 * MediaPipe already does its own resizing and colour conversion internally, and
 * feeding it a pre-processed canvas instead of the raw <video> makes tracking
 * *worse*, not better - it adds a full frame copy per frame and throws away
 * information the model was trained on. So OpenCV is not in the tracking path.
 *
 * Where it does earn its place is the preview thumbnail: downscaling, mirroring
 * and a CLAHE-style contrast lift make it much easier for a player in a dim
 * room to see whether they are actually in frame, which is the single most
 * common "why isn't it working" cause.
 *
 * It is off by default and lazily loaded. OpenCV.js is several megabytes; the
 * game must never wait on it, and must work identically if it never arrives.
 * Turn it on with ?cv=1 or the toggle on the calibration screen.
 */

type Mat = { delete(): void; cols: number; rows: number };

interface OpenCV {
  imread(source: HTMLCanvasElement | HTMLImageElement): Mat;
  imshow(target: HTMLCanvasElement, mat: Mat): void;
  Mat: new () => Mat;
  Size: new (w: number, h: number) => unknown;
  cvtColor(src: Mat, dst: Mat, code: number): void;
  resize(src: Mat, dst: Mat, size: unknown, fx: number, fy: number, interp: number): void;
  flip(src: Mat, dst: Mat, code: number): void;
  createCLAHE(clip: number, size: unknown): {
    apply(src: Mat, dst: Mat): void;
    delete(): void;
  };
  split(src: Mat, vec: unknown): void;
  merge(vec: unknown, dst: Mat): void;
  MatVector: new () => { get(i: number): Mat; set(i: number, m: Mat): void; delete(): void };
  COLOR_RGBA2RGB: number;
  COLOR_RGB2YCrCb: number;
  COLOR_YCrCb2RGB: number;
  INTER_AREA: number;
}

const OPENCV_URL = 'https://docs.opencv.org/4.10.0/opencv.js';

let loadPromise: Promise<OpenCV | null> | null = null;

/**
 * Loads OpenCV.js once, from the CDN, and resolves to null if it cannot.
 *
 * Returning null rather than throwing is the whole contract here: every caller
 * is expected to carry on without it.
 */
export function loadOpenCv(timeoutMs = 15_000): Promise<OpenCV | null> {
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<OpenCV | null>((resolve) => {
    if (typeof document === 'undefined') return resolve(null);

    // The global is typed loosely on purpose: between the script tag loading
    // and the WASM runtime initializing, `cv` exists but most of it does not.
    const globalCv = () =>
      (window as unknown as { cv?: Partial<OpenCV> & { onRuntimeInitialized?: () => void } }).cv;

    const existing = globalCv();
    if (existing && typeof existing.imread === 'function') return resolve(existing as OpenCV);

    const script = document.createElement('script');
    script.src = OPENCV_URL;
    script.async = true;

    const timer = setTimeout(() => {
      console.warn('[graufence] OpenCV.js took too long; preview effects disabled');
      resolve(null);
    }, timeoutMs);

    script.onerror = () => {
      clearTimeout(timer);
      console.warn('[graufence] OpenCV.js failed to load; preview effects disabled');
      resolve(null);
    };

    script.onload = () => {
      const cv = globalCv();
      if (!cv) {
        clearTimeout(timer);
        return resolve(null);
      }
      // The module may still be compiling its own WASM when the script's load
      // event fires; imread only exists once the runtime is up.
      if (typeof cv.imread === 'function') {
        clearTimeout(timer);
        return resolve(cv as OpenCV);
      }
      cv.onRuntimeInitialized = () => {
        clearTimeout(timer);
        resolve(globalCv() as OpenCV);
      };
    };

    document.head.appendChild(script);
  });

  return loadPromise;
}

export interface PreprocessOptions {
  /** Mirror horizontally, so the preview reads like a mirror. */
  mirror?: boolean;
  /** Lift local contrast; helps enormously in a dim room. */
  enhance?: boolean;
}

/**
 * Draws `video` into `target`, optionally mirrored and contrast-boosted.
 *
 * Falls back to a plain canvas draw whenever OpenCV is unavailable, which keeps
 * one code path in the preview renderer instead of two.
 *
 * @returns true when OpenCV actually did the work.
 */
export function drawPreview(
  cv: OpenCV | null,
  video: HTMLVideoElement,
  target: HTMLCanvasElement,
  { mirror = true, enhance = false }: PreprocessOptions = {},
): boolean {
  const ctx = target.getContext('2d');
  if (!ctx) return false;

  const { width, height } = target;
  if (width === 0 || height === 0) return false;

  if (!cv || !enhance) {
    // The fast path, and the only one most players ever take.
    ctx.save();
    if (mirror) {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, width, height);
    ctx.restore();
    return false;
  }

  // OpenCV path. Every Mat is explicitly deleted: emscripten heap objects are
  // not garbage collected, and leaking one per frame at 20 fps will exhaust
  // memory in about a minute.
  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  const scratchCtx = scratch.getContext('2d');
  if (!scratchCtx) return false;
  scratchCtx.drawImage(video, 0, 0, width, height);

  let src: Mat | null = null;
  let rgb: Mat | null = null;
  let ycrcb: Mat | null = null;
  let channels: { get(i: number): Mat; set(i: number, m: Mat): void; delete(): void } | null =
    null;
  let equalized: Mat | null = null;
  let clahe: { apply(src: Mat, dst: Mat): void; delete(): void } | null = null;

  try {
    src = cv.imread(scratch);
    rgb = new cv.Mat();
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);

    if (mirror) cv.flip(rgb, rgb, 1);

    // Equalize luminance only. Running CLAHE per RGB channel shifts colour
    // badly; doing it on Y in YCrCb lifts shadow detail and leaves skin tones
    // recognisable, which is the point of the preview.
    ycrcb = new cv.Mat();
    cv.cvtColor(rgb, ycrcb, cv.COLOR_RGB2YCrCb);
    channels = new cv.MatVector();
    cv.split(ycrcb, channels);
    equalized = new cv.Mat();
    clahe = cv.createCLAHE(2.0, new cv.Size(8, 8));
    clahe.apply(channels.get(0), equalized);
    channels.set(0, equalized);
    cv.merge(channels, ycrcb);
    cv.cvtColor(ycrcb, rgb, cv.COLOR_YCrCb2RGB);

    cv.imshow(target, rgb);
    return true;
  } catch (err) {
    console.warn('[graufence] OpenCV preprocessing failed; using plain draw', err);
    ctx.save();
    if (mirror) {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, width, height);
    ctx.restore();
    return false;
  } finally {
    src?.delete();
    rgb?.delete();
    ycrcb?.delete();
    equalized?.delete();
    channels?.delete();
    clahe?.delete();
  }
}

export type { OpenCV };
