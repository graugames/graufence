import { describe, expect, it } from 'vitest';
import {
  compactPose,
  parseClientMessage,
  sanitizeName,
  sanitizeRoomCode,
} from '../src/protocol.js';
import { PROTOCOL_VERSION } from '../src/constants.js';

const frame = (obj: unknown) => JSON.stringify(obj);

describe('parseClientMessage - hostile input', () => {
  it('rejects malformed JSON without throwing', () => {
    // A server that throws on a bad frame is one bad frame from being offline.
    const r = parseClientMessage('{not json');
    expect(r).toMatchObject({ ok: false, code: 'bad_message' });
  });

  it('rejects JSON that is not an object', () => {
    for (const raw of ['null', '42', '"hello"', '[1,2,3]', 'true']) {
      expect(parseClientMessage(raw).ok).toBe(false);
    }
  });

  it('rejects a message with no type', () => {
    expect(parseClientMessage(frame({ hello: 'world' })).ok).toBe(false);
  });

  it('rejects an unknown message type', () => {
    expect(parseClientMessage(frame({ type: 'drop_tables' })).ok).toBe(false);
  });

  it('rejects an oversized frame before parsing it', () => {
    const huge = frame({ type: 'ping', t: 1, pad: 'x'.repeat(10_000) });
    const r = parseClientMessage(huge);
    expect(r).toMatchObject({ ok: false, code: 'bad_message' });
  });

  it('survives every prefix of a valid message', () => {
    // Fuzzing the truncation cases catches parsers that assume well-formedness.
    const full = frame({ type: 'action', kind: 'thrust', zone: 'head', seq: 1 });
    for (let i = 0; i <= full.length; i++) {
      expect(() => parseClientMessage(full.slice(0, i))).not.toThrow();
    }
  });

  it('survives odd JavaScript values in every field', () => {
    const nasties = [null, undefined, NaN, Infinity, -Infinity, {}, [], '', 0, false];
    for (const bad of nasties) {
      expect(() =>
        parseClientMessage(frame({ type: 'action', kind: bad, zone: bad, seq: bad })),
      ).not.toThrow();
    }
  });

  it('accepts a binary frame', () => {
    const bytes = new TextEncoder().encode(frame({ type: 'ping', t: 5 }));
    expect(parseClientMessage(bytes)).toMatchObject({ ok: true });
  });

  it('rejects a frame type it cannot read at all', () => {
    expect(parseClientMessage(12345 as unknown).ok).toBe(false);
  });
});

describe('parseClientMessage - versioning', () => {
  it('accepts the current version', () => {
    const r = parseClientMessage(frame({ type: 'create_room', v: PROTOCOL_VERSION, name: 'Ada' }));
    expect(r).toMatchObject({ ok: true });
  });

  it('refuses a stale or future dialect rather than guessing', () => {
    for (const v of [PROTOCOL_VERSION - 1, PROTOCOL_VERSION + 1, '1', null]) {
      const r = parseClientMessage(frame({ type: 'create_room', v, name: 'Ada' }));
      expect(r).toMatchObject({ ok: false, code: 'bad_version' });
    }
  });
});

