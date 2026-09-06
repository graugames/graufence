/**
 * The arena renderer.
 *
 * Plain 2-D canvas, one draw call tree per frame, no retained scene graph and
 * no 3-D engine. A fencing match is two figures and two lines; anything heavier
 * would cost frames that the pose model needs.
 *
 * Everything here is a pure function of the view model it is handed. The
 * renderer owns no game state - it cannot, because the authority for that lives
 * on the server. Its only mutable state is cosmetic: floating damage numbers,
 * sparks, and screen shake.
 */

import type { HitZone, Vec2 } from '@graufence/shared';
import { HIT_ZONES, ZONE_CENTER_ANGLE, clamp, fromAngle } from '@graufence/shared';
import { PALETTE, healthColor } from './palette.js';

export interface FighterView {
  name: string;
  /** -1 draws on the left half, +1 on the right. */
  side: -1 | 1;
  isSelf: boolean;
  health: number;
  stamina: number;
  roundsWon: number;
  connected: boolean;
  staggered: boolean;
  /** Blade angle in degrees, in the fighter's own body space. */
  bladeAngle: number;
  guard: HitZone | null;
  /** Body points in body units (1 = shoulder width), y down, hips at origin. */
  hipOffset: number;
  wrist: Vec2;
  /** 0..1; below ~0.45 the avatar is drawn as "signal lost". */
  confidence: number;
  /** Set while an attack of this fighter's is in the air. */
  lungeProgress: number;
}

export interface IncomingView {
  id: number;
  /** Whose attack it is. */
  fromSelf: boolean;
  zone: HitZone;
  kind: 'thrust' | 'slash';
  /** 0..1 progress from thrown to landing. */
  progress: number;
}

export interface ArenaView {
  me: FighterView;
  them: FighterView;
  phase: 'lobby' | 'countdown' | 'live' | 'round_over' | 'match_over';
  round: number;
  /** Seconds left on the countdown, or null outside a countdown. */
  countdown: number | null;
  incoming: IncomingView[];
  /** Big banner text ("ROUND 2", "YOU WIN"), or null. */
  banner: string | null;
  bannerTone: 'good' | 'bad' | 'neutral';
  /** Shown when the local player's tracking has dropped out. */
  trackingWarning: string | null;
}

interface FloatingNumber {
  x: number;
  y: number;
  vy: number;
  text: string;
  color: string;
  life: number;
  maxLife: number;
  scale: number;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

interface Flash {
  text: string;
  color: string;
  life: number;
}

export class ArenaRenderer {
  private numbers: FloatingNumber[] = [];
  private sparks: Spark[] = [];
  private flashes: Flash[] = [];
  private shake = 0;
  private hurtFlash = 0;
  private lastFrameAt = 0;

  /** Measured render rate, for the debug panel. */
  fps = 0;
  private fpsAcc = 0;
  private fpsCount = 0;
  /** Static arena layer, rebuilt only when the canvas backing size changes. */
  private backgroundCanvas: HTMLCanvasElement | null = null;
  private backgroundW = 0;
  private backgroundH = 0;

  // ---------------------------------------------------------------- effects

  /** A hit landed: throw a damage number, sparks, and shake the camera. */
  addHit(onSelf: boolean, damage: number, zone: HitZone, outcome: string): void {
    const x = onSelf ? 0.3 : 0.7;
    const y = zone === 'head' ? 0.34 : zone === 'torso' ? 0.46 : 0.5;
    const color =
      outcome === 'guarded'
        ? PALETTE.guard
        : outcome === 'hit'
          ? PALETTE.hit
          : PALETTE.dodge;

    if (damage > 0) {
      this.numbers.push({
        x,
        y,
        vy: -0.055,
        text: `-${damage}`,
        color,
        life: 1,
        maxLife: 1,
        scale: outcome === 'hit' ? 1 : 0.75,
      });
      for (let i = 0; i < (outcome === 'hit' ? 16 : 7); i++) {
        this.sparks.push({
          x,
          y,
          vx: (Math.random() - 0.5) * 0.5,
          vy: (Math.random() - 0.7) * 0.4,
          life: 0.4 + Math.random() * 0.3,
          color,
        });
      }
      // Only the player being hit gets the screen shake and the red vignette;
      // shaking on your own successful hit is disorienting.
      this.shake = Math.min(1, this.shake + (onSelf ? damage / 40 : damage / 90));
      if (onSelf) this.hurtFlash = Math.min(1, this.hurtFlash + damage / 45);
    }
  }

