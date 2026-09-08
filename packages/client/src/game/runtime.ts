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
 *  - **Nothing here re-renders React at frame rate.** Health, stamina, gloves
 *    angle and every effect go straight to WebGL. React only receives the
 *    low-frequency HUD snapshot and screen changes (see ../state/app.ts).
 *  - **Local feedback is a lie, and knowingly so.** When you throw an attack
 *    the client flashes it immediately, because 80 ms of network round trip
 *    would make the game feel broken. The server decides what actually
 *    happened, and its numbers overwrite the guess a fraction of a second later.
 */

import {
  ActionDetector,
  DEFAULT_CHARACTER,
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
  Vec2,
} from '@graufence/shared';
import { PoseTracker } from '../cv/poseTracker.js';
import { KeyboardController } from '../input/keyboard.js';
import { Connection } from '../net/connection.js';
import { Arena3DRenderer } from '../render/arena3d.js';
import type { ArenaView, FighterView, IncomingView } from '../render/arena3d.js';
import { PALETTE } from '../render/palette.js';
import { PracticeBot } from './bot.js';
import type { BotDifficulty } from './bot.js';
import { appStore, clearLog, describeCameraError, pushLog } from '../state/app.js';
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

/** Low-frequency HUD data; the WebGL scene itself never asks React to render. */
const initialHudFighter = (isSelf: boolean): FighterView => ({
  name: isSelf ? 'You' : 'Opponent',
  customization: { ...DEFAULT_CHARACTER },
  side: isSelf ? -1 : 1,
  isSelf,
  health: MATCH.startingHealth,
  stamina: MATCH.startingStamina,
  roundsWon: 0,
  connected: true,
  staggered: false,
  bladeAngle: 90,
  guard: null,
  hipOffset: 0,
  wrist: { x: 0.5, y: -0.6 },
  elbow: { x: 0.42, y: -0.95 },
  offWrist: { x: -0.55, y: -0.45 },
  offElbow: { x: -0.5, y: -0.7 },
  head: { x: 0, y: -1.45 },
  shoulders: { x: 0, y: -1 },
  hips: { x: 0, y: 0 },
  leftKnee: { x: -0.35, y: 0.85 },
  rightKnee: { x: 0.35, y: 0.85 },
  leftAnkle: { x: -0.4, y: 1.65 },
  rightAnkle: { x: 0.4, y: 1.65 },
  confidence: 1,
  lungeProgress: 0,
  attackProgress: 0,
  attackZone: null,
  attackKind: null,
});

export const arenaHudStore = createStore<ArenaView>({
  me: initialHudFighter(true),
  them: initialHudFighter(false),
  phase: 'lobby',
  round: 1,
  countdown: null,
  incoming: [],
  banner: null,
  bannerTone: 'neutral',
  trackingWarning: null,
});

const BANNER_MS = 2200;

export class GameRuntime {
  readonly tracker = new PoseTracker();
  readonly connection = new Connection();
  readonly keyboard = new KeyboardController();
  private normalizer = new PoseNormalizer();
  private detector = new ActionDetector();
  private renderer = new Arena3DRenderer();

  private surface: HTMLElement | null = null;
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
  private lastHudAt = 0;
  private seenEventKeys = new Set<number>();
  /** Local lunge animation, decayed each frame. */
  private lungeSelf = 0;
  private lungeFoe = 0;
  private selfAttackZone: HitZone | null = null;
  private selfAttackKind: 'thrust' | 'slash' | null = null;
  private foeAttackZone: HitZone | null = null;
  private foeAttackKind: 'thrust' | 'slash' | null = null;
  private optimisticAttackAt = 0;
  private previousFrameAt = 0;

  constructor() {
    this.connection.onMessage((m) => this.onServerMessage(m));
    this.connection.onStatus((status, detail) => {
      appStore.set({ connection: status, connectionError: detail ?? null });
    });
  }

  // ------------------------------------------------------------------ set-up

  attachSurface(surface: HTMLElement): void {
    this.surface = surface;
    this.renderer.attach(surface);
    this.resize();
    this.detachPointer?.();
    this.detachPointer = this.keyboard.attachPointer(surface);
  }

