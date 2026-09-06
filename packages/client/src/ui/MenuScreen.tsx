/**
 * The front door: name, control mode, and how you want to play.
 *
 * Deliberately short. The interesting setup (calibration) happens once the
 * camera is running, and practice mode is reachable in one click so a new
 * player can find out what the game feels like before finding an opponent.
 */

import { useState } from 'react';
import { appStore, clearLog, useApp } from '../state/app.js';
import { getRuntime } from '../game/runtime.js';
import { KEYBOARD_HELP } from '../input/keyboard.js';

export function MenuScreen() {
  const controls = useApp((s) => s.controls);
  const playerName = useApp((s) => s.playerName);
  const cameraStatus = useApp((s) => s.cameraStatus);
  const cameraError = useApp((s) => s.cameraError);
  const connection = useApp((s) => s.connection);
  const connectionError = useApp((s) => s.connectionError);

  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const runtime = getRuntime();

  const name = playerName.trim() || 'Boxer';

  /** Camera mode goes through calibration; keyboard mode skips straight in. */
  async function ensureControls(): Promise<boolean> {
    if (controls === 'keyboard') return true;
    if (cameraStatus === 'ready') return true;
    setBusy(true);
    const ok = await runtime.startCamera();
    setBusy(false);
    if (!ok) return false;
    appStore.set({ screen: 'calibration' });
    return false; // calibration will continue the flow
  }

  async function createRoom() {
    if (!(await ensureControls())) return;
    clearLog();
    appStore.set({ mode: 'online', playerName: name });
    runtime.connection.connect();
    runtime.connection.createRoom(name);
  }

  async function joinRoom() {
    const code = joinCode.trim().toUpperCase();
    if (code.length < 4) return;
    if (!(await ensureControls())) return;
    clearLog();
    appStore.set({ mode: 'online', playerName: name });
    runtime.connection.connect();
    runtime.connection.joinRoom(code, name);
  }

  async function practice() {
    if (!(await ensureControls())) return;
    appStore.set({ playerName: name });
    runtime.startPractice('even');
  }

  return (
    <div className="screen menu">
      <header className="brand">
        <div className="brand-kicker">
          <span className="brand-mark">GF</span>
          <span>GRAU GAMES / LIVE ARENA</span>
        </div>
        <h1>
          Grau<span>Battle</span>
        </h1>
        <p className="tagline">
          1v1 boxing, played with your webcam. Your camera feed never leaves this
          machine - only your skeleton moves are sent.
        </p>
      </header>

      <section className="panel menu-panel">
        <div className="panel-title">
          <div>
            <span className="eyebrow">MATCH SETUP</span>
            <h2>Choose your corner</h2>
          </div>
          <span className="panel-meta">LOCAL INPUT / 60 FPS</span>
        </div>
        <label className="field">
          <span>Your name</span>
          <input
            value={playerName}
            maxLength={16}
            placeholder="Boxer"
            onChange={(e) => appStore.set({ playerName: e.target.value })}
          />
        </label>

        <fieldset className="field">
          <legend>Controls</legend>
          <div className="segmented">
            <button
              type="button"
              className={controls === 'camera' ? 'active' : ''}
              onClick={() => appStore.set({ controls: 'camera' })}
            >
              Webcam
            </button>
            <button
              type="button"
              className={controls === 'keyboard' ? 'active' : ''}
              onClick={() => appStore.set({ controls: 'keyboard' })}
            >
              Keyboard
            </button>
          </div>
          <p className="hint">
            {controls === 'camera'
              ? 'You will be asked for camera permission, then calibrated.'
              : 'No camera needed. Full controls are listed below.'}
          </p>
        </fieldset>

        {cameraError && (
          <p className="error" role="alert">
            {cameraError.message}
          </p>
        )}
        {connection === 'failed' && connectionError && (
          <p className="error" role="alert">
            {connectionError} Is the match server running? See the README.
          </p>
        )}

        <div className="actions">
          <button type="button" className="primary" disabled={busy} onClick={createRoom}>
            {busy ? 'Starting camera...' : 'Create a ring'}
          </button>
          <div className="join-row">
            <input
              value={joinCode}
              placeholder="CODE"
              maxLength={8}
              aria-label="Room code"
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void joinRoom();
              }}
            />
            <button type="button" disabled={busy || joinCode.length < 4} onClick={joinRoom}>
              Join
            </button>
          </div>
          <button type="button" className="ghost" disabled={busy} onClick={practice}>
            Spar with the bot
          </button>
        </div>
      </section>

      <details className="panel help menu-help">
        <summary>How to box</summary>
        <ul className="moves">
          <li>
            <strong>Block</strong> - put a glove on the line they are attacking.
            It reduces damage only where your arm actually is.
          </li>
          <li>
            <strong>Straight</strong> - drive a glove forward, fast, with your
            shoulder and hip behind it.
          </li>
          <li>
            <strong>Hook</strong> - sweep your glove across your body.
          </li>
          <li>
            <strong>Counter</strong> - meet their punch with a timed cover. A
            perfect counter briefly staggers them.
          </li>
          <li>
            <strong>Slip</strong> - shift your hips sharply to one side. Your
            character leans the same way, so do not slip into the punch.
          </li>
        </ul>
        <p className="hint">
          Punches and slips cost stamina, and it regenerates only when you stop
          spending it. Best of three rounds, 100 health each.
        </p>
        <h4>Keyboard controls</h4>
        <table className="keys">
          <tbody>
            {KEYBOARD_HELP.map((row) => (
              <tr key={row.keys}>
                <th>{row.keys}</th>
                <td>{row.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
