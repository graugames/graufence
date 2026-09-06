/**
 * The debug panel, opened with ?debug=1 or VITE_DEBUG=1.
 *
 * The numbers here are chosen to answer the questions that actually come up
 * when the game misbehaves: is the model keeping up, is the render keeping up,
 * is it the network, or is it simply that the camera cannot see the player?
 *
 * It reads a store the runtime publishes at 5 Hz rather than every frame -
 * a panel that re-renders 60 times a second would itself become the problem
 * it is meant to diagnose.
 */

import { useStoreValue } from '../state/store.js';
import { debugStore } from '../game/runtime.js';
import { appStore } from '../state/app.js';

function Row({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className={`debug-row${warn ? ' warn' : ''}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

export function DebugPanel() {
  const d = useStoreValue(debugStore, (s) => s);

  return (
    <aside className="debug-panel" aria-label="Debug panel">
      <header>
        <span>debug</span>
        <button type="button" onClick={() => appStore.set({ debug: false })} aria-label="Close">
          x
        </button>
      </header>
      <Row label="inference fps" value={d.inferenceFps} warn={d.inferenceFps > 0 && d.inferenceFps < 12} />
      <Row label="render fps" value={d.renderFps} warn={d.renderFps < 45} />
      <Row label="ping" value={`${d.pingMs} ms`} warn={d.pingMs > 180} />
      <Row label="confidence" value={d.confidence} warn={d.confidence < 0.45} />
      <Row label="action" value={d.action} />
      <Row label="stamina" value={d.stamina} />
      <Row label="guard" value={d.guard} />
      <Row label="lead angle" value={`${d.bladeAngle} deg`} />
      <Row label="connection" value={d.connection} warn={d.connection !== 'connected'} />
      <Row label="delegate" value={d.delegate} />
      <Row label="landmarks" value={d.landmarks} warn={d.landmarks === 0} />
    </aside>
  );
}