describe('parseClientMessage - actions', () => {
  it('accepts a well-formed thrust', () => {
    const r = parseClientMessage(frame({ type: 'action', kind: 'thrust', zone: 'head', seq: 3 }));
    expect(r).toMatchObject({ ok: true, message: { kind: 'thrust', zone: 'head', seq: 3 } });
  });

  it('requires a valid zone on an attack', () => {
    expect(parseClientMessage(frame({ type: 'action', kind: 'thrust', seq: 1 })).ok).toBe(false);
    expect(
      parseClientMessage(frame({ type: 'action', kind: 'thrust', zone: 'shins', seq: 1 })).ok,
    ).toBe(false);
  });

  it('requires a direction on a slash and on a dodge', () => {
    expect(
      parseClientMessage(frame({ type: 'action', kind: 'slash', zone: 'head', seq: 1 })).ok,
    ).toBe(false);
    expect(parseClientMessage(frame({ type: 'action', kind: 'dodge', seq: 1 })).ok).toBe(false);
    expect(
      parseClientMessage(frame({ type: 'action', kind: 'dodge', dodge: 'up', seq: 1 })).ok,
    ).toBe(false);
  });

  it('accepts a parry with nothing else attached', () => {
    expect(parseClientMessage(frame({ type: 'action', kind: 'parry', seq: 9 })).ok).toBe(true);
  });

  it('drops fields the client had no business sending', () => {
    // A client claiming damage is exactly the attack this design exists to
    // stop: the parsed message simply has no such field.
    const r = parseClientMessage(
      frame({ type: 'action', kind: 'thrust', zone: 'head', seq: 1, damage: 9999, health: 100 }),
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.message).not.toHaveProperty('damage');
    expect(r.ok && r.message).not.toHaveProperty('health');
  });

  it('rejects a non-numeric sequence number', () => {
    expect(
      parseClientMessage(frame({ type: 'action', kind: 'parry', seq: 'many' })).ok,
    ).toBe(false);
  });
});

describe('parseClientMessage - pose', () => {
  const good = { a: 90, h: 0.2, wx: 0.4, wy: -0.5, c: 0.9 };

  it('accepts a pose in range', () => {
    const r = parseClientMessage(frame({ type: 'pose', pose: good, guard: 'head' }));
    expect(r).toMatchObject({ ok: true, message: { guard: 'head' } });
  });

  it('round-trips both elbow joints for exact remote arm rendering', () => {
    const pose = {
      ...good,
      ex: 0.31,
      ey: -0.82,
      owx: -0.44,
      owy: -0.38,
      oex: -0.36,
      oey: -0.68,
    };
    const r = parseClientMessage(frame({ type: 'pose', pose, guard: 'torso' }));
    expect(r).toMatchObject({ ok: true, message: { pose, guard: 'torso' } });
  });

  it('requires every transmitted joint to arrive as an x/y pair', () => {
    for (const broken of [
      { ...good, ex: 0.2 },
      { ...good, owx: -0.4, owy: Number.POSITIVE_INFINITY },
      { ...good, oey: -0.7 },
    ]) {
      expect(parseClientMessage(frame({ type: 'pose', pose: broken, guard: null })).ok).toBe(false);
    }
  });

  it('accepts a null guard', () => {
    expect(parseClientMessage(frame({ type: 'pose', pose: good, guard: null })).ok).toBe(true);
  });

  it('rejects values that would poison the renderer', () => {
    // Unbounded numbers reaching a canvas transform are how one player crashes
    // the other player's tab.
    for (const bad of [
      { ...good, a: 1e308 },
      { ...good, wx: Number.NaN },
      { ...good, wy: Infinity },
      { ...good, c: 42 },
      { ...good, h: -99 },
    ]) {
      expect(parseClientMessage(frame({ type: 'pose', pose: bad, guard: null })).ok).toBe(false);
    }
  });

  it('rejects a missing or non-object pose', () => {
    expect(parseClientMessage(frame({ type: 'pose', guard: null })).ok).toBe(false);
    expect(parseClientMessage(frame({ type: 'pose', pose: 'up', guard: null })).ok).toBe(false);
  });

  it('rejects an invalid guard zone', () => {
    expect(parseClientMessage(frame({ type: 'pose', pose: good, guard: 'knees' })).ok).toBe(false);
  });
});

