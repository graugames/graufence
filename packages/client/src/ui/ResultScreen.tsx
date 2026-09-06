/**
 * The end of a match: who won, by how much, and what to do next.
 *
 * Rematch is the primary action, because the common case is two people who
 * want to go again immediately. It needs both players to agree, so the button
 * reports that it is waiting rather than appearing to do nothing.
 */

import { appStore, clearLog, useApp } from '../state/app.js';
import { getRuntime } from '../game/runtime.js';

export function ResultScreen() {
  const runtime = getRuntime();
  const winner = useApp((s) => s.matchWinner);
  const slot = useApp((s) => s.slot);
  const scores = useApp((s) => s.scores);
  const mode = useApp((s) => s.mode);
  const rematchWanted = useApp((s) => s.rematchWanted);
  const opponentStatus = useApp((s) => s.opponentStatus);

  const mySlot = mode === 'local' ? 0 : (slot ?? 0);
  const won = winner === mySlot;
  const drawn = winner === null;

  function rematch() {
    clearLog();
    if (mode === 'local') {
      runtime.startPractice('even');
      appStore.set({ matchWinner: null, screen: 'arena' });
      return;
    }
    appStore.set({ rematchWanted: true });
    runtime.connection.requestRematch();
  }

  function toMenu() {
    clearLog();
    if (mode === 'online') {
      runtime.connection.leaveRoom();
      runtime.connection.disconnect();
    } else {
      runtime.endPractice();
    }
    appStore.set({
      screen: 'menu',
      roomCode: null,
      players: [],
      ready: false,
      rematchWanted: false,
      matchWinner: null,
    });
  }

  return (
    <div className={`screen result ${drawn ? 'draw' : won ? 'win' : 'lose'}`}>
      <h1>{drawn ? 'Draw' : won ? 'You Win' : 'You Lose'}</h1>
      <p className="score">
        {scores[mySlot]} - {scores[mySlot === 0 ? 1 : 0]}
      </p>
      <p className="tagline">
        {drawn
          ? 'Neither boxer took two rounds.'
          : won
            ? 'Good work in the ring.'
            : 'Watch their shoulders, block the line, and slip with your hips.'}
      </p>

      {opponentStatus === 'left' && mode === 'online' && (
        <p className="status warn">Your opponent has left the room.</p>
      )}

      <div className="actions">
        <button
          type="button"
          className="primary"
          onClick={rematch}
          disabled={mode === 'online' && (rematchWanted || opponentStatus === 'left')}
        >
          {rematchWanted ? 'Waiting for opponent...' : 'Rematch'}
        </button>
        <button type="button" className="ghost" onClick={toMenu}>
          Back to menu
        </button>
      </div>
    </div>
  );
}
