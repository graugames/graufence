/**
 * The retained 3-D arena.
 *
 * The match engine still owns all gameplay state. This renderer only turns the
 * same small view model into a first-person fencing space: a tracked hip turn
 * becomes a gentle camera turn, the local hands and blade stay visible, and
 * the remote fencer occupies the same piste instead of a second flat panel.
 *
 * Geometry and materials are created once. Per-frame work is transforms,
 * visibility and a single WebGL render, which keeps this path comfortable for
 * a 60 Hz pose/render loop.
 */

import * as THREE from 'three';
import type { HitZone, Vec2 } from '@graufence/shared';
import { clamp } from '@graufence/shared';
import { PALETTE } from './palette.js';

export interface FighterView {
  name: string;
  side: -1 | 1;
  isSelf: boolean;
  health: number;
  stamina: number;
  roundsWon: number;
  connected: boolean;
  staggered: boolean;
  bladeAngle: number;
  guard: HitZone | null;
  hipOffset: number;
  wrist: Vec2;
  confidence: number;
  lungeProgress: number;
}

export interface IncomingView {
  id: number;
  fromSelf: boolean;
  zone: HitZone;
  kind: 'thrust' | 'slash';
  progress: number;
}

export interface ArenaView {
  me: FighterView;
  them: FighterView;
  phase: 'lobby' | 'countdown' | 'live' | 'round_over' | 'match_over';
  round: number;
  countdown: number | null;
  incoming: IncomingView[];
  banner: string | null;
  bannerTone: 'good' | 'bad' | 'neutral';
  trackingWarning: string | null;
}

const SELF = 0x58e7ff;
const FOE = 0xff5cc8;
const WHITE = 0xe8eefc;
const FLOOR = 0x0a1120;
const SKY = 0x070b14;
const GRID = 0x24405a;
const PISTE = 0x111d32;

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const limbDirection = new THREE.Vector3();

function cssColor(value: string, fallback: number): number {
  if (value.startsWith('#')) {
    const parsed = Number.parseInt(value.slice(1), 16);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function placeBetween(mesh: THREE.Mesh, start: THREE.Vector3, end: THREE.Vector3, radius: number): void {
  limbDirection.copy(end).sub(start);
  const length = limbDirection.length();
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(Y_AXIS, limbDirection.normalize());
  mesh.scale.set(radius, Math.max(0.001, length), radius);
}

function material(color: number, emissive = 0, opacity = 1): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive,
    emissiveIntensity: emissive ? 0.8 : 0,
    roughness: 0.72,
    metalness: 0.12,
    transparent: opacity < 1,
    opacity,
  });
}

function zoneHeight(zone: HitZone): number {
  return zone === 'head' ? 1.98 : zone === 'torso' ? 1.42 : 0.62;
}

interface HitEffect {
  mesh: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  life: number;
  x: number;
  y: number;
  z: number;
}

/** A low-poly opponent built from a handful of retained meshes. */
class FencerRig {
  readonly group = new THREE.Group();
  private readonly torso: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private readonly limbs: THREE.Mesh[];
  private readonly bladeRoot = new THREE.Group();
  private readonly blade: THREE.Mesh;
  private readonly bladeTip: THREE.Mesh;
  private readonly bodyMaterial: THREE.MeshStandardMaterial;
  private readonly dimMaterial: THREE.MeshStandardMaterial;
  private readonly headPoint = new THREE.Vector3();
  private readonly shoulder = new THREE.Vector3();
  private readonly hip = new THREE.Vector3();
  private readonly elbow = new THREE.Vector3();
  private readonly wrist = new THREE.Vector3();
  private readonly leftKnee = new THREE.Vector3();
  private readonly rightKnee = new THREE.Vector3();
  private readonly leftFoot = new THREE.Vector3();
  private readonly rightFoot = new THREE.Vector3();

