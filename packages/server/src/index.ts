/**
 * GrauFence match server.
 *
 * One process, one HTTP endpoint for health checks, and a WebSocket endpoint
 * that carries the game. It is the authority: clients send intent, the server
 * decides what happened, and only the server's numbers are ever rendered as
 * health.
 *
 * It also assumes every connection is hostile until proven otherwise. Frames
 * are size-capped, JSON-parsed inside a guard, validated field by field, and
 * rate-limited per socket. Nothing a client sends is trusted, including the
 * things it is allowed to send.
 */

import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import {
  compactPose,
  parseClientMessage,
  PROTOCOL_VERSION,
  sanitizeName,
} from '@graufence/shared';
import type { ErrorCode, ServerMessage, Slot } from '@graufence/shared';
import { loadDotEnv, originAllowed, readConfig } from './config.js';
import { AbuseCounter, TokenBucket } from './rateLimit.js';
import { RoomManager, STATE_INTERVAL_MS, TICK_INTERVAL_MS } from './roomManager.js';
import type { Sink } from './roomManager.js';

loadDotEnv();
const config = readConfig();

const log = (msg: string, extra: Record<string, unknown> = {}): void => {
  const bits = Object.entries(extra)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  console.log(`[graufence] ${msg}${bits ? ' ' + bits : ''}`);
};

const rooms = new RoomManager({
  reconnectGraceSeconds: config.reconnectGraceSeconds,
  maxRooms: config.maxRooms,
  log,
});

// ---------------------------------------------------------------- connections

interface Session {
  socket: WebSocket;
  sink: Sink;
  bucket: TokenBucket;
  abuse: AbuseCounter;
  /** Where this socket is seated, once it has joined a room. */
  code: string | null;
  slot: Slot | null;
  /** Set by the pong handler; the heartbeat closes sockets that stop answering. */
  alive: boolean;
}

const sessions = new Set<Session>();

function reply(session: Session, message: ServerMessage): void {
  rooms.send(session.sink, message);
}

function fail(session: Session, code: ErrorCode, message: string, fatal = false): void {
  reply(session, { type: 'error', code, message, fatal });
  if (fatal) session.socket.close(1008, code);
}

/** Releases whatever seat this socket held, without assuming it held one. */
function releaseSeat(session: Session, deliberate: boolean): void {
  const { code, slot } = session;
  if (code === null || slot === null) return;
  if (deliberate) rooms.leave(code, slot, session.sink);
  else rooms.dropped(code, slot, session.sink);
  session.code = null;
  session.slot = null;
}

// ------------------------------------------------------------ message handling