  /** Keeps the WebGL camera and drawing buffer aligned with the mounted surface. */
  resize(): void {
    if (!this.surface) return;
    this.renderer.resize();
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
    clearLog();
    this.slot = 0;
    this.snapshot = null;
    this.seenEventKeys.clear();
    this.localEngine = new MatchEngine(
      {
        id: 'you',
        name: appStore.get().playerName || 'Boxer',
        customization: appStore.get().customization,
      },
      { id: 'bot', name: 'Sparring Bot' },
      now,
    );
    this.bot = new PracticeBot(1, difficulty);
    this.localEngine.setReady(0, true);
    this.localEngine.setReady(1, true);
    this.localEngine.startCountdown(now);
    this.lungeSelf = 0;
    this.lungeFoe = 0;
    this.selfAttackZone = null;
    this.selfAttackKind = null;
    this.foeAttackZone = null;
    this.foeAttackKind = null;
    this.optimisticAttackAt = 0;
    this.previousFrameAt = 0;
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
    let elbow = { x: 0.42, y: -0.95 };
    let offWrist = { x: -0.55, y: -0.45 };
    let offElbow = { x: -0.5, y: -0.7 };
    let hipOffset = 0;
    let confidence = 1;
    let poseForNetwork: PoseFrame;

    if (app.controls === 'keyboard') {
      actions = this.keyboard.update(t);
      const ks = this.keyboard.state;
      bladeAngle = ks.bladeAngle;
      guard = ks.guardZone;
      wrist = ks.pose.wrist;
      elbow = ks.pose.elbow;
      offWrist = ks.pose.offWrist ?? offWrist;
      offElbow = ks.pose.offElbow ?? offElbow;
      hipOffset = ks.pose.hips.x;
      this.lastPose = ks.pose;
      poseForNetwork = ks.pose;
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
      elbow = pose.elbow;
      offWrist = pose.offWrist ?? offWrist;
      offElbow = pose.offElbow ?? offElbow;
      hipOffset = ds.hipOffset;
      confidence = ds.confidence;
      poseForNetwork = pose;
      if (ds.lostTracking !== app.trackingLost) {
        appStore.set({ trackingLost: ds.lostTracking });
      }
    }

    if (guard !== app.guard) appStore.set({ guard });

    // 2. Publish intent.
    this.sendPose(poseForNetwork, bladeAngle, guard, wrist, elbow, offWrist, offElbow, hipOffset, confidence);
    for (const action of actions) this.dispatch(action, t);

    // 3. Advance practice mode (online mode is advanced by the server).
    if (this.localEngine) {
      this.bot?.update(this.localEngine, t);
      const events = this.localEngine.tick(t);
      if (events.length > 0) this.handleEvents(events);
    }

    // 4. Draw.
    const dt = this.previousFrameAt === 0 ? 1 / 60 : Math.min(0.1, (t - this.previousFrameAt) / 1000);
    this.previousFrameAt = t;
    this.lungeSelf = Math.max(0, this.lungeSelf - dt * 1.8);
    this.lungeFoe = Math.max(0, this.lungeFoe - dt * 1.8);
    const view = this.buildView(
      t,
      bladeAngle,
      guard,
      wrist,
      elbow,
      offWrist,
      offElbow,
      hipOffset,
      confidence,
      poseForNetwork,
    );
    if (this.surface) {
      this.renderer.draw(view, t);
    }
    if (t - this.lastHudAt > 80) {
      this.lastHudAt = t;
      arenaHudStore.set(view);
    }

    // 5. Debug, at 5 Hz rather than 60.
    if (t - this.lastDebugAt > 200) {
      this.lastDebugAt = t;
      this.publishDebug(bladeAngle, guard, confidence);
    }
  }

