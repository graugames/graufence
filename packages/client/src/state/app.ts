/**
 * The application store: everything React needs to know, and nothing it does not.
 *
 * If a value changes more than a couple of times a second, it does not belong
 * here - it belongs in the runtime, painted onto the canvas. See ./store.ts.
 */

import { createStore, useStoreValue } from './store.js';
import type { Store } from './store.js';
import type {
  Calibration,
  CharacterCustomization,
  Handedness,
  HitZone,
  LobbyPlayer,
  MatchPhase,
  Slot,
} from '@graufence/shared';
import { DEFAULT_CALIBRATION, DEFAULT_CHARACTER } from '@graufence/shared';

export type Screen =
  | 'menu'
  | 'calibration'
  | 'lobby'
  | 'arena'
  | 'result';

export type ConnectionStatus =
  | 'offline'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

export type ControlMode = 'camera' | 'keyboard';

/** Why the camera is unusable, in words a player can act on. */
export type CameraError =
  | { kind: 'denied'; message: string }
  | { kind: 'not_found'; message: string }
  | { kind: 'insecure'; message: string }
  | { kind: 'model'; message: string }
  | { kind: 'unknown'; message: string };

export interface LogEntry {
  id: number;
  text: string;
  tone: 'hit' | 'guard' | 'parry' | 'dodge' | 'info' | 'bad';
}

export interface AppState {
  screen: Screen;
  /** 'local' is the practice bot; 'online' is a real opponent. */
  mode: 'local' | 'online';
  controls: ControlMode;
  handedness: Handedness;
  playerName: string;
  customization: CharacterCustomization;

  calibration: Calibration;
  calibrated: boolean;

  cameraStatus: 'idle' | 'starting' | 'ready' | 'error';
  cameraError: CameraError | null;
  /** Set when the model is loaded but cannot find a body in frame. */
  trackingLost: boolean;

  connection: ConnectionStatus;
  connectionError: string | null;
  roomCode: string | null;
  slot: Slot | null;
  players: LobbyPlayer[];
  ready: boolean;
  phase: MatchPhase;
  round: number;
  pingMs: number;

  matchWinner: Slot | null;
  scores: [number, number];
  opponentStatus: 'here' | 'disconnected' | 'left';
  rematchWanted: boolean;

  log: LogEntry[];
  debug: boolean;
  /** Guard zone the local player is holding, mirrored into the HUD. */
  guard: HitZone | null;
}

const params = new URLSearchParams(
  typeof window === 'undefined' ? '' : window.location.search,
);

const initial: AppState = {
  screen: 'menu',
  mode: 'online',
  // ?keys=1 starts straight in keyboard mode, which is how the game is
  // developed and tested on machines with no camera.
  controls: params.get('keys') === '1' ? 'keyboard' : 'camera',
  handedness: 'right',
  playerName: '',
  customization: { ...DEFAULT_CHARACTER },

  calibration: { ...DEFAULT_CALIBRATION },
  calibrated: false,

  cameraStatus: 'idle',
  cameraError: null,
  trackingLost: false,

  connection: 'offline',
  connectionError: null,
  roomCode: null,
  slot: null,
  players: [],
  ready: false,
  phase: 'lobby',
  round: 0,
  pingMs: 0,

  matchWinner: null,
  scores: [0, 0],
  opponentStatus: 'here',
  rematchWanted: false,

  log: [],
  debug: params.get('debug') === '1' || import.meta.env['VITE_DEBUG'] === '1',
  guard: null,
};

export const appStore: Store<AppState> = createStore(initial);

export function useApp<S>(select: (s: AppState) => S): S {
  return useStoreValue(appStore, select);
}

let logId = 0;
const LOG_LIMIT = 40;

/** Appends to the combat log, keeping it short enough to stay readable. */
export function pushLog(text: string, tone: LogEntry['tone'] = 'info'): void {
  const entry: LogEntry = { id: logId++, text, tone };
  const log = appStore.get().log;
  appStore.set({ log: [entry, ...log].slice(0, LOG_LIMIT) });
}

export function clearLog(): void {
  appStore.set({ log: [] });
}

/** Turns a getUserMedia failure into something a player can actually fix. */
export function describeCameraError(err: unknown): CameraError {
  const name = (err as { name?: string })?.name ?? '';
  const message = (err as { message?: string })?.message ?? String(err);

  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return {
      kind: 'insecure',
      message:
        'Browsers only allow camera access over HTTPS (or on localhost). ' +
        'Open the game on localhost, or serve it over HTTPS.',
    };
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return {
      kind: 'denied',
      message:
        'Camera permission was denied. Click the camera icon in the address ' +
        'bar to allow it, then reload - or play with the keyboard instead.',
    };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return {
      kind: 'not_found',
      message:
        'No camera was found. Plug one in and reload, or switch to keyboard ' +
        'controls to play without one.',
    };
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return {
      kind: 'unknown',
      message:
        'The camera is busy in another app or tab. Close whatever is using ' +
        'it and reload.',
    };
  }
  return { kind: 'unknown', message: message || 'The camera could not be started.' };
}
