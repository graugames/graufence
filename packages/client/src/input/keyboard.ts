/**
 * Keyboard and mouse fallback.
 *
 * This exists for three separate reasons, all of which matter:
 *
 *  - Development. Iterating on combat while standing in front of a webcam
 *    waving a hand is miserable. `?keys=1` makes the whole game playable from
 *    a chair.
 *  - Testing. Automated tests need a control source that is deterministic; a
 *    camera is neither available on CI nor repeatable.
 *  - Players. No camera, a denied permission, or a room too dark to track in
 *    should mean "play with keys", not "cannot play".
 *
 * Crucially it produces the *same* outputs as the camera path - a pose frame,
 * two gloves, a block zone and action events - so everything downstream (prediction,
 * networking, rendering, the server) is identical in both modes.
 */

import type {
  DetectedAction,
  HitZone,
  PoseFrame,
  Sword,
} from '@graufence/shared';
import {
  COOLDOWN,
  boxingGuardForPose,
  boxingZoneForHand,
  computeSword,
  fromAngle,
  lerpAngle,
  POSE,
} from '@graufence/shared';

export interface KeyboardState {
  pose: PoseFrame;
  blade: Sword;
  bladeAngle: number;
  guardZone: HitZone | null;
}

/** The control scheme, in one place so the help panel cannot drift from it. */
export const KEYBOARD_HELP: { keys: string; action: string }[] = [
  { keys: 'Mouse', action: 'Aim the lead glove' },
  { keys: 'Space', action: 'Straight punch' },
  { keys: 'J', action: 'Left-to-right hook' },
  { keys: 'K', action: 'Right-to-left hook' },
  { keys: 'L / Right click', action: 'Cover / block' },
  { keys: 'Q / E', action: 'Slip left / right with your hips' },
  { keys: 'A / D', action: 'Turn your guard left / right' },
  { keys: 'W / S', action: 'Raise / lower your guard' },
  { keys: 'Hold still', action: 'Keep your gloves on a line to block it' },
];

const ANGLE_SPEED_DEG_PER_SEC = 220;

/**
 * A fake but well-behaved pose, so the renderer and the network layer cannot
 * tell the difference between a keyboard player and a tracked one.
 */
function poseForAngle(angle: number, hipOffset: number, t: number): PoseFrame {
  const shoulder = { x: 0.42, y: -0.95 };
  const dir = fromAngle(angle);
  // Place the wrist a forearm out from the shoulder along the aim direction,
  // then put the elbow between them - exactly the geometry computeSword wants.
  const wrist = { x: shoulder.x + dir.x * 0.75, y: shoulder.y + dir.y * 0.75 };
  const elbow = { x: shoulder.x + dir.x * 0.35, y: shoulder.y + dir.y * 0.35 };
  return {
    t,
    handedness: 'right',
    confidence: 1,
    valid: true,
    wrist: { x: wrist.x + hipOffset, y: wrist.y },
    elbow: { x: elbow.x + hipOffset, y: elbow.y },
    shoulder: { x: shoulder.x + hipOffset, y: shoulder.y },
    offWrist: { x: -0.55 + hipOffset, y: -0.45 },
    offElbow: { x: -0.5 + hipOffset, y: -0.7 },
    hips: { x: hipOffset, y: 0 },
    shoulders: { x: hipOffset, y: -1 },
    head: { x: hipOffset, y: -1.45 },
    wristDepth: 0,
    rawScale: 0.22,
  };
}

export class KeyboardController {
  private keys = new Set<string>();
  private angle = 90;
  private targetAngle: number | null = null;
  private hipOffset = 0;
  private hipTarget = 0;
  private lastT = 0;
  private lastFire: Record<string, number> = {};
  private queued: DetectedAction[] = [];
  private detachFns: (() => void)[] = [];
  private attached = false;

  state: KeyboardState;

  constructor() {
    this.state = {
      pose: poseForAngle(90, 0, 0),
      blade: computeSword({ x: 0.42, y: -1.7 }, { x: 0.42, y: -1.3 }, POSE.swordExtension),
      bladeAngle: 90,
      guardZone: 'head',
    };
  }

  /** Starts listening. Returns a detach function; safe to call twice. */
  attach(target: HTMLElement | Window = window): () => void {
    if (this.attached) return () => this.detach();
    this.attached = true;

    const onKeyDown = (ev: Event) => {
      const e = ev as KeyboardEvent;
      // Never steal keys from a text field - the room code input lives on the
      // same screen as the controls.
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      const key = e.key.toLowerCase();
      if (key === ' ' || key.startsWith('arrow')) e.preventDefault();
      this.keys.add(key);
      this.press(key);
    };
    const onKeyUp = (ev: Event) => {
      this.keys.delete((ev as KeyboardEvent).key.toLowerCase());
    };
    const onBlur = () => this.keys.clear();

    target.addEventListener('keydown', onKeyDown);
    target.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    this.detachFns = [
      () => target.removeEventListener('keydown', onKeyDown),
      () => target.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('blur', onBlur),
    ];
    return () => this.detach();
  }

