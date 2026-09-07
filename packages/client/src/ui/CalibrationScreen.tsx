/**
 * Calibration.
 *
 * The one screen that makes the gesture thresholds mean anything. It captures
 * the player's neutral stance - where their hips sit in frame and how wide
 * their shoulders look - so that afterwards every measurement is in units of
 * *their* body rather than in pixels.
 *
 * It also refuses to let the player through on a bad reading. Calibrating from
 * a half-visible body would bake that error into the whole match, and the
 * failure would show up later as "my thrusts don't register", which nobody
 * would trace back to this screen.
 */

import { useEffect, useRef, useState } from 'react';
import { calibrationFromLandmarks, POSE } from '@graufence/shared';
import type { Landmark } from '@graufence/shared';
import { appStore, useApp } from '../state/app.js';
import { getRuntime } from '../game/runtime.js';
import { CameraPreview } from './CameraPreview.js';

type Readiness =
  | { ok: true }
  | { ok: false; message: string };

function assess(landmarks: Landmark[]): Readiness {
  if (landmarks.length === 0) {
    return { ok: false, message: 'No one in frame. Step in front of the camera.' };
  }
  // The head anchors the avatar and the eight boxing joints make the initial
  // body map stable; knees/ankles remain optional so a seated player can still
  // use the game.
  const needed = [0, 11, 12, 13, 14, 15, 16, 23, 24];
  const weak = needed.filter((i) => (landmarks[i]?.visibility ?? 0) < POSE.minLandmarkConfidence);
  if (weak.length > 0) {
    return {
      ok: false,
      message:
        'Step back a little - your head, shoulders, both arms and hips all need ' +
        'to be visible at once.',
    };
  }
  const ls = landmarks[11];
  const rs = landmarks[12];
  if (!ls || !rs) return { ok: false, message: 'Shoulders not found yet.' };
  const width = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  if (width < 0.08) return { ok: false, message: 'Too far away - come closer to the camera.' };
  if (width > 0.62) return { ok: false, message: 'Too close - step back so your hips are in frame.' };
  return { ok: true };
}

export function CalibrationScreen() {
  const runtime = getRuntime();
  const handedness = useApp((s) => s.handedness);
  const controls = useApp((s) => s.controls);
  const cameraError = useApp((s) => s.cameraError);

  const [readiness, setReadiness] = useState<Readiness>({ ok: false, message: 'Looking...' });
  const [enhance, setEnhance] = useState(false);
  const [sensitivity, setSensitivity] = useState(1);
  const [countdown, setCountdown] = useState<number | null>(null);
  const landmarksRef = useRef<Landmark[]>([]);

  // Poll rather than subscribe: this screen only needs to know a few times a
  // second whether the player is standing correctly.
  useEffect(() => {
    const timer = setInterval(() => {
      const landmarks = runtime.landmarks;
      landmarksRef.current = landmarks;
      setReadiness(assess(landmarks));
    }, 150);
    return () => clearInterval(timer);
  }, [runtime]);

  // A three-second hold before capture, so the player has time to actually get
  // into their stance instead of being measured mid-reach for the mouse.
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      const landmarks = landmarksRef.current;
      const calibration = calibrationFromLandmarks(landmarks, handedness);
      if (calibration) {
        runtime.setCalibration(calibration);
        appStore.set({ screen: 'menu' });
      } else {
        setCountdown(null);
        setReadiness({ ok: false, message: 'Lost you at the last moment - try again.' });
      }
      return;
    }
    const timer = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(timer);
  }, [countdown, handedness, runtime]);

  if (controls === 'keyboard') {
    return (
      <div className="screen calibration">
        <h2>No calibration needed</h2>
        <p>Keyboard controls do not use the camera.</p>
        <button type="button" className="primary" onClick={() => appStore.set({ screen: 'menu' })}>
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="screen calibration">
      <h2>Calibrate</h2>
      <p className="tagline">
        Stand in a boxing stance with both gloves and your hips in frame. This
        is measured once and everything after mirrors your own body.
      </p>

      <div className="calibration-body">
        <div className="preview-wrap">
          <CameraPreview
            video={runtime.tracker.video}
            getLandmarks={() => landmarksRef.current}
            enhance={enhance}
            width={360}
            height={270}
          />
          {countdown !== null && <div className="countdown-overlay">{countdown || 'Hold!'}</div>}
        </div>

        <div className="calibration-controls">
          <p className={readiness.ok ? 'status good' : 'status warn'} role="status">
            {readiness.ok ? 'Looking good - hold that stance.' : readiness.message}
          </p>

          {cameraError && <p className="error">{cameraError.message}</p>}

          <fieldset className="field">
            <legend>Lead hand</legend>
            <div className="segmented">
              <button
                type="button"
                className={handedness === 'right' ? 'active' : ''}
                onClick={() => runtime.setHandedness('right')}
              >
                Right
              </button>
              <button
                type="button"
                className={handedness === 'left' ? 'active' : ''}
                onClick={() => runtime.setHandedness('left')}
              >
                Left
              </button>
            </div>
          </fieldset>

          <label className="field">
            <span>Gesture sensitivity</span>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={sensitivity}
              onChange={(e) => {
                const v = Number(e.target.value);
                setSensitivity(v);
                // The slider is inverted on purpose: dragging right should feel
                // like "more sensitive", which means a *lower* threshold.
                runtime.setSensitivity(2.5 - v);
              }}
            />
            <span className="hint">
              Drag right if your moves are not registering; left if they fire by
              accident.
            </span>
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={enhance}
              onChange={(e) => setEnhance(e.target.checked)}
            />
            <span>
              Brighten the preview (loads OpenCV.js, ~9 MB - preview only, does
              not affect tracking)
            </span>
          </label>

          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={!readiness.ok || countdown !== null}
              onClick={() => setCountdown(3)}
            >
              {countdown !== null ? 'Hold still...' : 'Capture my stance'}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                appStore.set({ controls: 'keyboard', screen: 'menu' });
                runtime.stopCamera();
              }}
            >
              Use the keyboard instead
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