  constructor(color: number) {
    const limbGeometry = new THREE.CylinderGeometry(1, 1, 1, 6);
    const torsoGeometry = new THREE.CylinderGeometry(0.28, 0.36, 0.82, 8);
    const headGeometry = new THREE.SphereGeometry(0.22, 12, 8);
    const bladeGeometry = new THREE.BoxGeometry(0.045, 0.045, 1.65);
    const tipGeometry = new THREE.ConeGeometry(0.07, 0.22, 6);

    this.bodyMaterial = material(color, color, 0.96);
    this.dimMaterial = material(color, 0x000000, 0.26);
    this.torso = new THREE.Mesh(torsoGeometry, this.bodyMaterial);
    this.head = new THREE.Mesh(headGeometry, this.bodyMaterial);
    this.limbs = Array.from({ length: 6 }, () => new THREE.Mesh(limbGeometry, this.bodyMaterial));
    this.blade = new THREE.Mesh(bladeGeometry, this.bodyMaterial);
    this.bladeTip = new THREE.Mesh(tipGeometry, this.bodyMaterial);
    this.blade.position.z = -0.82;
    this.bladeTip.position.z = -1.72;
    this.bladeTip.rotation.x = -Math.PI / 2;
    this.bladeRoot.add(this.blade, this.bladeTip);
    this.group.add(this.torso, this.head, ...this.limbs, this.bladeRoot);
  }

  update(fighter: FighterView): void {
    const x = fighter.hipOffset * 2.15;
    this.group.position.set(x, 0, 7.25 - fighter.lungeProgress * 0.5);
    this.group.rotation.y = Math.PI + fighter.hipOffset * 0.34;
    this.group.visible = fighter.connected;

    const signal = clamp(fighter.confidence, 0.18, 1);
    this.bodyMaterial.opacity = fighter.staggered ? 0.46 : 0.94 * signal;
    this.dimMaterial.opacity = 0.2 * signal;

    this.hip.set(0, 1.0, 0);
    this.shoulder.set(0, 1.55, 0);
    this.headPoint.set(0, 1.92, 0);
    this.head.position.copy(this.headPoint);
    placeBetween(this.torso, this.hip, this.shoulder, 0.36);

    // The wrist uses the same normalized pose coordinates as the 2-D client,
    // but is placed into the opponent's local body space.
    const wristX = clamp((fighter.wrist.x - 0.42) * 1.5, -0.72, 0.72);
    const wristY = clamp(1.34 + (-fighter.wrist.y - 0.6) * 0.52, 0.92, 2.05);
    this.elbow.set(wristX * 0.42, 1.45 + (wristY - 1.45) * 0.42, -0.08);
    this.wrist.set(wristX, wristY, -0.3);
    placeBetween(this.limbs[0]!, this.shoulder, this.elbow, 0.13);
    placeBetween(this.limbs[1]!, this.elbow, this.wrist, 0.11);

    this.leftKnee.set(-0.2, 0.52, 0.02);
    this.rightKnee.set(0.2, 0.52, 0.02);
    this.leftFoot.set(-0.26, 0.06, -0.16);
    this.rightFoot.set(0.26, 0.06, 0.22);
    placeBetween(this.limbs[2]!, this.hip, this.leftKnee, 0.14);
    placeBetween(this.limbs[3]!, this.leftKnee, this.leftFoot, 0.11);
    placeBetween(this.limbs[4]!, this.hip, this.rightKnee, 0.14);
    placeBetween(this.limbs[5]!, this.rightKnee, this.rightFoot, 0.11);

    this.bladeRoot.position.copy(this.wrist);
    this.bladeRoot.rotation.set(THREE.MathUtils.degToRad((fighter.bladeAngle - 90) * 0.58), 0, 0);
  }
}

