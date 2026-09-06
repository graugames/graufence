/**
 * The front door: name, control mode, and how you want to play.
 *
 * Deliberately short. The interesting setup (calibration) happens once the
 * camera is running, and practice mode is reachable in one click so a new
 * player can find out what the game feels like before finding an opponent.
 */

import { useState } from 'react';
import { appStore, useApp } from '../state/app.js';
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

  const name = playerName.trim() || 'Fencer';

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
    appStore.set({ mode: 'online', playerName: name });
    runtime.connection.connect();
    runtime.connection.createRoom(name);
  }

  async function joinRoom() {
    const code = joinCode.trim().toUpperCase();
    if (code.length < 4) return;
    if (!(await ensureControls())) return;
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
        <h1>
          Grau<span>Fence</span>
        </h1>
        <p className="tagline">
          1v1 fencing, played with your webcam. Your camera feed never leaves this
          machine - only your moves are sent.
        </p>
      </header>

      <section className="panel">
        <label className="field">
          <span>Your name</span>
          <input
            value={playerName}
            maxLength={16}
            placeholder="Fencer"
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
            {busy ? 'Starting camera...' : 'Create a room'}
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
            Practice against the bot
          </button>
        </div>
      </section>

      <details className="panel help">
        <summary>How to fence</summary>
        <ul className="moves">
          <li>
            <strong>Guard</strong> - hold your blade still on a line. It blocks
            attacks aimed at that line, and only that line.
          </li>
          <li>
            <strong>Thrust</strong> - drive your hand forward, fast, with your
            body behind it.
          </li>
          <li>
            <strong>Slash</strong> - sweep your hand across your body.
          </li>
          <li>
            <strong>Parry</strong> - snap your blade across an incoming attack
            just before it lands. Time it tightly for a Perfect Parry, which
            staggers your opponent.
          </li>
          <li>
            <strong>Dodge</strong> - shift your hips sharply to one side. Do not
            dodge into the line they are attacking.
          </li>
        </ul>
        <p className="hint">
          Attacks and dodges cost stamina, and it regenerates only when you stop
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
