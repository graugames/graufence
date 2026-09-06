/**
 * Webcam pose tracking.
 *
 * MediaPipe PoseLandmarker runs entirely inside this tab. Frames are pulled
 * from a <video> element, inference happens on the GPU (or CPU), and the only
 * thing that leaves this module is a list of landmarks. No frame, no image, and
 * no byte of camera data is ever sent anywhere.
 *
 * Two hard-won details, carried over from GrauNinja's hand tracker:
 *
 *  - The WebGL delegate fails on plenty of real machines - locked-down drivers,
 *    some integrated GPUs, remote desktops - sometimes at creation and
 *    sometimes only once frames start arriving. Both cases fall back to CPU
 *    rather than leaving the player with a camera light on and nothing moving.
 *  - The first inference pays for shader compilation, which can take seconds.
 *    That cost is burned during loading, not during the player's first lunge.
 */

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark } from '@graufence/shared';

/**
 * Where the WASM runtime comes from.
 *
 * `npm run dev` / `npm run build` copy it out of node_modules into
 * public/mediapipe/wasm (see scripts/copy-mediapipe-wasm.mjs), so the version
 * always matches the installed package and the game works offline. The CDN is
 * only a fallback for when that copy has not run.
 */
const LOCAL_WASM_PATH = `${import.meta.env.BASE_URL}mediapipe/wasm`;
const CDN_WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';

/**
 * The pose model. Defaults to Google's hosted copy of pose_landmarker_lite -
 * the smallest of the three, and the right trade here: the game needs joint
 * positions at 25 fps, not millimetre accuracy.
 *
 * Set VITE_POSE_MODEL_URL (and run `npm run fetch:model`) to self-host it.
 */
const MODEL_URL =
  (import.meta.env['VITE_POSE_MODEL_URL'] as string | undefined) ??
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

/** Inference cap. Rendering runs at 60; the model does not need to. */
const DETECT_INTERVAL_MS = 1000 / 25;

export type TrackerStatus = string;

export interface TrackerResult {
  landmarks: Landmark[];
  /** True when this call ran a fresh inference rather than reusing the last. */
  fresh: boolean;
}

export interface StartOptions {
  onStatus?: (status: TrackerStatus) => void;
}

export class PoseTracker {
  readonly video: HTMLVideoElement;
  private landmarker: PoseLandmarker | null = null;
  private stream: MediaStream | null = null;
  private fileset: unknown = null;

  running = false;
  /** 'GPU' or 'CPU' - shown in the debug panel, since it explains a lot. */
  delegate: 'GPU' | 'CPU' = 'GPU';
  /** Measured inference rate, in frames per second. */
  fps = 0;
  error: Error | null = null;

  private landmarks: Landmark[] = [];
  private lastVideoTime = -1;
  private lastDetectAt = -Infinity;
  private detectFails = 0;
  private rebuilding = false;
  private inferenceAcc = 0;
  private inferenceCount = 0;

  constructor(video?: HTMLVideoElement) {
    this.video =
      video ??
      (() => {
        const el = document.createElement('video');
        el.playsInline = true;
        el.muted = true;
        return el;
      })();
  }

  get hasSignal(): boolean {
    return this.landmarks.length > 0;
  }