  /** A named event worth a centre-screen flash ("PERFECT PARRY"). */
  addFlash(text: string, color: string = PALETTE.parry): void {
    this.flashes.push({ text, color, life: 1 });
    if (this.flashes.length > 3) this.flashes.shift();
  }

  private stepEffects(dt: number): void {
    for (const n of this.numbers) {
      n.y += n.vy * dt * 60 * 0.016;
      n.life -= dt / 1.1;
    }
    this.numbers = this.numbers.filter((n) => n.life > 0);

    for (const s of this.sparks) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += dt * 1.6;
      s.life -= dt;
    }
    this.sparks = this.sparks.filter((s) => s.life > 0);

    for (const f of this.flashes) f.life -= dt / 1.2;
    this.flashes = this.flashes.filter((f) => f.life > 0);

    this.shake = Math.max(0, this.shake - dt * 2.6);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.2);
  }

  // ------------------------------------------------------------------- draw

  draw(ctx: CanvasRenderingContext2D, view: ArenaView, now: number): void {
    const dt = this.lastFrameAt === 0 ? 0.016 : Math.min(0.1, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;
    this.stepEffects(dt);

    this.fpsAcc += dt;
    this.fpsCount++;
    if (this.fpsAcc >= 0.5) {
      this.fps = this.fpsCount / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsCount = 0;
    }

    const W = ctx.canvas.width;
    const H = ctx.canvas.height;

    ctx.save();
    if (this.shake > 0.01) {
      const mag = this.shake * Math.min(14, W * 0.012);
      ctx.translate((Math.random() - 0.5) * mag, (Math.random() - 0.5) * mag);
    }

    this.drawBackground(ctx, W, H, now);
    this.drawFighter(ctx, W, H, view.them, now);
    this.drawFighter(ctx, W, H, view.me, now);
    this.drawIncoming(ctx, W, H, view.incoming);
    this.drawSparks(ctx, W, H);
    this.drawNumbers(ctx, W, H);
    ctx.restore();

    // HUD is drawn outside the shake transform: a jittering health bar is just
    // hard to read.
    this.drawHud(ctx, W, H, view);
    this.drawOverlays(ctx, W, H, view);
    this.drawHurtVignette(ctx, W, H);
  }

  private drawBackground(ctx: CanvasRenderingContext2D, W: number, H: number, now: number): void {
    const cached = this.ensureBackground(W, H);
    if (cached) ctx.drawImage(cached, 0, 0);
    else this.drawStaticBackground(ctx, W, H);

    // Only the breathing haze is animated; keeping it out of the cached layer
    // preserves the subtle motion without rebuilding the full perspective grid.
    const horizon = H * 0.52;
    const pulse = 0.5 + 0.5 * Math.sin(now / 2600);
    const glow = ctx.createRadialGradient(W / 2, horizon, 0, W / 2, horizon, W * 0.6);
    glow.addColorStop(0, `rgba(88, 231, 255, ${0.05 + pulse * 0.03})`);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  }

  private ensureBackground(W: number, H: number): HTMLCanvasElement | null {
    if (typeof document === 'undefined') return null;
    if (this.backgroundCanvas && this.backgroundW === W && this.backgroundH === H) {
      return this.backgroundCanvas;
    }

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const background = canvas.getContext('2d', { alpha: false });
    if (!background) return null;
    this.drawStaticBackground(background, W, H);
    this.backgroundCanvas = canvas;
    this.backgroundW = W;
    this.backgroundH = H;
    return canvas;
  }

  private drawStaticBackground(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, PALETTE.skyTop);
    sky.addColorStop(1, PALETTE.skyBottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // Perspective floor: a few converging lines is enough to read as depth and
    // costs nothing next to a real 3-D ground plane.
    const horizon = H * 0.52;
    ctx.fillStyle = PALETTE.floor;
    ctx.fillRect(0, horizon, W, H - horizon);

    ctx.strokeStyle = PALETTE.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = -6; i <= 6; i++) {
      const x = W / 2 + (i * W) / 8;
      ctx.moveTo(W / 2 + i * 24, horizon);
      ctx.lineTo(x, H);
    }
    for (let row = 1; row <= 7; row++) {
      const y = horizon + Math.pow(row / 7, 2.1) * (H - horizon);
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();

    // The piste the two fencers stand on.
    ctx.strokeStyle = PALETTE.floorLine;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W * 0.06, H * 0.78);
    ctx.lineTo(W * 0.94, H * 0.78);
    ctx.stroke();

  }

  /**
   * Maps a fighter's body-unit coordinates onto the canvas.
   *
   * Each fighter owns a half of the screen and is scaled to it, which is what
   * lets two people with completely different cameras appear the same size.
   */
  private projector(W: number, H: number, f: FighterView) {
    const centerX = f.side < 0 ? W * 0.29 : W * 0.71;
    const groundY = H * 0.74;
    const unit = Math.min(W * 0.13, H * 0.2);
    return (p: Vec2): Vec2 => ({
      // Mirror the far fighter so the two face each other.
      x: centerX + (p.x + f.hipOffset * 0.6) * unit * f.side * -1,
      y: groundY + p.y * unit,
    });
  }

  private drawFighter(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    f: FighterView,
    now: number,
  ): void {
    const project = this.projector(W, H, f);
    const unit = Math.min(W * 0.13, H * 0.2);
    const color = f.isSelf ? PALETTE.self : PALETTE.foe;
    const deep = f.isSelf ? PALETTE.selfDeep : PALETTE.foeDeep;
    const tracking = f.confidence >= 0.45;

    // A lunge leans the whole body forward - the cheapest possible way to make
    // an attack read at a glance.
    const lean = f.lungeProgress * 0.35;
    const hips = project({ x: lean, y: 0 });
    const shoulders = project({ x: lean * 1.4, y: -1 });
    const head = project({ x: lean * 1.5, y: -1.5 });
    const wrist = project({ x: f.wrist.x + lean * 1.6, y: f.wrist.y });

    ctx.save();
    ctx.globalAlpha = tracking ? 1 : 0.4;

    this.drawZoneRing(ctx, shoulders.x, shoulders.y, unit, f);

    // Legs
    ctx.strokeStyle = deep;
    ctx.lineWidth = Math.max(4, unit * 0.13);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(hips.x, hips.y);
    ctx.lineTo(hips.x - unit * 0.42 * f.side, hips.y + unit * 0.85);
    ctx.moveTo(hips.x, hips.y);
    ctx.lineTo(hips.x + unit * 0.5 * f.side, hips.y + unit * 0.8);
    ctx.stroke();

    // Torso
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(6, unit * 0.2);
    ctx.beginPath();
    ctx.moveTo(hips.x, hips.y);
    ctx.lineTo(shoulders.x, shoulders.y);
    ctx.stroke();

    // Head
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(head.x, head.y, unit * 0.24, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = PALETTE.skyTop;
    ctx.beginPath();
    ctx.arc(head.x + unit * 0.07 * f.side, head.y, unit * 0.1, 0, Math.PI * 2);
    ctx.fill();

    // Sword arm
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(4, unit * 0.13);
    ctx.beginPath();
    ctx.moveTo(shoulders.x, shoulders.y);
    ctx.lineTo(wrist.x, wrist.y);
    ctx.stroke();

    this.drawBlade(ctx, wrist, f, unit, color, now);

    if (f.staggered) {
      ctx.strokeStyle = PALETTE.warn;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(shoulders.x, shoulders.y, unit * 0.95, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();

    if (!tracking) {
      ctx.fillStyle = PALETTE.warn;
      ctx.font = `${Math.max(11, unit * 0.2)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('signal lost', shoulders.x, head.y - unit * 0.6);
    }
    if (!f.connected) {
      ctx.fillStyle = PALETTE.warn;
      ctx.font = `${Math.max(12, unit * 0.22)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('disconnected', shoulders.x, head.y - unit * 0.95);
    }
  }

  /** Blade: a bright core with a wide soft glow, drawn in two passes. */
  private drawBlade(
    ctx: CanvasRenderingContext2D,
    wrist: Vec2,
    f: FighterView,
    unit: number,
    color: string,
    now: number,
  ): void {
    // Canvas y grows downward and the far fighter is mirrored, so the body-space
    // angle has to be flipped for the right-hand fighter.
    const dir = fromAngle(f.bladeAngle);
    const dx = dir.x * unit * 2.1 * f.side * -1;
    const dy = dir.y * unit * 2.1;
    const tip = { x: wrist.x + dx, y: wrist.y + dy };

    ctx.save();
    ctx.lineCap = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = 18 + Math.sin(now / 220) * 4;

    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = Math.max(7, unit * 0.2);
    ctx.beginPath();
    ctx.moveTo(wrist.x, wrist.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(2, unit * 0.06);
    ctx.beginPath();
    ctx.moveTo(wrist.x, wrist.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();

    // Guard (the hilt), so the blade has an obvious near end.
    ctx.shadowBlur = 0;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(3, unit * 0.08);
    const perp = { x: -dy, y: dx };
    const plen = Math.hypot(perp.x, perp.y) || 1;
    ctx.beginPath();
    ctx.moveTo(wrist.x - (perp.x / plen) * unit * 0.2, wrist.y - (perp.y / plen) * unit * 0.2);
    ctx.lineTo(wrist.x + (perp.x / plen) * unit * 0.2, wrist.y + (perp.y / plen) * unit * 0.2);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The four hit zones as arcs around the fighter, with the guarded one lit.
   *
   * This is the game's main teaching device: it shows, without words, that a
   * blade covers one line at a time.
   */
  private drawZoneRing(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    unit: number,
    f: FighterView,
  ): void {
    const radius = unit * 1.25;
    ctx.save();
    ctx.lineWidth = Math.max(3, unit * 0.09);
    for (const zone of HIT_ZONES) {
      const centre = ZONE_CENTER_ANGLE[zone];
      // Same mirroring as the blade, so the lit arc sits where the blade points.
      const screenDeg = f.side < 0 ? centre : 180 - centre;
      const mid = (-screenDeg * Math.PI) / 180;
      const half = (38 * Math.PI) / 180;
      const active = f.guard === zone;
      ctx.strokeStyle = active
        ? f.isSelf
          ? PALETTE.self
          : PALETTE.foe
        : 'rgba(255,255,255,0.07)';
      ctx.globalAlpha = active ? 0.85 : 1;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, mid - half, mid + half);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Attacks in the air, drawn as a closing arc so a parry has something to time. */
  private drawIncoming(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    incoming: IncomingView[],
  ): void {
    for (const attack of incoming) {
      // Drawn on the *target*: what matters is where it is about to land.
      const targetIsSelf = !attack.fromSelf;
      const cx = targetIsSelf ? W * 0.29 : W * 0.71;
      const cy = H * 0.74 - Math.min(W * 0.13, H * 0.2);
      const unit = Math.min(W * 0.13, H * 0.2);
      const p = clamp(attack.progress, 0, 1);

      ctx.save();
      ctx.globalAlpha = 0.35 + p * 0.6;
      ctx.strokeStyle = attack.fromSelf ? PALETTE.self : PALETTE.hit;
      ctx.lineWidth = 3 + p * 4;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.arc(cx, cy, unit * (2.4 - p * 1.1), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.globalAlpha = 0.9;
      ctx.fillStyle = attack.fromSelf ? PALETTE.self : PALETTE.hit;
      ctx.font = `600 ${Math.max(11, unit * 0.19)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(attack.zone.toUpperCase(), cx, cy - unit * 2.6);
      ctx.restore();
    }
  }

  private drawSparks(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    for (const s of this.sparks) {
      ctx.globalAlpha = clamp(s.life * 2, 0, 1);
      ctx.fillStyle = s.color;
      ctx.fillRect(s.x * W, s.y * H, 3, 3);
    }
    ctx.globalAlpha = 1;
  }

  private drawNumbers(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    ctx.textAlign = 'center';
    for (const n of this.numbers) {
      const t = n.life / n.maxLife;
      ctx.globalAlpha = clamp(t * 1.4, 0, 1);
      ctx.fillStyle = n.color;
      const size = Math.max(16, W * 0.026) * n.scale * (1 + (1 - t) * 0.25);
      ctx.font = `800 ${size}px system-ui, sans-serif`;
      ctx.fillText(n.text, n.x * W, n.y * H);
    }
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------------- HUD

  private drawHud(ctx: CanvasRenderingContext2D, W: number, H: number, view: ArenaView): void {
    const pad = Math.max(14, W * 0.022);
    const barW = Math.min(W * 0.34, 340);
    const barH = Math.max(12, H * 0.024);

    this.drawMeters(ctx, pad, pad, barW, barH, view.me, false);
    this.drawMeters(ctx, W - pad - barW, pad, barW, barH, view.them, true);

    // Round pips in the centre: best of three, so at most two per side.
    const cx = W / 2;
    const pipY = pad + barH * 0.6;
    const pipR = Math.max(4, H * 0.008);
    ctx.textAlign = 'center';
    ctx.fillStyle = PALETTE.textDim;
    ctx.font = `600 ${Math.max(11, W * 0.014)}px system-ui, sans-serif`;
    ctx.fillText(view.round > 0 ? `ROUND ${view.round}` : 'BEST OF 3', cx, pad + barH * 2.4);

    for (let i = 0; i < 2; i++) {
      for (const [f, dir] of [
        [view.me, -1],
        [view.them, 1],
      ] as const) {
        const x = cx + dir * (pipR * 3 + i * pipR * 2.8);
        ctx.beginPath();
        ctx.arc(x, pipY, pipR, 0, Math.PI * 2);
        ctx.fillStyle =
          f.roundsWon > i
            ? f.isSelf
              ? PALETTE.self
              : PALETTE.foe
            : 'rgba(255,255,255,0.14)';
        ctx.fill();
      }
    }
  }

  private drawMeters(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    f: FighterView,
    rightAligned: boolean,
  ): void {
    const health = clamp(f.health / 100, 0, 1);
    const stamina = clamp(f.stamina / 100, 0, 1);

    ctx.fillStyle = PALETTE.meterTrack;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = healthColor(health);
    // Both bars drain toward the outside edge, so they empty away from centre
    // and the two never read as one continuous bar.
    const hw = w * health;
    ctx.fillRect(rightAligned ? x + w - hw : x, y, hw, h);

    const sy = y + h + 4;
    const sh = Math.max(5, h * 0.42);
    ctx.fillStyle = PALETTE.staminaEmpty;
    ctx.fillRect(x, sy, w, sh);
    ctx.fillStyle = PALETTE.stamina;
    const sw = w * stamina;
    ctx.fillRect(rightAligned ? x + w - sw : x, sy, sw, sh);

    ctx.fillStyle = f.isSelf ? PALETTE.self : PALETTE.foe;
    ctx.font = `700 ${Math.max(12, h * 0.95)}px system-ui, sans-serif`;
    ctx.textAlign = rightAligned ? 'right' : 'left';
    const label = f.isSelf ? `${f.name} (you)` : f.name;
    ctx.fillText(label, rightAligned ? x + w : x, sy + sh + Math.max(14, h));

    ctx.fillStyle = PALETTE.textDim;
    ctx.font = `${Math.max(11, h * 0.8)}px system-ui, sans-serif`;
    ctx.fillText(
      `${Math.max(0, Math.round(f.health))} HP`,
      rightAligned ? x : x + w,
      y - 5,
    );
  }

  private drawOverlays(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    view: ArenaView,
  ): void {
    ctx.textAlign = 'center';

    if (view.countdown !== null) {
      const secs = Math.ceil(view.countdown);
      const text = secs > 0 ? String(secs) : 'FENCE!';
      // Scale pulses within each second, so the countdown ticks visibly.
      const frac = view.countdown - Math.floor(view.countdown);
      const scale = 1 + (1 - frac) * 0.22;
      ctx.save();
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = PALETTE.self;
      ctx.font = `800 ${Math.max(48, W * 0.09 * scale)}px system-ui, sans-serif`;
      ctx.fillText(text, W / 2, H * 0.46);
      ctx.restore();
    }

    if (view.banner) {
      ctx.save();
      ctx.fillStyle =
        view.bannerTone === 'good'
          ? PALETTE.self
          : view.bannerTone === 'bad'
            ? PALETTE.hit
            : PALETTE.text;
      ctx.font = `800 ${Math.max(30, W * 0.055)}px system-ui, sans-serif`;
      ctx.fillText(view.banner, W / 2, H * 0.3);
      ctx.restore();
    }

    let flashY = H * 0.6;
    for (const f of this.flashes) {
      ctx.save();
      ctx.globalAlpha = clamp(f.life * 1.5, 0, 1);
      ctx.fillStyle = f.color;
      ctx.font = `800 ${Math.max(20, W * 0.032) * (1 + (1 - f.life) * 0.2)}px system-ui, sans-serif`;
      ctx.fillText(f.text, W / 2, flashY);
      ctx.restore();
      flashY += Math.max(24, W * 0.036);
    }

    if (view.trackingWarning) {
      const boxW = Math.min(W * 0.66, 460);
      const boxH = Math.max(48, H * 0.09);
      const x = (W - boxW) / 2;
      const y = H - boxH - Math.max(16, H * 0.03);
      ctx.save();
      ctx.fillStyle = 'rgba(10, 16, 30, 0.88)';
      ctx.strokeStyle = PALETTE.warn;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(x, y, boxW, boxH, 10);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = PALETTE.warn;
      ctx.font = `600 ${Math.max(12, W * 0.016)}px system-ui, sans-serif`;
      ctx.fillText(view.trackingWarning, W / 2, y + boxH / 2 + 5);
      ctx.restore();
    }
  }

  /** Red edge glow when the local player takes damage. */
  private drawHurtVignette(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    if (this.hurtFlash <= 0.01) return;
    const grad = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.85);
    grad.addColorStop(0, 'rgba(255, 60, 60, 0)');
    grad.addColorStop(1, `rgba(255, 60, 60, ${this.hurtFlash * 0.45})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }
}