  private sendPose(
    pose: PoseFrame,
    bladeAngle: number,
    guard: HitZone | null,
    wrist: Vec2,
    elbow: Vec2,
    offWrist: Vec2,
    offElbow: Vec2,
    hipOffset: number,
    confidence: number,
  ): void {
    if (appStore.get().mode !== 'online') return;
    // A compact skeleton readout is the entire "video" that reaches the other player.
    this.connection.pushPose(
      {
        a: bladeAngle,
        h: hipOffset,
        wx: wrist.x,
        wy: wrist.y,
        ex: elbow.x,
        ey: elbow.y,
        owx: offWrist.x,
        owy: offWrist.y,
        oex: offElbow.x,
        oey: offElbow.y,
        hx: pose.head.x,
        hy: pose.head.y,
        sx: pose.shoulders.x,
        sy: pose.shoulders.y,
        px: pose.hips.x,
        py: pose.hips.y,
        ...(pose.leftKnee ? { lkx: pose.leftKnee.x, lky: pose.leftKnee.y } : {}),
        ...(pose.rightKnee ? { rkx: pose.rightKnee.x, rky: pose.rightKnee.y } : {}),
        ...(pose.leftAnkle ? { lax: pose.leftAnkle.x, lay: pose.leftAnkle.y } : {}),
        ...(pose.rightAnkle ? { rax: pose.rightAnkle.x, ray: pose.rightAnkle.y } : {}),
        c: confidence,
      },
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

    if (action.kind === 'thrust' || action.kind === 'slash') {
      this.lungeSelf = 1;
      this.selfAttackZone = action.zone ?? 'torso';
      this.selfAttackKind = action.kind;
      this.optimisticAttackAt = t;
    }

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
        pushLog(`Joined ring ${msg.code} as boxer ${msg.slot + 1}.`, 'info');
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
          this.showBanner('FIGHT!', 'neutral', 900);
          break;

        case 'attack_thrown': {
          if (event.slot === this.slot) {
            this.lungeSelf = 1;
            this.selfAttackZone = event.zone;
            this.selfAttackKind = event.kind;
          } else {
            this.lungeFoe = 1;
            this.foeAttackZone = event.zone;
            this.foeAttackKind = event.kind;
          }
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
              this.renderer.addFlash(iAmDefender ? 'PERFECT COUNTER' : 'COUNTERED', PALETTE.parry);
              pushLog(`${who} countered perfectly - they are stunned.`, 'parry');
              break;
            case 'parried':
              pushLog(`${who} blocked the ${result.zone} punch.`, 'parry');
              break;
            case 'dodged':
              this.renderer.addFlash('SLIP', PALETTE.dodge);
              pushLog(`${who} slipped the punch.`, 'dodge');
              break;
            case 'guarded':
              pushLog(`${who} blocked ${result.zone} (-${result.damage}).`, 'guard');
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
          if (event.slot !== this.slot) this.renderer.addFlash('THEY SLIP', PALETTE.dodge);
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
    wrist: Vec2,
    elbow: Vec2,
    offWrist: Vec2,
    offElbow: Vec2,
    hipOffset: number,
    confidence: number,
    pose: PoseFrame,
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
      customization: isSelf ? { ...app.customization } : { ...DEFAULT_CHARACTER },
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
      elbow: isSelf ? elbow : { x: 0.42, y: -0.95 },
      offWrist: isSelf ? offWrist : { x: -0.55, y: -0.45 },
      offElbow: isSelf ? offElbow : { x: -0.5, y: -0.7 },
      head: isSelf ? pose.head : { x: 0, y: -1.45 },
      shoulders: isSelf ? pose.shoulders : { x: 0, y: -1 },
      hips: isSelf ? pose.hips : { x: 0, y: 0 },
      leftKnee: isSelf ? pose.leftKnee : { x: -0.35, y: 0.85 },
      rightKnee: isSelf ? pose.rightKnee : { x: 0.35, y: 0.85 },
      leftAnkle: isSelf ? pose.leftAnkle : { x: -0.4, y: 1.65 },
      rightAnkle: isSelf ? pose.rightAnkle : { x: 0.4, y: 1.65 },
      confidence: isSelf ? confidence : 1,
      lungeProgress: isSelf ? this.lungeSelf : this.lungeFoe,
      attackProgress: 0,
      attackZone: isSelf ? this.selfAttackZone : this.foeAttackZone,
      attackKind: isSelf ? this.selfAttackKind : this.foeAttackKind,
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
        customization: mine.customization,
        health: mine.health,
        stamina: mine.stamina,
        roundsWon: mine.roundsWon,
        staggered: t < mine.staggeredUntil,
      };
      them = {
        ...them,
        name: theirs.name,
        customization: theirs.customization,
        health: theirs.health,
        stamina: theirs.stamina,
        roundsWon: theirs.roundsWon,
        staggered: t < theirs.staggeredUntil,
        bladeAngle: this.bot?.bladeAngle ?? 90,
        guard: theirs.guardZone,
        wrist: botWrist(this.bot?.currentGuard ?? 'head'),
        elbow: botElbow(this.bot?.currentGuard ?? 'head'),
        offWrist: botOffWrist(this.bot?.currentGuard ?? 'head'),
        offElbow: botOffElbow(this.bot?.currentGuard ?? 'head'),
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
        customization: mine.customization,
        health: mine.health,
        stamina: mine.stamina,
        roundsWon: mine.roundsWon,
        connected: mine.connected,
        staggered: mine.staggered,
      };
      them = {
        ...them,
        name: theirs.name,
        customization: theirs.customization,
        health: theirs.health,
        stamina: theirs.stamina,
        roundsWon: theirs.roundsWon,
        connected: theirs.connected,
        staggered: theirs.staggered,
        guard: theirs.guard,
        bladeAngle: theirs.pose?.a ?? 90,
        hipOffset: theirs.pose?.h ?? 0,
        wrist: theirs.pose ? { x: theirs.pose.wx, y: theirs.pose.wy } : { x: 0.5, y: -0.6 },
        elbow:
          theirs.pose?.ex !== undefined && theirs.pose.ey !== undefined
            ? { x: theirs.pose.ex, y: theirs.pose.ey }
            : { x: 0.42, y: -0.95 },
        offWrist:
          theirs.pose?.owx !== undefined && theirs.pose.owy !== undefined
            ? { x: theirs.pose.owx, y: theirs.pose.owy }
            : { x: -0.55, y: -0.45 },
        offElbow:
          theirs.pose?.oex !== undefined && theirs.pose.oey !== undefined
            ? { x: theirs.pose.oex, y: theirs.pose.oey }
            : { x: -0.5, y: -0.7 },
        head:
          theirs.pose?.hx !== undefined && theirs.pose.hy !== undefined
            ? { x: theirs.pose.hx, y: theirs.pose.hy }
            : { x: 0, y: -1.45 },
        shoulders:
          theirs.pose?.sx !== undefined && theirs.pose.sy !== undefined
            ? { x: theirs.pose.sx, y: theirs.pose.sy }
            : { x: 0, y: -1 },
        hips:
          theirs.pose?.px !== undefined && theirs.pose.py !== undefined
            ? { x: theirs.pose.px, y: theirs.pose.py }
            : { x: 0, y: 0 },
        leftKnee:
          theirs.pose?.lkx !== undefined && theirs.pose.lky !== undefined
            ? { x: theirs.pose.lkx, y: theirs.pose.lky }
            : { x: -0.35, y: 0.85 },
        rightKnee:
          theirs.pose?.rkx !== undefined && theirs.pose.rky !== undefined
            ? { x: theirs.pose.rkx, y: theirs.pose.rky }
            : { x: 0.35, y: 0.85 },
        leftAnkle:
          theirs.pose?.lax !== undefined && theirs.pose.lay !== undefined
            ? { x: theirs.pose.lax, y: theirs.pose.lay }
            : { x: -0.4, y: 1.65 },
        rightAnkle:
          theirs.pose?.rax !== undefined && theirs.pose.ray !== undefined
            ? { x: theirs.pose.rax, y: theirs.pose.ray }
            : { x: 0.4, y: 1.65 },
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

    // The authoritative pending list drives the exact contact animation. A
    // short local envelope fills the network gap between the button/gesture
    // and the first server snapshot, so a punch never waits for a packet to
    // become visible.
    const pendingAttack = (fromSelf: boolean): IncomingView | undefined =>
      incoming
        .filter((attack) => attack.fromSelf === fromSelf)
        .sort((a, b) => b.progress - a.progress)[0];
    const optimisticWindow =
      this.selfAttackKind === 'slash'
        ? TIMING.slashWindupSeconds * 1000
        : TIMING.thrustWindupSeconds * 1000;
    const optimisticProgress =
      this.optimisticAttackAt > 0
        ? clamp((t - this.optimisticAttackAt) / Math.max(1, optimisticWindow), 0, 1)
        : 0;
    const selfAttack = pendingAttack(true);
    const foeAttack = pendingAttack(false);
    me.attackProgress = selfAttack?.progress ?? (optimisticProgress < 1 ? optimisticProgress : 0);
    me.attackZone = selfAttack?.zone ?? (me.attackProgress > 0 ? this.selfAttackZone : null);
    me.attackKind = selfAttack?.kind ?? (me.attackProgress > 0 ? this.selfAttackKind : null);
    them.attackProgress = foeAttack?.progress ?? (this.lungeFoe > 0 ? this.lungeFoe : 0);
    them.attackZone = foeAttack?.zone ?? (them.attackProgress > 0 ? this.foeAttackZone : null);
    them.attackKind = foeAttack?.kind ?? (them.attackProgress > 0 ? this.foeAttackKind : null);

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

function botWrist(zone: HitZone): { x: number; y: number } {
  switch (zone) {
    case 'head':
      return { x: 0.18, y: -1.02 };
    case 'torso':
      return { x: 0.22, y: -0.08 };
    case 'left':
      return { x: -0.58, y: -0.42 };
    case 'right':
      return { x: 0.58, y: -0.42 };
  }
}

function botElbow(zone: HitZone): { x: number; y: number } {
  switch (zone) {
    case 'head':
      return { x: 0.34, y: -0.88 };
    case 'torso':
      return { x: 0.36, y: -0.5 };
    case 'left':
      return { x: -0.05, y: -0.62 };
    case 'right':
      return { x: 0.48, y: -0.58 };
  }
}

function botOffWrist(zone: HitZone): { x: number; y: number } {
  return zone === 'head' ? { x: -0.26, y: -0.94 } : { x: -0.3, y: -0.36 };
}

function botOffElbow(zone: HitZone): { x: number; y: number } {
  return zone === 'head' ? { x: -0.28, y: -0.82 } : { x: -0.38, y: -0.58 };
}

/** One runtime per page. Created lazily so tests can import this module. */
let singleton: GameRuntime | null = null;
export function getRuntime(): GameRuntime {
  if (!singleton) singleton = new GameRuntime();
  return singleton;
}