  private async createLandmarker(delegate: 'GPU' | 'CPU'): Promise<PoseLandmarker> {
    const lm = await PoseLandmarker.createFromOptions(this.fileset as never, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    });
    this.delegate = delegate;
    return lm;
  }

  /** Swaps a faulting GPU pipeline for a CPU one without dropping the camera. */
  private async rebuildOnCpu(): Promise<void> {
    if (this.rebuilding || !this.fileset) return;
    this.rebuilding = true;
    console.warn('[graufence] GPU pose tracking faulted; switching to CPU');
    try {
      this.landmarker = await this.createLandmarker('CPU');
      this.detectFails = 0;
      this.error = null;
    } catch (err) {
      this.error = err as Error;
    } finally {
      this.rebuilding = false;
    }
  }

  /**
   * Requests the camera and loads the model.
   * @throws whatever getUserMedia or the model loader threw, after cleaning up.
   */
  async start({ onStatus }: StartOptions = {}): Promise<void> {
    onStatus?.('Requesting camera...');
    this.stream = await navigator.mediaDevices.getUserMedia({
      // 640x480 is plenty for body landmarks and keeps inference predictable on
      // laptops whose GPU is already busy drawing the arena.
      video: {
        width: { ideal: 640, max: 960 },
        height: { ideal: 480, max: 720 },
        frameRate: { ideal: 30, max: 30 },
        facingMode: 'user',
      },
      audio: false,
    });

    // Everything past the permission grant can still fail - model download,
    // GPU driver, autoplay policy. If it does, release the camera before
    // bailing out: otherwise the webcam light stays on with no tracking, which
    // looks exactly like a hung app.
    try {
      this.video.srcObject = this.stream;
      this.video.playsInline = true;
      this.video.muted = true;
      await this.video.play();
      await new Promise<void>((resolve) => {
        if (this.video.readyState >= 2) return resolve();
        this.video.addEventListener('loadeddata', () => resolve(), { once: true });
      });

      onStatus?.('Loading pose model...');
      this.fileset = await this.resolveFileset();

      try {
        this.landmarker = await this.createLandmarker('GPU');
      } catch (gpuErr) {
        console.warn('[graufence] GPU pose model failed, falling back to CPU', gpuErr);
        onStatus?.('Preparing tracking (CPU)...');
        this.landmarker = await this.createLandmarker('CPU');
      }

      onStatus?.('Warming up...');
      try {
        this.landmarker.detectForVideo(this.video, performance.now());
      } catch {
        // A cold first frame can fail harmlessly; the loop retries.
      }

      this.running = true;
      this.error = null;
      this.detectFails = 0;
      this.lastVideoTime = -1;
      onStatus?.('Ready');
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  /** Prefers the copy shipped with the app; falls back to the CDN. */
  private async resolveFileset(): Promise<unknown> {
    try {
      return await FilesetResolver.forVisionTasks(LOCAL_WASM_PATH);
    } catch (err) {
      console.warn('[graufence] local MediaPipe WASM unavailable, using CDN', err);
      return FilesetResolver.forVisionTasks(CDN_WASM_PATH);
    }
  }

  stop(): void {
    this.running = false;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
    this.landmarks = [];
    try {
      this.landmarker?.close();
    } catch {
      // Closing an already-torn-down landmarker is not worth reporting.
    }
    this.landmarker = null;
  }

  /**
   * Runs inference against the newest camera frame.
   *
   * Cheap to call every animation frame: it returns the previous landmarks
   * unchanged when the camera has not produced a new frame yet (camera ~30 fps,
   * render 60 fps) or when the inference budget says to wait.
   */
  update(nowMs: number): TrackerResult {
    if (!this.running || !this.landmarker) {
      return { landmarks: this.landmarks, fresh: false };
    }
    const video = this.video;
    if (video.readyState < 2 || video.currentTime === this.lastVideoTime) {
      return { landmarks: this.landmarks, fresh: false };
    }
    if (nowMs - this.lastDetectAt < DETECT_INTERVAL_MS) {
      return { landmarks: this.landmarks, fresh: false };
    }

    this.lastVideoTime = video.currentTime;
    this.lastDetectAt = nowMs;
    const t0 = performance.now();

    let result;
    try {
      result = this.landmarker.detectForVideo(video, nowMs);
      this.detectFails = 0;
    } catch (err) {
      // A GPU pipeline can initialize fine and then throw on every frame. Do
      // not swallow that forever: rebuild on CPU after a few failures, and only
      // surface an error if the CPU path fails too.
      this.detectFails++;
      if (this.delegate === 'GPU' && this.detectFails >= 3 && !this.rebuilding) {
        void this.rebuildOnCpu();
      } else if (this.delegate === 'CPU') {
        this.error = err as Error;
      }
      return { landmarks: this.landmarks, fresh: false };
    }

    const elapsed = performance.now() - t0;
    this.inferenceAcc += elapsed;
    this.inferenceCount++;
    if (this.inferenceCount >= 20) {
      this.fps = 1000 / (this.inferenceAcc / this.inferenceCount);
      this.inferenceAcc = 0;
      this.inferenceCount = 0;
    }

    // `landmarks` is image-normalized; `worldLandmarks` is metric but noisier
    // for a single camera. The z we want (arm extension) is in the former.
    const list = result?.landmarks?.[0];
    this.landmarks = list ? (list as Landmark[]) : [];
    return { landmarks: this.landmarks, fresh: true };
  }
}