export class Arena3DRenderer {
  private host: HTMLElement | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(62, 1, 0.05, 40);
  private readonly opponent = new FencerRig(FOE);
  private readonly selfHands = new THREE.Group();
  private readonly rightForearm: THREE.Mesh;
  private readonly leftForearm: THREE.Mesh;
  private readonly rightHand: THREE.Mesh;
  private readonly leftHand: THREE.Mesh;
  private readonly localBladeRoot = new THREE.Group();
  private readonly localBlade: THREE.Mesh;
  private readonly rightHandPos = new THREE.Vector3();
  private readonly leftHandPos = new THREE.Vector3();
  private readonly rightShoulderPos = new THREE.Vector3();
  private readonly leftShoulderPos = new THREE.Vector3();
  private readonly targetRings: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>[] = [];
  private readonly incomingRings: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>[] = [];
  private readonly incomingIds = new Array<number>(8).fill(-1);
  private readonly hitEffects: HitEffect[] = [];
  private readonly eventLight: THREE.PointLight;
  private flashColor = SELF;
  private flashPulse = 0;
  private shake = 0;
  private cameraYaw = 0;
  private lastFrameAt = 0;
  private fpsFrames = 0;
  private fpsStartedAt = 0;

  /** Measured render rate, for the debug panel. */
  fps = 0;

  constructor() {
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 9, 24);

