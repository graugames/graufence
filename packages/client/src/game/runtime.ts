/**
 * The runtime: one requestAnimationFrame loop that owns everything that moves.
 *
 * Flow, once per frame:
 *
 *   camera frame -> landmarks -> normalized pose -> gesture detection
 *                                       |                    |
 *                                       v                    v
 *                              opponent's screen        server (intent only)
 *                                                             |
 *                                                             v
 *                                                   authoritative state -> canvas
 *
 * Two things are worth stating plainly because they shape the whole design:
 *
 *  - **Nothing here re-renders React.** Health, stamina, blade angle and every
 *    effect are drawn straight to the canvas. React only hears about screen
 *    changes (see ../state/app.ts).
 *  - **Local feedback is a lie, and knowingly so.** When you throw an attack
 *    the client flashes it immediately, because 80 ms of network round trip
 *    would make the game feel broken. The server decides what actually
 *    happened, and its numbers overwrite the guess a fraction of a second later.
 */

import {
  ActionDetector,
  MatchEngine,
  PoseNormalizer,
  MATCH,
  TIMING,
  clamp,
} from '@graufence/shared';
import type {
  Calibration,
  DetectedAction,
  HitZone,
  Landmark,
  MatchEvent,
  PoseFrame,
  ServerMessage,
  Slot,
  StateMessage,
} from '@graufence/shared';
import { PoseTracker } from '../cv/poseTracker.js';
import { KeyboardController } from '../input/keyboard.js';
import { Connection } from '../net/connection.js';
import { ArenaRenderer } from '../render/arena.js';
import type { ArenaView, FighterView, IncomingView } from '../render/arena.js';
import { PALETTE } from '../render/palette.js';
import { PracticeBot } from './bot.js';
import type { BotDifficulty } from './bot.js';
import { appStore, describeCameraError, pushLog } from '../state/app.js';
import { createStore } from '../state/store.js';

/** Debug readout, published at a few hertz so the panel does not thrash. */
export interface DebugSnapshot {
  inferenceFps: number;
  renderFps: number;
  pingMs: number;
  confidence: number;
  action: string;
  stamina: number;
  connection: string;
  delegate: string;
  bladeAngle: number;
  guard: string;
  landmarks: number;
}

export const debugStore = createStore<DebugSnapshot>({
  inferenceFps: 0,
  renderFps: 0,
  pingMs: 0,
  confidence: 0,
  action: '-',
  stamina: 100,
  connection: 'offline',
  delegate: '-',
  bladeAngle: 90,
  guard: '-',
  landmarks: 0,
});

const BANNER_MS = 2200;

export class GameRuntime {
  readonly tracker = new PoseTracker();
  readonly connection = new Connection();
  readonly keyboard = new KeyboardController();
  private normalizer = new PoseNormalizer();
  private detector = new ActionDetector();
  private renderer = new ArenaRenderer();

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private rafId = 0;
  private running = false;
  private detachPointer: (() => void) | null = null;

  /** Latest authoritative snapshot from the server. Null in practice mode. */
  private snapshot: StateMessage | null = null;
  private slot: Slot = 0;

  /** Practice mode runs the identical engine locally against a bot. */
  private localEngine: MatchEngine | null = null;
  private bot: PracticeBot | null = null;

  private lastPose: PoseFrame | null = null;
  private lastAction = '-';
  private lastActionAt = 0;
  private banner: string | null = null;
  private bannerTone: 'good' | 'bad' | 'neutral' = 'neutral';
  private bannerUntil = 0;
  private lastDebugAt = 0;
  private seenEventKeys = new Set<number>();
  /** Local lunge animation, decayed each frame. */
  private lungeSelf = 0;
  private lungeFoe = 0;

  constructor() {
    this.connection.onMessage((m) => this.onServerMessage(m));
    this.connection.onStatus((status, detail) => {
      appStore.set({ connection: status, connectionError: detail ?? null });
    });
  }

  // ------------------------------------------------------------------ set-up

  attachCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.resize();
    this.detachPointer?.();
    this.detachPointer = this.keyboard.attachPointer(canvas);
  }

  /** Sizes the backing store to the element, capped for fill-rate reasons. */
  resize(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // Capping DPR at 2 keeps a 4K display from quadrupling the pixels drawn for
    // a look that is mostly flat colour anyway.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(320, Math.round(rect.width * dpr));
    const h = Math.max(240, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  async startCamera(): Promise<boolean> {
    appStore.set({ cameraStatus: 'starting', cameraError: null });
    try {
      await this.tracker.start({
        onStatus: (s) => pushLog(s, 'info'),
      });
      appStore.set({ cameraStatus: 'ready', cameraError: null });
      return true;
    } catch (err) {
      const described = describeCameraError(err);
      appStore.set({ cameraStatus: 'error', cameraError: described });
      pushLog(described.message, 'bad');
      return false;
    }
  }

  stopCamera(): void {
    this.tracker.stop();
    appStore.set({ cameraStatus: 'idle' });
  }

  setCalibration(calibration: Calibration): void {
    this.normalizer.setCalibration(calibration);
    this.detector.reset();
    appStore.set({ calibration, calibrated: true });
  }

  setHandedness(handedness: 'right' | 'left'): void {
    this.normalizer.setHandedness(handedness);
    this.detector.reset();
    appStore.set({ handedness, calibration: this.normalizer.calibration });
  }

  setSensitivity(value: number): void {
    this.detector.setSensitivity(value);
  }

  /** Raw landmarks, for the calibration screen's skeleton overlay. */
  get landmarks(): Landmark[] {
    return this.tracker.update(performance.now()).landmarks;
  }

  get detectorState() {
    return this.detector.state;
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    if (this.running) return;
    this.running = true;
    this.keyboard.attach();
    const loop = (t: number) => {
      if (!this.running) return;
      this.frame(t);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.keyboard.detach();
    this.detachPointer?.();
    this.detachPointer = null;
  }

  /** Starts a practice match against the bot, with no server involved. */
  startPractice(difficulty: BotDifficulty = 'even'): void {
    const now = performance.now();
    this.slot = 0;
    this.snapshot = null;
    this.seenEventKeys.clear();
    this.localEngine = new MatchEngine(
      { id: 'you', name: appStore.get().playerName || 'You' },
      { id: 'bot', name: 'Practice Bot' },
      now,
    );
    this.bot = new PracticeBot(1, difficulty);
    this.localEngine.setReady(0, true);
    this.localEngine.setReady(1, true);
    this.localEngine.startCountdown(now);
    appStore.set({
      mode: 'local',
      screen: 'arena',
      phase: 'countdown',
      round: 1,
      matchWinner: null,
      scores: [0, 0],
    });
  }

  endPractice(): void {
    this.localEngine = null;
    this.bot = null;
  }

  // ------------------------------------------------------------------- frame

  private frame(t: number): void {
    const app = appStore.get();

    // 1. Read the player.
    let actions: DetectedAction[] = [];
    let bladeAngle: number;
    let guard: HitZone | null;
    let wrist = { x: 0.5, y: -0.6 };
    let hipOffset = 0;
    let confidence = 1;

    if (app.controls === 'keyboard') {
      actions = this.keyboard.update(t);
      const ks = this.keyboard.state;
      bladeAngle = ks.bladeAngle;
      guard = ks.guardZone;
      wrist = ks.pose.wrist;
      hipOffset = ks.pose.hips.x;
      this.lastPose = ks.pose;
    } else {
      const { landmarks, fresh } = this.tracker.update(t);
      const pose = this.normalizer.process(landmarks, t);
      this.lastPose = pose;
      // Only feed the detector genuinely new inference results: replaying the
      // same landmarks would read as "the body stopped dead", which throws off
      // every velocity estimate.
      if (fresh) actions = this.detector.update(pose);
      const ds = this.detector.state;
      bladeAngle = ds.bladeAngle;
      guard = ds.guardZone;
      wrist = pose.wrist;
      hipOffset = ds.hipOffset;
      confidence = ds.confidence;
      if (ds.lostTracking !== app.trackingLost) {
        appStore.set({ trackingLost: ds.lostTracking });
      }
    }

    if (guard !== app.guard) appStore.set({ guard });

    // 2. Publish intent.
    this.sendPose(bladeAngle, guard, wrist, hipOffset, confidence);
    for (const action of actions) this.dispatch(action, t);

    // 3. Advance practice mode (online mode is advanced by the server).
    if (this.localEngine) {
      this.bot?.update(this.localEngine, t);
      const events = this.localEngine.tick(t);
      if (events.length > 0) this.handleEvents(events);
    }

    // 4. Draw.
    this.lungeSelf = Math.max(0, this.lungeSelf - 0.04);
    this.lungeFoe = Math.max(0, this.lungeFoe - 0.04);
    if (this.ctx) {
      this.renderer.draw(this.ctx, this.buildView(t, bladeAngle, guard, wrist, hipOffset, confidence), t);
    }

    // 5. Debug, at 5 Hz rather than 60.
    if (t - this.lastDebugAt > 200) {
      this.lastDebugAt = t;
      this.publishDebug(bladeAngle, guard, confidence);
    }
  }

  private sendPose(
    bladeAngle: number,
    guard: HitZone | null,
    wrist: { x: number; y: number },
    hipOffset: number,
    confidence: number,
  ): void {
    if (appStore.get().mode !== 'online') return;
    // Five numbers. This is the entire "video" that reaches the other player.
    this.connection.pushPose(
      { a: bladeAngle, h: hipOffset, wx: wrist.x, wy: wrist.y, c: confidence },
      guard,
    );
  }

  /**
   * Sends one detected action, and shows immediate local feedback for it.
   *
   * The feedback is optimistic on purpose. The server may reject this (stamina,
   * cooldown, a stagger the client did not know about) - in which case the
   * rejection arrives as an event and the log says so.
   */
  private dispatch(action: DetectedAction, t: number): void {
    this.lastAction = action.kind;
    this.lastActionAt = t;

    if (action.kind === 'thrust' || action.kind === 'slash') this.lungeSelf = 1;

    if (this.localEngine) {
      const events = this.localEngine.submitAction(
        0,
        {
          kind: action.kind,
          ...(action.zone ? { zone: action.zone } : {}),
          ...(action.slash ? { slash: action.slash } : {}),
          ...(action.dodge ? { dodge: action.dodge } : {}),
        },
        t,
      );
      this.handleEvents(events);
      return;
    }

    this.connection.sendAction(action.kind, {
      ...(action.zone ? { zone: action.zone } : {}),
      ...(action.slash ? { slash: action.slash } : {}),
      ...(action.dodge ? { dodge: action.dodge } : {}),
    });
  }

  // ------------------------------------------------------------------ server

  private onServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'joined': {
        this.slot = msg.slot;
        appStore.set({
          roomCode: msg.code,
          slot: msg.slot,
          players: msg.players,
          screen: 'lobby',
          mode: 'online',
          matchWinner: null,
          opponentStatus: 'here',
        });
        pushLog(`Joined room ${msg.code} as fencer ${msg.slot + 1}.`, 'info');
        return;
      }

      case 'lobby': {
        appStore.set({ players: msg.players, phase: msg.phase });
        return;
      }

      case 'state': {
        this.snapshot = msg;
        const app = appStore.get();
        if (app.phase !== msg.phase || app.round !== msg.round) {
          appStore.set({ phase: msg.phase, round: msg.round });
        }
        // The arena screen owns itself once a match starts.
        if (msg.phase !== 'lobby' && app.screen === 'lobby') {
          appStore.set({ screen: 'arena' });
        }
        return;
      }

      case 'events':
        this.handleEvents(msg.events);
        return;

      case 'round_result': {
        const won = msg.winner === this.slot;
        this.showBanner(
          msg.winner === null ? 'DOUBLE - NO POINT' : won ? 'ROUND WON' : 'ROUND LOST',
          msg.winner === null ? 'neutral' : won ? 'good' : 'bad',
        );
        appStore.set({ scores: msg.scores });
        pushLog(
          msg.reason === 'forfeit'
            ? 'Opponent forfeited the round.'
            : `Round ${msg.round}: ${msg.winner === null ? 'no point' : won ? 'you scored' : 'they scored'}.`,
          won ? 'parry' : 'bad',
        );
        return;
      }

      case 'match_over': {
        appStore.set({
          matchWinner: msg.winner,
          scores: msg.scores,
          screen: 'result',
          phase: 'match_over',
        });
        return;
      }

      case 'opponent_status': {
        if (msg.slot === this.slot) return;
        if (msg.status === 'disconnected') {
          appStore.set({ opponentStatus: 'disconnected' });
          pushLog(
            `Opponent dropped - holding their seat for ${msg.graceSeconds ?? 30}s.`,
            'bad',
          );
        } else if (msg.status === 'reconnected') {
          appStore.set({ opponentStatus: 'here' });
          pushLog('Opponent reconnected.', 'info');
        } else {
          appStore.set({ opponentStatus: 'left' });
          pushLog('Opponent left the match.', 'bad');
        }
        return;
      }

      case 'error': {
        pushLog(msg.message, 'bad');
        appStore.set({ connectionError: msg.message });
        return;
      }

      default:
        return;
    }
  }

  /** Turns match events into effects, banners and log lines. */
  private handleEvents(events: MatchEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'countdown':
          appStore.set({ round: event.round, phase: 'countdown', screen: 'arena' });
          this.banner = null;
          break;

        case 'round_start':
          this.showBanner('FENCE!', 'neutral', 900);
          break;

        case 'attack_thrown': {
          if (event.slot === this.slot) this.lungeSelf = 1;
          else this.lungeFoe = 1;
          break;
        }

        case 'attack_resolved': {
          if (this.seenEventKeys.has(event.id)) break;
          this.seenEventKeys.add(event.id);
          if (this.seenEventKeys.size > 400) this.seenEventKeys.clear();

          const iAmDefender = event.defender === this.slot;
          const { result } = event;
          this.renderer.addHit(iAmDefender, result.damage, result.zone, result.outcome);

          const who = iAmDefender ? 'You' : 'They';
          switch (result.outcome) {
            case 'perfect_parry':
              this.renderer.addFlash(iAmDefender ? 'PERFECT PARRY' : 'PARRIED', PALETTE.parry);
              pushLog(`${who} parried perfectly - riposte!`, 'parry');
              break;
            case 'parried':
              pushLog(`${who} parried the ${result.zone} line.`, 'parry');
              break;
            case 'dodged':
              this.renderer.addFlash('DODGE', PALETTE.dodge);
              pushLog(`${who} slipped the attack.`, 'dodge');
              break;
            case 'guarded':
              pushLog(`${who} guarded ${result.zone} (-${result.damage}).`, 'guard');
              break;
            default:
              pushLog(
                `${iAmDefender ? 'Hit on you' : 'Hit'}: ${result.zone} for ${result.damage}.`,
                iAmDefender ? 'bad' : 'hit',
              );
          }
          break;
        }

        case 'dodge':
          if (event.slot !== this.slot) this.renderer.addFlash('THEY DODGE', PALETTE.dodge);
          break;

        case 'parry':
          break;

        case 'rejected': {
          // Only ever about the local player: the server keeps these private.
          const why =
            event.reason === 'stamina'
              ? 'not enough stamina'
              : event.reason === 'cooldown'
                ? 'still recovering'
                : event.reason === 'staggered'
                  ? 'staggered'
                  : event.reason;
          pushLog(`${event.kind} ignored - ${why}.`, 'bad');
          break;
        }

        case 'round_over': {
          if (this.localEngine) {
            const won = event.winner === this.slot;
            this.showBanner(
              event.winner === null ? 'DOUBLE' : won ? 'ROUND WON' : 'ROUND LOST',
              event.winner === null ? 'neutral' : won ? 'good' : 'bad',
            );
          }
          break;
        }

        case 'match_over': {
          if (this.localEngine) {
            appStore.set({
              matchWinner: event.winner,
              screen: 'result',
              phase: 'match_over',
              scores: [
                this.localEngine.state.players[0].roundsWon,
                this.localEngine.state.players[1].roundsWon,
              ],
            });
          }
          break;
        }

        default:
          break;
      }
    }
  }

  private showBanner(text: string, tone: 'good' | 'bad' | 'neutral', ms = BANNER_MS): void {
    this.banner = text;
    this.bannerTone = tone;
    this.bannerUntil = performance.now() + ms;
  }

  // -------------------------------------------------------------------- view

  /**
   * Builds the render view from whichever authority is in charge.
   *
   * Online, that is the server snapshot; in practice mode it is the local
   * engine. Both produce the same shape, so the renderer never learns which.
   */
  private buildView(
    t: number,
    bladeAngle: number,
    guard: HitZone | null,
    wrist: { x: number; y: number },
    hipOffset: number,
    confidence: number,
  ): ArenaView {
    const app = appStore.get();
    const banner = this.banner && t < this.bannerUntil ? this.banner : null;

    const trackingWarning =
      app.controls === 'camera' && app.cameraStatus === 'ready' && app.trackingLost
        ? 'Cannot see you - step back so your head, hands and hips are all in frame.'
        : app.controls === 'camera' && app.cameraStatus === 'error'
          ? 'Camera unavailable - press K for keyboard controls.'
          : null;

    const blank = (isSelf: boolean, side: -1 | 1): FighterView => ({
      name: isSelf ? 'You' : 'Opponent',
      side,
      isSelf,
      health: MATCH.startingHealth,
      stamina: MATCH.startingStamina,
      roundsWon: 0,
      connected: true,
      staggered: false,
      bladeAngle: isSelf ? bladeAngle : 90,
      guard: isSelf ? guard : null,
      hipOffset: isSelf ? hipOffset : 0,
      wrist: isSelf ? wrist : { x: 0.5, y: -0.6 },
      confidence: isSelf ? confidence : 1,
      lungeProgress: isSelf ? this.lungeSelf : this.lungeFoe,
    });

    let me = blank(true, -1);
    let them = blank(false, 1);
    let phase: ArenaView['phase'] = 'lobby';
    let round = app.round;
    let countdown: number | null = null;
    let incoming: IncomingView[] = [];

    const engine = this.localEngine;
    if (engine) {
      const s = engine.state;
      phase = s.phase;
      round = s.round;
      const mine = s.players[0];
      const theirs = s.players[1];
      me = {
        ...me,
        name: mine.name,
        health: mine.health,
        stamina: mine.stamina,
        roundsWon: mine.roundsWon,
        staggered: t < mine.staggeredUntil,
      };
      them = {
        ...them,
        name: theirs.name,
        health: theirs.health,
        stamina: theirs.stamina,
        roundsWon: theirs.roundsWon,
        staggered: t < theirs.staggeredUntil,
        bladeAngle: this.bot?.bladeAngle ?? 90,
        guard: theirs.guardZone,
      };
      if (s.phase === 'countdown') countdown = Math.max(0, (s.phaseEndsAt - t) / 1000);
      incoming = s.pending.map((a) => ({
        id: a.id,
        fromSelf: a.attacker === 0,
        zone: a.zone,
        kind: a.kind,
        progress: clamp(
          1 - (a.landsAt - t) / Math.max(1, a.landsAt - a.thrownAt),
          0,
          1,
        ),
      }));
    } else if (this.snapshot) {
      const s = this.snapshot;
      phase = s.phase;
      round = s.round;
      const mine = s.players[this.slot];
      const theirs = s.players[this.slot === 0 ? 1 : 0];
      me = {
        ...me,
        name: mine.name,
        health: mine.health,
        stamina: mine.stamina,
        roundsWon: mine.roundsWon,
        connected: mine.connected,
        staggered: mine.staggered,
      };
      them = {
        ...them,
        name: theirs.name,
        health: theirs.health,
        stamina: theirs.stamina,
        roundsWon: theirs.roundsWon,
        connected: theirs.connected,
        staggered: theirs.staggered,
        guard: theirs.guard,
        bladeAngle: theirs.pose?.a ?? 90,
        hipOffset: theirs.pose?.h ?? 0,
        wrist: theirs.pose ? { x: theirs.pose.wx, y: theirs.pose.wy } : { x: 0.5, y: -0.6 },
        confidence: theirs.pose?.c ?? 1,
      };
      if (s.phase === 'countdown') {
        countdown = Math.max(0, (this.connection.toLocalTime(s.phaseEndsAt) - Date.now()) / 1000);
      }
      incoming = s.incoming.map((a) => {
        const landsLocal = this.connection.toLocalTime(a.landsAt);
        const windup = a.kind === 'thrust'
          ? TIMING.thrustWindupSeconds * 1000
          : TIMING.slashWindupSeconds * 1000;
        return {
          id: a.id,
          fromSelf: a.attacker === this.slot,
          zone: a.zone,
          kind: a.kind,
          progress: clamp(1 - (landsLocal - Date.now()) / windup, 0, 1),
        };
      });
    }

    return {
      me,
      them,
      phase,
      round,
      countdown,
      incoming,
      banner,
      bannerTone: this.bannerTone,
      trackingWarning,
    };
  }

  private publishDebug(bladeAngle: number, guard: HitZone | null, confidence: number): void {
    const app = appStore.get();
    const engine = this.localEngine;
    const stamina = engine
      ? engine.state.players[0].stamina
      : (this.snapshot?.players[this.slot].stamina ?? 100);

    debugStore.set({
      inferenceFps: Math.round(this.tracker.fps * 10) / 10,
      renderFps: Math.round(this.renderer.fps * 10) / 10,
      pingMs: Math.round(this.connection.pingMs),
      confidence: Math.round(confidence * 100) / 100,
      action:
        performance.now() - this.lastActionAt < 900 ? this.lastAction : '-',
      stamina: Math.round(stamina),
      connection: app.connection,
      delegate: app.controls === 'keyboard' ? 'keyboard' : this.tracker.delegate,
      bladeAngle: Math.round(bladeAngle),
      guard: guard ?? '-',
      landmarks: this.lastPose?.valid ? 33 : 0,
    });
    appStore.set({ pingMs: Math.round(this.connection.pingMs) });
  }
}

/** One runtime per page. Created lazily so tests can import this module. */
let singleton: GameRuntime | null = null;
export function getRuntime(): GameRuntime {
  if (!singleton) singleton = new GameRuntime();
  return singleton;
}
