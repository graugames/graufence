/**
 * The retained 3-D arena.
 *
 * The match engine still owns all gameplay state. This renderer only turns the
 * same small view model into a first-person boxing space: a tracked hip turn
 * becomes a gentle camera turn, both local gloves stay visible, and the remote
 * boxer occupies the same ring instead of a second flat panel.
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
  /** Retained in the protocol for compatibility; boxing uses the wrists. */
  bladeAngle: number;
  guard: HitZone | null;
  hipOffset: number;
  wrist: Vec2;
  offWrist: Vec2 | null;
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
  private readonly leadFist: THREE.Mesh;
  private readonly offFist: THREE.Mesh;
  private readonly bodyMaterial: THREE.MeshStandardMaterial;
  private readonly dimMaterial: THREE.MeshStandardMaterial;
  private readonly headPoint = new THREE.Vector3();
  private readonly shoulder = new THREE.Vector3();
  private readonly hip = new THREE.Vector3();
  private readonly elbow = new THREE.Vector3();
  private readonly wrist = new THREE.Vector3();
  private readonly offElbow = new THREE.Vector3();
  private readonly offHand = new THREE.Vector3();
  private readonly leftKnee = new THREE.Vector3();
  private readonly rightKnee = new THREE.Vector3();
  private readonly leftFoot = new THREE.Vector3();
  private readonly rightFoot = new THREE.Vector3();

  constructor(color: number) {
    const limbGeometry = new THREE.CylinderGeometry(1, 1, 1, 6);
    const torsoGeometry = new THREE.CylinderGeometry(0.28, 0.36, 0.82, 8);
    const headGeometry = new THREE.SphereGeometry(0.22, 12, 8);
    const fistGeometry = new THREE.CapsuleGeometry(0.13, 0.12, 4, 8);

    this.bodyMaterial = material(color, color, 0.96);
    this.dimMaterial = material(color, 0x000000, 0.26);
    this.torso = new THREE.Mesh(torsoGeometry, this.bodyMaterial);
    this.head = new THREE.Mesh(headGeometry, this.bodyMaterial);
    this.limbs = Array.from({ length: 8 }, () => new THREE.Mesh(limbGeometry, this.bodyMaterial));
    this.leadFist = new THREE.Mesh(fistGeometry, this.bodyMaterial);
    this.offFist = new THREE.Mesh(fistGeometry, this.bodyMaterial);
    this.leadFist.rotation.z = -0.2;
    this.offFist.rotation.z = 0.2;
    this.group.add(this.torso, this.head, ...this.limbs, this.leadFist, this.offFist);
    this.bodyMaterial.emissiveIntensity = 0.42;
  }

  update(fighter: FighterView): void {
    const x = fighter.hipOffset * 2.15;
    this.group.position.set(x, 0, 4.6 - fighter.lungeProgress * 0.42);
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

    const offWrist = fighter.offWrist ?? { x: -0.55, y: -0.45 };
    const offX = clamp((offWrist.x + 0.42) * 1.2, -0.72, 0.18);
    const offY = clamp(1.34 + (-offWrist.y - 0.6) * 0.52, 0.92, 2.05);
    this.offElbow.set(offX * 0.48, 1.45 + (offY - 1.45) * 0.42, -0.02);
    this.offHand.set(offX, offY, -0.16);
    placeBetween(this.limbs[2]!, this.shoulder, this.offElbow, 0.12);
    placeBetween(this.limbs[3]!, this.offElbow, this.offHand, 0.1);

    this.leftKnee.set(-0.2, 0.52, 0.02);
    this.rightKnee.set(0.2, 0.52, 0.02);
    this.leftFoot.set(-0.26, 0.06, -0.16);
    this.rightFoot.set(0.26, 0.06, 0.22);
    placeBetween(this.limbs[4]!, this.hip, this.leftKnee, 0.14);
    placeBetween(this.limbs[5]!, this.leftKnee, this.leftFoot, 0.11);
    placeBetween(this.limbs[6]!, this.hip, this.rightKnee, 0.14);
    placeBetween(this.limbs[7]!, this.rightKnee, this.rightFoot, 0.11);

    this.leadFist.position.copy(this.wrist);
    this.offFist.position.copy(this.offHand);
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
  private readonly rightHandPos = new THREE.Vector3();
  private readonly leftHandPos = new THREE.Vector3();
  private readonly rightShoulderPos = new THREE.Vector3();
  private readonly leftShoulderPos = new THREE.Vector3();
  private readonly targetRings: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>[] = [];
  private readonly incomingRings: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>[] = [];
  private readonly punchGhosts: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[] = [];
  private readonly ghostFrom = new THREE.Vector3();
  private readonly ghostTo = new THREE.Vector3();
  private readonly hitEffects: HitEffect[] = [];
  private readonly eventLight: THREE.PointLight;
  private flashColor = SELF;
  private flashPulse = 0;
  private shake = 0;
  private cameraYaw = 0;
  private cameraLean = 0;
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
    this.eventLight.position.set(0, 1.5, 3.5);
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

    // A compact ring gives the fight a readable frame without filling the
    // scene with expensive detail. The player and opponent stay inside the
    // same ropes, so a hip dodge reads as a real lateral escape.
    const ringMat = material(0x16243a, 0x06111d);
    const ringFloor = new THREE.Mesh(new THREE.BoxGeometry(5.8, 0.045, 10.5), ringMat);
    ringFloor.position.set(0, 0.055, 3.6);
    this.scene.add(ringFloor);

    const ropeWhite = material(0xd9e5f2, 0x15324b, 0.84);
    const ropeRed = material(0xb83b62, 0x3d1025, 0.9);
    const ropeHeights = [0.72, 1.08, 1.44];
    for (const [level, y] of ropeHeights.entries()) {
      const ropeMaterial = level === 1 ? ropeRed : ropeWhite;
      for (const z of [-1.55, 8.7]) {
        const rope = new THREE.Mesh(new THREE.BoxGeometry(5.95, 0.035, 0.035), ropeMaterial);
        rope.position.set(0, y, z);
        this.scene.add(rope);
      }
      for (const x of [-2.95, 2.95]) {
        const rope = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 10.25), ropeMaterial);
        rope.position.set(x, y, 3.6);
        this.scene.add(rope);
      }
    }

    const postMaterial = material(0x1a2435, 0x07111e);
    for (const x of [-2.95, 2.95]) {
      for (const z of [-1.55, 8.7]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 2.1, 8), postMaterial);
        post.position.set(x, 1.04, z);
        this.scene.add(post);
        const cap = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 6), ropeRed);
        cap.position.set(x, 2.1, z);
        this.scene.add(cap);
      }
    }

    const backdrop = new THREE.Mesh(
      new THREE.BoxGeometry(9.5, 4.2, 0.16),
      material(0x0c1528, 0x02050c),
    );
    backdrop.position.set(0, 2.05, 9.35);
    this.scene.add(backdrop);

    const sign = new THREE.Mesh(
      new THREE.BoxGeometry(4.8, 0.72, 0.08),
      material(0x111e34, 0x09233b),
    );
    sign.position.set(0, 3.35, 9.2);
    this.scene.add(sign);

    const audienceMaterials = [
      material(0x26304a, 0x0b1020),
      material(0x3d2b52, 0x160c20),
      material(0x203b4d, 0x071521),
    ];
    const audienceHead = new THREE.SphereGeometry(0.14, 8, 6);
    for (let row = 0; row < 2; row += 1) {
      for (let i = 0; i < 9; i += 1) {
        const spectator = new THREE.Mesh(audienceHead, audienceMaterials[(i + row) % audienceMaterials.length]!);
        spectator.position.set(-3.7 + i * 0.92, 0.34 + row * 0.34, 8.95 + row * 0.22);
        this.scene.add(spectator);
      }
    }

    const ringGeometry = new THREE.TorusGeometry(0.42, 0.018, 8, 32);
    for (const zone of ['head', 'torso', 'left', 'right'] as const) {
      const ring = new THREE.Mesh(
        ringGeometry,
        new THREE.MeshBasicMaterial({ color: FOE, transparent: true, opacity: 0.16 }),
      );
      ring.position.set(0, zoneHeight(zone), 4.22);
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
      const ghost = new THREE.Mesh(
        new THREE.SphereGeometry(0.13, 8, 6),
        new THREE.MeshBasicMaterial({ color: SELF, transparent: true, opacity: 0 }),
      );
      this.punchGhosts.push(ghost);
      this.scene.add(ghost);
      const effect = new THREE.Mesh(
        new THREE.TorusGeometry(0.16, 0.035, 8, 20),
        new THREE.MeshBasicMaterial({ color: SELF, transparent: true, opacity: 0 }),
      );
      effect.visible = false;
      this.hitEffects.push({ mesh: effect, life: 0, x: 0, y: 0, z: 0 });
      this.scene.add(effect);
    }

    this.scene.add(this.opponent.group);

    // Keep the hand silhouette readable without turning the foreground into
    // two glowing orbs. The cylinders use unit radius because placeBetween
    // supplies the actual world-space thickness per frame.
    const armGeometry = new THREE.CylinderGeometry(1, 1, 1, 8);
    const gloveGeometry = new THREE.CapsuleGeometry(0.065, 0.1, 4, 8);
    const armMaterial = material(0x17364b, SELF, 0.95);
    this.rightForearm = new THREE.Mesh(armGeometry, armMaterial);
    this.leftForearm = new THREE.Mesh(armGeometry, armMaterial);
    this.rightHand = new THREE.Mesh(gloveGeometry, armMaterial);
    this.leftHand = new THREE.Mesh(gloveGeometry, armMaterial);
    this.rightHand.rotation.z = -0.26;
    this.leftHand.rotation.z = 0.26;
    this.selfHands.add(this.rightForearm, this.leftForearm, this.rightHand, this.leftHand);

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
      this.renderer.domElement.setAttribute('aria-label', 'Grau Battle 3D boxing ring');
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
    effect.z = onSelf ? 0.2 : 4.08;
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
    const targetLean = clamp(me.hipOffset, -0.55, 0.55) * 0.24;
    this.cameraLean = THREE.MathUtils.damp(this.cameraLean, targetLean, 9, dt);
    this.shake = Math.max(0, this.shake - dt * 0.9);
    const shakeX = this.shake * Math.sin(now * 0.045);
    const shakeY = this.shake * 0.55 * Math.cos(now * 0.052);
    const sideStep = clamp(me.hipOffset, -0.55, 0.55) * 0.28;
    this.camera.position.set(sideStep + shakeX, 1.68 + shakeY, 0.02);
    this.camera.rotation.set(0, Math.PI + this.cameraYaw, -this.cameraLean);
  }

  private updateHands(me: FighterView): void {
    const handX = clamp((me.wrist.x - 0.42) * 0.42, -0.22, 0.22);
    const handY = clamp(-0.34 - (me.wrist.y + 0.6) * 0.14, -0.62, -0.08);
    const offWrist = me.offWrist ?? { x: -0.55, y: -0.45 };
    const offX = clamp((offWrist.x + 0.42) * 0.32, -0.22, 0.14);
    const offY = clamp(-0.39 - (offWrist.y + 0.45) * 0.14, -0.62, -0.12);
    const right = this.rightHandPos.set(0.25 + handX, handY, -1.12);
    const left = this.leftHandPos.set(-0.1 + offX, offY, -1.04);
    const shoulderRight = this.rightShoulderPos.set(0.11, -0.78, -0.4);
    const shoulderLeft = this.leftShoulderPos.set(-0.11, -0.8, -0.42);
    const reach = me.lungeProgress * 0.5;
    right.z -= reach;
    left.z -= reach * 0.35;
    placeBetween(this.rightForearm, shoulderRight, right, 0.055);
    placeBetween(this.leftForearm, shoulderLeft, left, 0.05);
    this.rightHand.position.copy(right);
    this.leftHand.position.copy(left);
    this.selfHands.position.x = me.hipOffset * 0.12;
    this.selfHands.rotation.y = -this.cameraYaw * 0.18;
  }

  private updateTargets(view: ArenaView): void {
    const opponentX = this.opponent.group.position.x;
    for (const ring of this.targetRings) {
      ring.position.x = opponentX;
      ring.position.z = 4.22 - view.them.lungeProgress * 0.2;
      ring.material.opacity = view.phase === 'live' ? 0.14 : 0.06;
    }

    for (let i = 0; i < this.incomingRings.length; i += 1) {
      const ring = this.incomingRings[i]!;
      const ghost = this.punchGhosts[i]!;
      const incoming = view.incoming[i];
      if (!incoming) {
        ring.material.opacity = 0;
        ghost.material.opacity = 0;
        continue;
      }
      const pulse = 1 + Math.sin(incoming.progress * Math.PI) * 0.12;
      ring.position.set(opponentX, zoneHeight(incoming.zone), 3.92 - incoming.progress * 0.55);
      ring.scale.setScalar(pulse + incoming.progress * 0.3);
      ring.material.color.set(incoming.fromSelf ? SELF : FOE);
      ring.material.opacity = 0.24 + incoming.progress * 0.64;
      ring.rotation.z = incoming.kind === 'slash' ? incoming.progress * Math.PI : 0;

      const targetY = zoneHeight(incoming.zone);
      if (incoming.fromSelf) {
        this.ghostFrom.set(0.25 + this.selfHands.position.x, -0.25, 0.38);
        this.ghostTo.set(opponentX, targetY, 4.08);
        ghost.material.color.set(SELF);
      } else {
        this.ghostFrom.set(opponentX, targetY, 4.08);
        this.ghostTo.set(0, targetY, 0.28);
        ghost.material.color.set(FOE);
      }
      ghost.position.lerpVectors(this.ghostFrom, this.ghostTo, incoming.progress);
      ghost.scale.setScalar(0.8 + incoming.progress * 0.45);
      ghost.material.opacity = incoming.progress < 0.98 ? 0.72 : 0;
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
