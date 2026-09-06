/**
 * Keyboard fallback tests.
 *
 * These exercise the control path that CI can actually run: no camera, no DOM
 * listeners, just `press()` and `update()`. Because the fallback emits exactly
 * the same action shape as the gesture detector, a match driven from here is
 * the same match a camera would drive.
 */

import { describe, expect, it } from 'vitest';
import { KeyboardController, KEYBOARD_HELP } from '../src/input/keyboard.js';
import { COOLDOWN, MATCH, MatchEngine, zoneForAngle } from '@graufence/shared';

/** Drives a controller forward, returning every action it emitted. */
function play(
  controller: KeyboardController,
  script: { at: number; key?: string }[],
  fps = 60,
) {
  const step = 1000 / fps;
  const fired: ReturnType<KeyboardController['update']> = [];
  let t = 0;
  const end = Math.max(...script.map((s) => s.at)) + 200;
  let next = 0;
  while (t <= end) {
    while (next < script.length && script[next]!.at <= t) {
      const key = script[next]!.key;
      if (key) controller.press(key);
      next++;
    }
    fired.push(...controller.update(t));
    t += step;
  }
  return fired;
}

describe('KeyboardController', () => {
  it('emits a thrust on space', () => {
    const c = new KeyboardController();
    const fired = play(c, [{ at: 100, key: ' ' }]);
    expect(fired.filter((a) => a.kind === 'thrust')).toHaveLength(1);
  });

  it('emits both slash directions', () => {
    const c = new KeyboardController();
    const fired = play(c, [
      { at: 100, key: 'j' },
      { at: 1200, key: 'k' },
    ]);
    const slashes = fired.filter((a) => a.kind === 'slash');
    expect(slashes.map((s) => s.slash)).toEqual(['lr', 'rl']);
  });

  it('emits a dodge with a direction, and leans the body', () => {
    const c = new KeyboardController();
    const fired = play(c, [{ at: 100, key: 'e' }]);
    const dodges = fired.filter((a) => a.kind === 'dodge');
    expect(dodges).toHaveLength(1);
    expect(dodges[0]!.dodge).toBe('right');
  });

  it('honours the same cooldowns as the camera path', () => {
    // Otherwise the fallback would be strictly better than a webcam, and every
    // competitive player would just use it.
    const c = new KeyboardController();
    const fired = play(c, [
      { at: 100, key: ' ' },
      { at: 150, key: ' ' },
      { at: 200, key: ' ' },
    ]);
    expect(fired.filter((a) => a.kind === 'thrust')).toHaveLength(1);
  });

  it('allows a second attack once the cooldown expires', () => {
    const c = new KeyboardController();
    const fired = play(c, [
      { at: 100, key: ' ' },
      { at: 100 + COOLDOWN.thrust * 1000 + 60, key: ' ' },
    ]);
    expect(fired.filter((a) => a.kind === 'thrust')).toHaveLength(2);
  });

  it('will not let alternating attacks beat the global lockout', () => {
    const c = new KeyboardController();
    const fired = play(c, [
      { at: 100, key: ' ' },
      { at: 160, key: 'j' },
    ]);
    expect(fired).toHaveLength(1);
  });

  it('ignores keys that mean nothing', () => {
    const c = new KeyboardController();
    expect(play(c, [{ at: 100, key: 'z' }, { at: 200, key: 'F5' }])).toHaveLength(0);
  });

  it('always reports a guard, since a keyboard blade is always steady', () => {
    const c = new KeyboardController();
    play(c, [{ at: 50 }]);
    expect(c.state.guardZone).not.toBeNull();
    expect(c.state.guardZone).toBe(zoneForAngle(c.state.bladeAngle));
  });

  it('produces a pose the rest of the game can consume', () => {
    const c = new KeyboardController();
    play(c, [{ at: 50 }]);
    const { pose, blade } = c.state;
    expect(pose.valid).toBe(true);
    expect(pose.confidence).toBe(1);
    expect(Number.isFinite(blade.tip.x)).toBe(true);
    expect(Number.isFinite(blade.angle)).toBe(true);
    expect(blade.length).toBeGreaterThan(0);
  });

  it('aims the blade where the pose says the arm points', () => {
    const c = new KeyboardController();
    play(c, [{ at: 50 }]);
    // The blade must continue the elbow->wrist line, or the visible sword and
    // the zone the game thinks you are covering would disagree.
    const { pose, bladeAngle } = c.state;
    const armAngle =
      (Math.atan2(-(pose.wrist.y - pose.elbow.y), pose.wrist.x - pose.elbow.x) * 180) / Math.PI;
    expect(Math.abs(armAngle - bladeAngle)).toBeLessThan(1);
  });

  it('documents every key it actually handles', () => {
    // A help table that drifts from the code is worse than no help table.
    const documented = KEYBOARD_HELP.map((r) => r.keys.toLowerCase()).join(' ');
    for (const key of ['space', 'j', 'k', 'l', 'q', 'e', 'a', 'd', 'w', 's']) {
      expect(documented).toContain(key);
    }
  });
});

describe('a full match driven from the keyboard', () => {
  it('plays out to a winner without a camera or a socket', () => {
    // The end-to-end sanity check: keyboard input -> shared engine -> a result.
    const engine = new MatchEngine({ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, 0);
    engine.setReady(0, true);
    engine.setReady(1, true);
    engine.startCountdown(0);

    const controller = new KeyboardController();
    let t = MATCH.countdownSeconds * 1000 + 50;
    engine.tick(t);
    expect(engine.state.phase).toBe('live');

    // Player 0 attacks on a loop; player 1 never defends.
    for (let i = 0; i < 400 && engine.state.matchWinner === null; i++) {
      if (engine.state.phase === 'live') {
        controller.press(' ');
        for (const action of controller.update(t)) {
          engine.submitAction(0, { kind: action.kind, zone: action.zone ?? 'torso' }, t);
        }
      } else if (engine.state.phase === 'round_over') {
        // Let the inter-round break elapse.
        t += MATCH.interRoundSeconds * 1000 + MATCH.countdownSeconds * 1000 + 100;
      }
      t += 120;
      engine.tick(t);
    }

    expect(engine.state.matchWinner).toBe(0);
    expect(engine.state.players[0].roundsWon).toBe(MATCH.roundsToWin);
  });
});
