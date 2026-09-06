/**
 * The arena.
 *
 * Almost nothing here is React. The canvas is handed to the runtime once and
 * then owned by it entirely; this component's whole job is to mount that
 * canvas, keep it sized, and render the few pieces of chrome around it that
 * change slowly enough to be worth a component: the combat log, the latency
 * pill, the camera thumbnail, the debug panel.
 */

import { useCallback, useEffect, useRef } from 'react';
import { appStore, useApp } from '../state/app.js';
import { getRuntime } from '../game/runtime.js';
import { CameraPreview } from './CameraPreview.js';
import { CombatLog } from './CombatLog.js';
import { DebugPanel } from './DebugPanel.js';

export function ArenaScreen() {
  const runtime = getRuntime();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controls = useApp((s) => s.controls);
  const cameraStatus = useApp((s) => s.cameraStatus);
  const debug = useApp((s) => s.debug);
  const pingMs = useApp((s) => s.pingMs);
  const connection = useApp((s) => s.connection);
  const mode = useApp((s) => s.mode);
  const opponentStatus = useApp((s) => s.opponentStatus);
  const getLandmarks = useCallback(() => runtime.landmarks, [runtime]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    runtime.attachCanvas(canvas);
    runtime.start();

    // ResizeObserver rather than a window listener: the canvas also changes
    // size when the log panel appears or the sidebar wraps on a narrow screen.
    const observer = new ResizeObserver(() => runtime.resize());
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      runtime.stop();
    };
  }, [runtime]);

  function leave() {
    if (mode === 'online') {
      runtime.connection.leaveRoom();
      runtime.connection.disconnect();
    } else {
      runtime.endPractice();
    }
    appStore.set({ screen: 'menu', roomCode: null, players: [], ready: false });
  }

  const pingClass = pingMs < 80 ? 'good' : pingMs < 180 ? 'ok' : 'bad';

  return (
    <div className="screen arena">
      <canvas ref={canvasRef} className="arena-canvas" />

      <div className="arena-chrome">
        <div className="chrome-top">
          {mode === 'online' && (
            <span className={`pill ping ${pingClass}`} title="Round-trip time to the server">
              {connection === 'connected' ? `${pingMs} ms` : connection}
            </span>
          )}
          {mode === 'local' && <span className="pill">practice</span>}
          <button type="button" className="pill button" onClick={leave}>
            Leave
          </button>
        </div>

        {opponentStatus === 'disconnected' && (
          <div className="banner warn" role="status">
            Opponent lost connection - holding their seat.
          </div>
        )}

        <div className="chrome-bottom">
          {controls === 'camera' && cameraStatus === 'ready' && (
            <CameraPreview
              video={runtime.tracker.video}
              getLandmarks={getLandmarks}
              width={200}
              height={150}
              className="camera-preview corner"
            />
          )}
          <CombatLog />
        </div>
      </div>

      {debug && <DebugPanel />}
    </div>
  );
}
