import { describe, expect, it } from 'vitest';
import { AbuseCounter, TokenBucket } from '../src/rateLimit.js';
import { readConfig, originAllowed } from '../src/config.js';

describe('TokenBucket', () => {
  it('lets a normal client through', () => {
    // 25 messages/s is what a playing client actually sends.
    const bucket = new TokenBucket(60, 120, 0);
    let now = 0;
    let allowed = 0;
    for (let i = 0; i < 250; i++) {
      now += 40;
      if (bucket.take(now)) allowed++;
    }
    expect(allowed).toBe(250);
  });

  it('cuts off a flood', () => {
    const bucket = new TokenBucket(60, 120, 0);
    let allowed = 0;
    for (let i = 0; i < 1000; i++) if (bucket.take(0)) allowed++;
    expect(allowed).toBe(120);
  });

  it('refills over time rather than on a timer', () => {
    const bucket = new TokenBucket(60, 60, 0);
    for (let i = 0; i < 60; i++) bucket.take(0);
    expect(bucket.take(0)).toBe(false);
    expect(bucket.take(1000)).toBe(true);
  });

  it('never banks more than the burst allowance', () => {
    const bucket = new TokenBucket(10, 20, 0);
    bucket.take(3_600_000); // an hour of idling
    expect(bucket.available).toBeLessThanOrEqual(20);
  });

  it('is not fooled by a clock that goes backwards', () => {
    const bucket = new TokenBucket(10, 10, 1000);
    for (let i = 0; i < 10; i++) bucket.take(1000);
    expect(bucket.take(0)).toBe(false);
  });
});

describe('AbuseCounter', () => {
  it('tolerates the occasional throttled message', () => {
    const abuse = new AbuseCounter(200);
    for (let i = 0; i < 50; i++) {
      abuse.strike();
      abuse.forgive();
    }
    expect(abuse.count).toBeLessThan(200);
  });

  it('eventually asks for the socket to be closed', () => {
    const abuse = new AbuseCounter(5);
    let closed = false;
    for (let i = 0; i < 5; i++) closed = abuse.strike();
    expect(closed).toBe(true);
  });

  it('never counts below zero', () => {
    const abuse = new AbuseCounter();
    abuse.forgive();
    abuse.forgive();
    expect(abuse.count).toBe(0);
  });
});

describe('config', () => {
  it('runs with no environment at all', () => {
    const cfg = readConfig({});
    expect(cfg.port).toBeGreaterThan(0);
    expect(cfg.allowedOrigins).toEqual(['*']);
    expect(cfg.maxMessagesPerSecond).toBeGreaterThan(0);
  });

  it('reads a host-injected PORT', () => {
    expect(readConfig({ PORT: '10000' }).port).toBe(10000);
  });

  it('falls back rather than crashing on nonsense values', () => {
    const cfg = readConfig({ PORT: 'banana', MAX_MESSAGES_PER_SECOND: '-4' });
    expect(cfg.port).toBe(8787);
    expect(cfg.maxMessagesPerSecond).toBe(60);
  });

  it('parses a comma-separated origin list', () => {
    const cfg = readConfig({ ALLOWED_ORIGINS: 'https://a.example, https://b.example' });
    expect(cfg.allowedOrigins).toEqual(['https://a.example', 'https://b.example']);
  });
});

describe('originAllowed', () => {
  it('allows everything when configured with *', () => {
    expect(originAllowed('https://evil.example', ['*'])).toBe(true);
  });

  it('allows a listed origin and refuses an unlisted one', () => {
    const allowed = ['https://graufence.example'];
    expect(originAllowed('https://graufence.example', allowed)).toBe(true);
    expect(originAllowed('https://evil.example', allowed)).toBe(false);
  });

  it('allows a request with no Origin header', () => {
    // Health checks and CLI tools do not send one, and the header is not a
    // security boundary - it only keeps a random web page from squatting here.
    expect(originAllowed(undefined, ['https://graufence.example'])).toBe(true);
  });
});