function handleMessage(session: Session, raw: RawData): void {
  const now = Date.now();

  // Throttle before parsing: parsing is the work an attacker is trying to make
  // us do, so it must sit behind the limiter, not in front of it.
  if (!session.bucket.take(now)) {
    if (session.abuse.strike()) {
      log('closing abusive socket', { code: session.code ?? '-' });
      fail(session, 'rate_limited', 'Too many messages.', true);
    }
    return;
  }
  session.abuse.forgive();

  const parsed = parseClientMessage(raw as unknown, config.maxFrameBytes);
  if (!parsed.ok) {
    // A bad version is worth closing over (the client cannot recover); a single
    // malformed frame is not, since it may just be a hiccup.
    fail(session, parsed.code, parsed.reason, parsed.code === 'bad_version');
    return;
  }
  const msg = parsed.message;

  switch (msg.type) {
    case 'ping':
      reply(session, { type: 'pong', t: msg.t, now });
      return;

    case 'create_room': {
      if (session.code !== null) {
        fail(session, 'bad_message', 'Already in a room.');
        return;
      }
      const room = rooms.create();
      if (!room) {
        fail(session, 'server_error', 'Server is at capacity, try again shortly.');
        return;
      }
      seatInto(session, room.code, sanitizeName(msg.name));
      return;
    }

    case 'join_room': {
      if (session.code !== null) {
        fail(session, 'bad_message', 'Already in a room.');
        return;
      }
      const room = rooms.get(msg.code);
      if (!room) {
        fail(session, 'room_not_found', `No room with code ${msg.code}.`);
        return;
      }
      if (room.isFull) {
        fail(session, 'room_full', 'That room already has two fencers.');
        return;
      }
      seatInto(session, msg.code, sanitizeName(msg.name));
      return;
    }

    case 'rejoin': {
      const room = rooms.get(msg.code);
      if (!room) {
        fail(session, 'room_not_found', 'That match has ended.');
        return;
      }
      const result = room.rejoin(msg.token, now);
      if (!result.ok) {
        fail(session, 'invalid_token', 'That seat is no longer being held.');
        return;
      }
      session.code = msg.code;
      session.slot = result.seat.slot;
      const replaced = rooms.attach(msg.code, result.seat.slot, session.sink);
      if (replaced && replaced !== session.sink) {
        try {
          replaced.close(4001, 'seat reclaimed by reconnect');
        } catch {
          // The superseded socket may already be closing.
        }
      }
      reply(session, {
        type: 'joined',
        v: PROTOCOL_VERSION,
        code: msg.code,
        slot: result.seat.slot,
        token: result.seat.token,
        players: room.lobbyPlayers(),
      });
      rooms.broadcast(msg.code, {
        type: 'opponent_status',
        slot: result.seat.slot,
        status: 'reconnected',
      });
      rooms.broadcastLobby(msg.code);
      rooms.broadcastState(msg.code, true);
      log('player reconnected', { code: msg.code, slot: result.seat.slot });
      return;
    }
  }

  // Everything past this point requires a seat.
  const { code, slot } = session;
  if (code === null || slot === null) {
    fail(session, 'not_in_room', 'Join a room first.');
    return;
  }
  const room = rooms.get(code);
  if (!room) {
    fail(session, 'room_not_found', 'That room is gone.');
    session.code = null;
    session.slot = null;
    return;
  }

  switch (msg.type) {
    case 'ready': {
      room.setReady(slot, msg.ready, now);
      rooms.broadcastLobby(code);
      rooms.maybeStart(code);
      return;
    }

    case 'customize': {
      // Appearance is client-owned, but still bounded and sanitized by the
      // shared parser before it reaches the room. Broadcast it immediately so
      // both lobby previews and the in-ring model agree.
      room.setCustomization(slot, msg.customization, now);
      rooms.broadcastLobby(code);
      rooms.broadcastState(code, true);
      return;
    }

    case 'pose': {
      // Cosmetic for the opponent's avatar, authoritative only for the guard
      // line. Note what is *not* here: no position the server trusts for hit
      // detection, and certainly no pixels.
      room.setPose(slot, compactPose(msg.pose), msg.guard);
      return;
    }

    case 'action': {
      const engine = room.engine;
      if (!engine) {
        fail(session, 'not_in_room', 'No opponent yet.');
        return;
      }
      // The single most important line in the server: the client says what it
      // *tried* to do, and the engine decides whether that was legal.
      const events = engine.submitAction(slot, msg, now);
      rooms.emit(code, events);
      return;
    }

    case 'rematch': {
      const engine = room.engine;
      if (!engine) return;
      engine.state.players[slot].rematchWanted = true;
      rooms.broadcastLobby(code);
      rooms.maybeRematch(code);
      return;
    }

    case 'leave': {
      releaseSeat(session, true);
      return;
    }

    default:
      fail(session, 'bad_message', 'Unhandled message.');
  }
}