describe('parseClientMessage - rooms', () => {
  it('normalizes a room code the way a person would type it', () => {
    const r = parseClientMessage(
      frame({ type: 'join_room', v: PROTOCOL_VERSION, code: ' ab12 ', name: 'Bo' }),
    );
    expect(r).toMatchObject({ ok: true, message: { code: 'AB12' } });
  });

  it('rejects a code that is the wrong length', () => {
    for (const code of ['A', 'AB', 'ABCDEFGHIJ']) {
      expect(
        parseClientMessage(frame({ type: 'join_room', v: PROTOCOL_VERSION, code, name: 'Bo' })).ok,
      ).toBe(false);
    }
  });

  it('requires a plausible token to rejoin', () => {
    expect(
      parseClientMessage(frame({ type: 'rejoin', v: PROTOCOL_VERSION, code: 'AB12', token: 'x' }))
        .ok,
    ).toBe(false);
    expect(
      parseClientMessage(
        frame({ type: 'rejoin', v: PROTOCOL_VERSION, code: 'AB12', token: 'a'.repeat(20) }),
      ).ok,
    ).toBe(true);
  });

  it('insists that ready is a boolean', () => {
    expect(parseClientMessage(frame({ type: 'ready', ready: 'yes' })).ok).toBe(false);
    expect(parseClientMessage(frame({ type: 'ready', ready: true })).ok).toBe(true);
  });
});

describe('parseClientMessage - character customization', () => {
  const customization = { skinTone: 0.75, height: 0.2, build: 0.9, hair: 1, gloves: 0.5 };

  it('accepts a bounded loadout', () => {
    expect(
      parseClientMessage(frame({ type: 'customize', customization })),
    ).toMatchObject({ ok: true, message: { customization } });
  });

  it('rejects missing, infinite, and out-of-range appearance values', () => {
    expect(parseClientMessage(frame({ type: 'customize' })).ok).toBe(false);
    expect(
      parseClientMessage(frame({ type: 'customize', customization: { ...customization, build: 2 } })).ok,
    ).toBe(false);
    expect(
      parseClientMessage(frame({ type: 'customize', customization: { ...customization, hair: Infinity } })).ok,
    ).toBe(false);
  });
});

describe('sanitizeName', () => {
  it('falls back to a default for empty or non-string input', () => {
    expect(sanitizeName('')).toBe('Boxer');
    expect(sanitizeName(null)).toBe('Boxer');
    expect(sanitizeName(42)).toBe('Boxer');
    expect(sanitizeName('   ')).toBe('Boxer');
  });

  it('strips markup characters', () => {
    const out = sanitizeName('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });

  it('strips control characters', () => {
    expect(sanitizeName('Ada Bo')).toBe('AdaBo');
  });

  it('caps the length so one player cannot flood the other lobby', () => {
    expect(sanitizeName('x'.repeat(500)).length).toBeLessThanOrEqual(16);
  });

  it('leaves an ordinary name alone', () => {
    expect(sanitizeName('  Ada Lovelace  ')).toBe('Ada Lovelace');
  });
});

describe('sanitizeRoomCode', () => {
  it('uppercases and strips punctuation', () => {
    expect(sanitizeRoomCode('ab-12')).toBe('AB12');
  });

  it('returns null for anything unusable', () => {
    expect(sanitizeRoomCode('')).toBeNull();
    expect(sanitizeRoomCode('!!')).toBeNull();
    expect(sanitizeRoomCode(null)).toBeNull();
  });
});

describe('compactPose', () => {
  it('rounds hard enough to matter on the wire', () => {
    const p = compactPose({ a: 90.123456, h: 0.123456, wx: -0.987654, wy: 0.5, c: 0.87654 });
    expect(JSON.stringify(p).length).toBeLessThan(60);
    expect(p.a).toBe(90.1);
    expect(p.h).toBe(0.12);
  });

  it('compacts the elbow joints along with the wrists', () => {
    const p = compactPose({
      a: 90,
      h: 0,
      wx: 0.4,
      wy: -0.5,
      ex: 0.33333,
      ey: -0.77777,
      owx: -0.4,
      owy: -0.5,
      oex: -0.35555,
      oey: -0.66666,
      c: 1,
    });
    expect(p).toMatchObject({ ex: 0.33, ey: -0.78, owx: -0.4, oex: -0.36, oey: -0.67 });
  });

  it('keeps a whole update comfortably under a network MTU', () => {
    const msg = JSON.stringify({
      type: 'pose',
      pose: compactPose({ a: -179.99, h: -1.23, wx: 1.23, wy: -1.23, c: 0.99 }),
      guard: 'torso',
    });
    expect(msg.length).toBeLessThan(200);
  });
});
