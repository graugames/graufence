/**
 * The screen router.
 *
 * There are five screens and no routing library: the app is a state machine
 * with one `screen` field, and a switch is the honest expression of that.
 */

import { useEffect, useRef } from 'react';
import { appStore, useApp } from './state/app.js';
import { getRuntime } from './game/runtime.js';
import { MenuScreen } from './ui/MenuScreen.js';
import { CalibrationScreen } from './ui/CalibrationScreen.js';
import { LobbyScreen } from './ui/LobbyScreen.js';
import { ArenaScreen } from './ui/ArenaScreen.js';
import { ResultScreen } from './ui/ResultScreen.js';

export function App() {
  const screen = useApp((s) => s.screen);
  const inviteHandled = useRef(false);

  // ?room=CODE is the invite link: land straight in the room instead of making
  // the second player retype a code they were just sent.
  useEffect(() => {
    if (inviteHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('room');
    if (!code) return;
    inviteHandled.current = true;
    const runtime = getRuntime();
    const name = appStore.get().playerName || 'Fencer';
    appStore.set({ mode: 'online', playerName: name });
    runtime.connection.connect();
    runtime.connection.joinRoom(code.toUpperCase(), name);
  }, []);

  // A global shortcut to the keyboard fallback. Someone whose camera fails
  // mid-match should not have to find a menu to keep playing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      if (e.key === 'K' && e.shiftKey) {
        const next = appStore.get().controls === 'camera' ? 'keyboard' : 'camera';
        appStore.set({ controls: next });
      }
      if (e.key === '`') appStore.set({ debug: !appStore.get().debug });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  switch (screen) {
    case 'calibration':
      return <CalibrationScreen />;
    case 'lobby':
      return <LobbyScreen />;
    case 'arena':
      return <ArenaScreen />;
    case 'result':
      return <ResultScreen />;
    default:
      return <MenuScreen />;
  }
}