function seatInto(session: Session, code: string, name: string): void {
  const room = rooms.get(code);
  if (!room) {
    fail(session, 'room_not_found', 'That room is gone.');
    return;
  }
  const result = room.join(name, Date.now());
  if (!result.ok) {
    fail(session, 'room_full', 'That room already has two fencers.');
    return;
  }
  session.code = code;
  session.slot = result.seat.slot;
  rooms.attach(code, result.seat.slot, session.sink);
  reply(session, {
    type: 'joined',
    v: PROTOCOL_VERSION,
    code,
    slot: result.seat.slot,
    token: result.seat.token,
    players: room.lobbyPlayers(),
  });
  rooms.broadcastLobby(code);
  rooms.broadcastState(code, true);
  log('player seated', { code, slot: result.seat.slot, name });
}

// -------------------------------------------------------------------- wiring

const http = createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const body = JSON.stringify({
      ok: true,
      protocol: PROTOCOL_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      ...rooms.stats(),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

const wss = new WebSocketServer({
  server: http,
  path: '/ws',
  maxPayload: config.maxFrameBytes,
  // Compression is a poor trade here: messages are tiny and frequent, so the
  // per-message CPU and memory cost outweighs any saving.
  perMessageDeflate: false,
});

wss.on('connection', (socket, req) => {
  if (!originAllowed(req.headers.origin, config.allowedOrigins)) {
    log('rejected origin', { origin: req.headers.origin ?? '-' });
    socket.close(1008, 'origin not allowed');
    return;
  }
  if (sessions.size >= config.maxConnections) {
    socket.close(1013, 'server full');
    return;
  }

  const sink: Sink = {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    get open() {
      return socket.readyState === WebSocket.OPEN;
    },
  };

  const session: Session = {
    socket,
    sink,
    bucket: new TokenBucket(config.maxMessagesPerSecond),
    abuse: new AbuseCounter(),
    code: null,
    slot: null,
    alive: true,
  };
  sessions.add(session);

  socket.on('message', (raw) => {
    // The last line of defence. A bug in message handling must degrade to one
    // unhappy player, never to a dead process taking every match with it.
    try {
      handleMessage(session, raw);
    } catch (err) {
      log('message handler threw', { error: String(err) });
      fail(session, 'server_error', 'Something went wrong handling that.');
    }
  });

  socket.on('pong', () => {
    session.alive = true;
  });

  socket.on('error', (err) => {
    log('socket error', { error: String(err) });
  });

  socket.on('close', () => {
    sessions.delete(session);
    releaseSeat(session, false);
  });
});

// Simulation, snapshots and liveness each run on their own cadence: the match
// must advance faster than it is broadcast, and neither should wait on a
// heartbeat.
const tickTimer = setInterval(() => rooms.tickAll(), TICK_INTERVAL_MS);
const stateTimer = setInterval(() => {
  rooms.broadcastStates();
}, STATE_INTERVAL_MS);

const heartbeat = setInterval(() => {
  for (const session of sessions) {
    if (!session.alive) {
      // Missed two beats: the socket is a zombie. Terminating rather than
      // closing skips the handshake a dead peer will never answer.
      session.socket.terminate();
      continue;
    }
    session.alive = false;
    try {
      session.socket.ping();
    } catch {
      session.socket.terminate();
    }
  }
}, 5000);

function shutdown(signal: string): void {
  log('shutting down', { signal });
  clearInterval(tickTimer);
  clearInterval(stateTimer);
  clearInterval(heartbeat);
  for (const session of sessions) session.socket.close(1001, 'server shutting down');
  wss.close();
  http.close(() => process.exit(0));
  // Do not hang forever on a socket that refuses to close.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  // Staying up with one broken request beats dropping every live match.
  log('uncaught exception', { error: String(err?.stack ?? err) });
});
process.on('unhandledRejection', (reason) => {
  log('unhandled rejection', { error: String(reason) });
});

http.listen(config.port, config.host, () => {
  log('listening', {
    url: `ws://${config.host}:${config.port}/ws`,
    protocol: PROTOCOL_VERSION,
    origins: config.allowedOrigins.join(','),
  });
});
