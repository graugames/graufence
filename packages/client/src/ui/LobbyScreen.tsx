/**
 * The lobby: a room code to share, who is in the room, and a ready button.
 *
 * The one job worth doing well here is making the code easy to pass to another
 * person - hence the oversized type, the copy button, and a link that carries
 * the code so the other player never has to type it at all.
 */

import { useState } from 'react';
import { appStore, useApp } from '../state/app.js';
import { getRuntime } from '../game/runtime.js';

export function LobbyScreen() {
  const runtime = getRuntime();
  const roomCode = useApp((s) => s.roomCode);
  const players = useApp((s) => s.players);
  const slot = useApp((s) => s.slot);
  const ready = useApp((s) => s.ready);
  const connection = useApp((s) => s.connection);
  const [copied, setCopied] = useState(false);

  const inviteUrl =
    typeof window === 'undefined' || !roomCode
      ? ''
      : `${window.location.origin}${window.location.pathname}?room=${roomCode}`;

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be refused; the code is on screen regardless.
      setCopied(false);
    }
  }

  function toggleReady() {
    const next = !ready;
    appStore.set({ ready: next });
    runtime.connection.setReady(next);
  }

  function leave() {
    runtime.connection.leaveRoom();
    runtime.connection.disconnect();
    appStore.set({
      screen: 'menu',
      roomCode: null,
      players: [],
      ready: false,
      slot: null,
    });
  }

  const opponent = players.find((p) => p.slot !== slot);

  return (
    <div className="screen lobby">
      <h2>Room</h2>
      <div className="room-code" aria-label="Room code">
        {roomCode ?? '----'}
      </div>
      <p className="tagline">Give this code to your opponent, or send them the link.</p>

      <div className="actions inline">
        <button type="button" onClick={copyInvite} disabled={!inviteUrl}>
          {copied ? 'Link copied' : 'Copy invite link'}
        </button>
      </div>

      <ul className="players">
        {[0, 1].map((seat) => {
          const player = players.find((p) => p.slot === seat);
          const isMe = seat === slot;
          return (
            <li key={seat} className={player ? (player.ready ? 'ready' : 'waiting') : 'empty'}>
              <span className="dot" aria-hidden="true" />
              <span className="name">
                {player ? player.name : 'Waiting for a fencer...'}
                {isMe && player ? ' (you)' : ''}
              </span>
              <span className="status">
                {!player ? '' : !player.connected ? 'reconnecting' : player.ready ? 'ready' : 'not ready'}
              </span>
            </li>
          );
        })}
      </ul>

      {connection !== 'connected' && (
        <p className="status warn">Connection: {connection}</p>
      )}

      <div className="actions">
        <button
          type="button"
          className={ready ? 'ghost' : 'primary'}
          onClick={toggleReady}
          disabled={connection !== 'connected'}
        >
          {ready ? 'Cancel ready' : 'Ready'}
        </button>
        <button type="button" className="ghost" onClick={leave}>
          Leave room
        </button>
      </div>

      <p className="hint">
        {opponent
          ? ready
            ? 'Waiting for your opponent to ready up. The match starts the moment you both are.'
            : 'Both fencers must be ready to begin.'
          : 'The match starts once someone joins and you are both ready.'}
      </p>
    </div>
  );
}