  /** Mouse aiming, bound by the arena surface so coordinates make sense. */
  attachPointer(surface: HTMLElement): () => void {
    const onMove = (e: MouseEvent) => {
      const rect = surface.getBoundingClientRect();
      // Aim relative to the lower-centre of the player's half of the arena,
      // which is roughly where their avatar's hand is drawn.
      const originX = rect.left + rect.width * 0.28;
      const originY = rect.top + rect.height * 0.62;
      const dx = e.clientX - originX;
      const dy = e.clientY - originY;
      if (Math.hypot(dx, dy) < 12) return;
      this.targetAngle = (Math.atan2(-dy, dx) * 180) / Math.PI;
    };
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      this.press('l');
    };
    surface.addEventListener('mousemove', onMove);
    surface.addEventListener('contextmenu', onContext);
    return () => {
      surface.removeEventListener('mousemove', onMove);
      surface.removeEventListener('contextmenu', onContext);
    };
  }

  detach(): void {
    for (const fn of this.detachFns) fn();
    this.detachFns = [];
    this.keys.clear();
    this.attached = false;
  }

  /** Cooldowns are enforced here too, so the fallback cannot out-spam a camera. */
  private canFire(kind: DetectedAction['kind'], t: number): boolean {
    const last = this.lastFire[kind] ?? -Infinity;
    if (t - last < COOLDOWN[kind] * 1000) return false;
    if (kind === 'thrust' || kind === 'slash') {
      const lastAttack = Math.max(
        this.lastFire['thrust'] ?? -Infinity,
        this.lastFire['slash'] ?? -Infinity,
      );
      if (t - lastAttack < COOLDOWN.globalAttack * 1000) return false;
    }
    return true;
  }

  /**
   * Handles one key press.
   *
   * Public rather than private so tests can drive the controller without a DOM
   * - the keyboard path is what makes the combat loop testable at all on CI.
   */
  press(key: string): void {
    const t = this.lastT || performance.now();
    const zone = boxingZoneForHand(this.state.pose.wrist);
    const fire = (action: DetectedAction) => {
      if (!this.canFire(action.kind, t)) return;
      this.lastFire[action.kind] = t;
      this.queued.push(action);
    };

    switch (key) {
      case ' ':
      case 'space':
      case 'spacebar':
        fire({ kind: 'thrust', t, zone, confidence: 1 });
        break;
      case 'j':
        fire({ kind: 'slash', t, zone, slash: 'lr', confidence: 1 });
        break;
      case 'k':
        fire({ kind: 'slash', t, zone, slash: 'rl', confidence: 1 });
        break;
      case 'l':
        fire({ kind: 'parry', t, confidence: 1 });
        break;
      case 'q':
        this.hipTarget = -0.5;
        fire({ kind: 'dodge', t, dodge: 'left', confidence: 1 });
        break;
      case 'e':
        this.hipTarget = 0.5;
        fire({ kind: 'dodge', t, dodge: 'right', confidence: 1 });
        break;
      default:
        break;
    }
  }

  /**
   * Advances the simulated body and drains any queued actions.
   * @param t timestamp in milliseconds.
   */
  update(t: number): DetectedAction[] {
    const dt = this.lastT === 0 ? 0 : Math.min(0.1, (t - this.lastT) / 1000);
    this.lastT = t;

    // Mouse aim wins when the mouse has moved; keys nudge from wherever it is.
    if (this.targetAngle !== null) {
      this.angle = lerpAngle(this.angle, this.targetAngle, Math.min(1, dt * 14));
    }
    const step = ANGLE_SPEED_DEG_PER_SEC * dt;
    if (this.keys.has('a')) this.angle += step;
    if (this.keys.has('d')) this.angle -= step;
    if (this.keys.has('w')) this.angle = lerpAngle(this.angle, 90, Math.min(1, dt * 6));
    if (this.keys.has('s')) this.angle = lerpAngle(this.angle, -90, Math.min(1, dt * 6));
    if (this.keys.has('a') || this.keys.has('d') || this.keys.has('w') || this.keys.has('s')) {
      this.targetAngle = null;
    }

    // Dodges spring back to centre, matching how a real dodge decays.
    this.hipOffset += (this.hipTarget - this.hipOffset) * Math.min(1, dt * 9);
    this.hipTarget *= Math.max(0, 1 - dt * 4);

    const pose = poseForAngle(this.angle, this.hipOffset, t);
    const blade = computeSword(pose.wrist, pose.elbow, POSE.swordExtension, this.angle);
    this.state = {
      pose,
      blade,
      bladeAngle: blade.angle,
      // Keyboard gloves are held still between key presses, so the same pose
      // geometry used by camera play determines the block line.
      guardZone: boxingGuardForPose(pose, 0),
    };

    return this.queued.splice(0);
  }
}