    const hemi = new THREE.HemisphereLight(0x9ac7ff, 0x060914, 1.15);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xc8e8ff, 2.3);
    key.position.set(-3, 7, 2);
    this.scene.add(key);
    this.eventLight = new THREE.PointLight(SELF, 0, 6, 2);
    this.eventLight.position.set(0, 1.5, 5.8);
    this.scene.add(this.eventLight);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 40),
      material(FLOOR),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = 8;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(32, 32, GRID, 0x14263a);
    grid.position.set(0, 0.012, 8);
    this.scene.add(grid);

    const piste = new THREE.Mesh(
      new THREE.BoxGeometry(3.6, 0.035, 16),
      material(PISTE, 0x06111d),
    );
    piste.position.set(0, 0.03, 7.4);
    this.scene.add(piste);

    const railMaterial = material(SELF, SELF, 0.32);
    for (const x of [-1.8, 1.8]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.018, 16), railMaterial);
      rail.position.set(x, 0.07, 7.4);
      this.scene.add(rail);
    }

    const ringGeometry = new THREE.TorusGeometry(0.42, 0.018, 8, 32);
    for (const zone of ['head', 'torso', 'left', 'right'] as const) {
      const ring = new THREE.Mesh(
        ringGeometry,
        new THREE.MeshBasicMaterial({ color: FOE, transparent: true, opacity: 0.16 }),
      );
      ring.position.set(0, zoneHeight(zone), 6.88);
      this.targetRings.push(ring);
      this.scene.add(ring);
    }

    for (let i = 0; i < 8; i += 1) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.32, 0.028, 8, 24),
        new THREE.MeshBasicMaterial({ color: SELF, transparent: true, opacity: 0 }),
      );
      this.incomingRings.push(ring);
      this.scene.add(ring);
      const effect = new THREE.Mesh(
        new THREE.TorusGeometry(0.16, 0.035, 8, 20),
        new THREE.MeshBasicMaterial({ color: SELF, transparent: true, opacity: 0 }),
      );
      effect.visible = false;
      this.hitEffects.push({ mesh: effect, life: 0, x: 0, y: 0, z: 0 });
      this.scene.add(effect);
    }

    this.scene.add(this.opponent.group);

    const armGeometry = new THREE.CylinderGeometry(0.075, 0.1, 1, 8);
    const gloveGeometry = new THREE.SphereGeometry(0.07, 10, 8);
    const armMaterial = material(SELF, SELF, 0.95);
    this.rightForearm = new THREE.Mesh(armGeometry, armMaterial);
    this.leftForearm = new THREE.Mesh(armGeometry, armMaterial);
    this.rightHand = new THREE.Mesh(gloveGeometry, armMaterial);
    this.leftHand = new THREE.Mesh(gloveGeometry, armMaterial);
    this.selfHands.add(this.rightForearm, this.leftForearm, this.rightHand, this.leftHand);

    this.localBlade = new THREE.Mesh(
      new THREE.BoxGeometry(0.035, 0.035, 1.7),
      new THREE.MeshStandardMaterial({
        color: WHITE,
        emissive: SELF,
        emissiveIntensity: 1.25,
        metalness: 0.75,
        roughness: 0.25,
      }),
    );
    this.localBlade.position.z = 0.88;
    this.localBladeRoot.add(this.localBlade);
    this.selfHands.add(this.localBladeRoot);
    this.camera.add(this.selfHands);
    this.scene.add(this.camera);
    this.camera.position.set(0, 1.68, 0.02);
    this.camera.rotation.y = Math.PI;
  }

  attach(host: HTMLElement): void {
    this.host = host;
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({
        // The scene is already built from clean low-poly silhouettes. Trading
        // MSAA for a capped drawing buffer keeps pose inference and WebGL
        // responsive on laptops and integrated GPUs.
        antialias: false,
        alpha: false,
        powerPreference: 'high-performance',
      });
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.08;
      this.renderer.domElement.setAttribute('aria-label', '3D fencing arena');
      this.renderer.domElement.style.display = 'block';
      this.renderer.domElement.style.width = '100%';
      this.renderer.domElement.style.height = '100%';
      this.renderer.domElement.style.touchAction = 'none';
    }
    if (this.renderer.domElement.parentElement !== host) host.replaceChildren(this.renderer.domElement);
    this.resize();
  }

  resize(): void {
    if (!this.host || !this.renderer) return;
    const rect = this.host.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  addHit(onSelf: boolean, damage: number, zone: HitZone, outcome: string): void {
    const effect = this.hitEffects.find((candidate) => candidate.life <= 0) ?? this.hitEffects[0];
    if (!effect) return;
    effect.life = 1;
    effect.x = onSelf ? 0 : this.opponent.group.position.x;
    effect.y = zoneHeight(zone) + (onSelf ? -0.15 : 0);
    effect.z = onSelf ? 0.2 : 6.7;
    effect.mesh.material.color.set(cssColor(outcome === 'parried' || outcome === 'perfect_parry' ? PALETTE.parry : PALETTE.hit, FOE));
    effect.mesh.material.opacity = 0.95;
    effect.mesh.visible = true;
    effect.mesh.position.set(effect.x, effect.y, effect.z);
    effect.mesh.scale.setScalar(0.65 + Math.min(0.55, damage / 80));
    this.shake = Math.min(0.18, this.shake + (onSelf ? 0.12 : 0.06));
  }

  addFlash(_text: string, color: string = PALETTE.parry): void {
    this.flashColor = cssColor(color, cssColor(PALETTE.parry, 0xffe066));
    this.flashPulse = 1;
    this.eventLight.color.set(this.flashColor);
    this.shake = Math.min(0.14, this.shake + 0.035);
  }

  draw(view: ArenaView, now: number): void {
    if (!this.renderer) return;
    const dt = this.lastFrameAt === 0 ? 1 / 60 : Math.min(0.1, Math.max(0.001, (now - this.lastFrameAt) / 1000));
    this.lastFrameAt = now;

    this.updateCamera(view.me, dt, now);
    this.updateHands(view.me);
    this.opponent.update(view.them);
    this.updateTargets(view);
    this.updateEffects(dt);

    this.renderer.render(this.scene, this.camera);
    this.fpsFrames += 1;
    if (this.fpsStartedAt === 0) this.fpsStartedAt = now;
    if (now - this.fpsStartedAt >= 500) {
      this.fps = (this.fpsFrames * 1000) / (now - this.fpsStartedAt);
      this.fpsFrames = 0;
      this.fpsStartedAt = now;
    }
  }

  private updateCamera(me: FighterView, dt: number, now: number): void {
    const targetYaw = clamp(me.hipOffset, -0.55, 0.55) * 0.62;
    this.cameraYaw = THREE.MathUtils.damp(this.cameraYaw, targetYaw, 7, dt);
    this.shake = Math.max(0, this.shake - dt * 0.9);
    const shakeX = this.shake * Math.sin(now * 0.045);
    const shakeY = this.shake * 0.55 * Math.cos(now * 0.052);
    this.camera.position.set(shakeX, 1.68 + shakeY, 0.02);
    this.camera.rotation.set(0, Math.PI + this.cameraYaw, 0);
  }

  private updateHands(me: FighterView): void {
    const handX = clamp((me.wrist.x - 0.42) * 0.42, -0.22, 0.22);
    const handY = clamp(-0.34 - (me.wrist.y + 0.6) * 0.14, -0.62, -0.08);
    const right = this.rightHandPos.set(0.25 + handX, handY, -1.12);
    const left = this.leftHandPos.set(-0.05 + handX * 0.35, handY - 0.06, -1.06);
    const shoulderRight = this.rightShoulderPos.set(0.11, -0.78, -0.4);
    const shoulderLeft = this.leftShoulderPos.set(-0.11, -0.8, -0.42);
    placeBetween(this.rightForearm, shoulderRight, right, 0.055);
    placeBetween(this.leftForearm, shoulderLeft, left, 0.05);
    this.rightHand.position.copy(right);
    this.leftHand.position.copy(left);
    this.localBladeRoot.position.copy(right);
    this.localBladeRoot.rotation.set(THREE.MathUtils.degToRad((me.bladeAngle - 90) * 0.58), 0, 0);
    this.selfHands.position.x = me.hipOffset * 0.12;
    this.selfHands.rotation.y = -this.cameraYaw * 0.18;
  }

  private updateTargets(view: ArenaView): void {
    const opponentX = this.opponent.group.position.x;
    for (const [index, ring] of this.targetRings.entries()) {
      ring.position.x = opponentX;
      ring.position.z = 6.88 - view.them.lungeProgress * 0.25;
      ring.material.opacity = view.phase === 'live' ? 0.14 : 0.06;
    }

    for (let i = 0; i < this.incomingRings.length; i += 1) {
      const ring = this.incomingRings[i]!;
      const incoming = view.incoming[i];
      if (!incoming) {
        this.incomingIds[i] = -1;
        ring.material.opacity = 0;
        continue;
      }
      this.incomingIds[i] = incoming.id;
      const pulse = 1 + Math.sin(incoming.progress * Math.PI) * 0.12;
      ring.position.set(opponentX, zoneHeight(incoming.zone), 6.52 - incoming.progress * 0.65);
      ring.scale.setScalar(pulse + incoming.progress * 0.3);
      ring.material.color.set(incoming.fromSelf ? SELF : FOE);
      ring.material.opacity = 0.24 + incoming.progress * 0.64;
      ring.rotation.z = incoming.kind === 'slash' ? incoming.progress * Math.PI : 0;
    }
  }

  private updateEffects(dt: number): void {
    for (const effect of this.hitEffects) {
      if (effect.life <= 0) continue;
      effect.life = Math.max(0, effect.life - dt * 1.9);
      const progress = 1 - effect.life;
      effect.mesh.visible = effect.life > 0;
      effect.mesh.position.set(effect.x, effect.y, effect.z - progress * 0.12);
      effect.mesh.scale.setScalar(0.72 + progress * 1.8);
      effect.mesh.material.opacity = effect.life * 0.9;
    }
    this.flashPulse = Math.max(0, this.flashPulse - dt * 2.7);
    this.eventLight.intensity = this.flashPulse * 3.4;
    this.eventLight.color.set(this.flashColor);
  }
}
