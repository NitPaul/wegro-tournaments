/**
 * Live updates over Server-Sent Events.
 *
 * This replaces Firebase's `onValue`. The traffic is entirely one-directional —
 * the referee writes, forty phones on the touchline read — which is exactly the
 * shape SSE was designed for. Compared with WebSockets it needs no library on
 * either end, survives corporate proxies that mangle upgrade requests, and the
 * browser reconnects on its own after a dropped connection without a line of
 * reconnection code. Writes go over ordinary POSTs.
 *
 * Clients subscribe per tournament, so a phone watching last season's archive
 * is not woken by a goal in the live one.
 */

/** @type {Map<string, Set<object>>} tournamentId (or '*') -> subscribers */
const rooms = new Map();

/** Every open client, for heartbeats and shutdown. */
const clients = new Set();

let nextClientId = 1;

// Proxies and load balancers cut idle connections, typically after 30-60
// seconds. A comment line every 25 seconds is enough to keep the pipe warm and
// costs two bytes.
const HEARTBEAT_MS = 25_000;

const heartbeat = setInterval(() => {
  for (const client of clients) {
    try {
      client.res.write(": ping\n\n");
    } catch {
      drop(client);
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref();

/**
 * Turn a request into an event stream.
 * @param {string} room  tournament id, or '*' for every tournament
 */
export function openStream(req, res, room = "*") {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // nginx buffers proxied responses by default, which holds events back until
    // the buffer fills — meaning a goal appears on the phones a minute late.
    "X-Accel-Buffering": "no",
  });

  // Some proxies will not forward a response until they have seen some body.
  res.write(": connected\n\n");
  res.flushHeaders?.();

  const client = { id: nextClientId++, res, room, openedAt: Date.now() };
  clients.add(client);
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(client);

  send(client, "hello", { clientId: client.id, room, now: Date.now() });

  req.on("close", () => drop(client));
  req.on("error", () => drop(client));

  return client;
}

function send(client, event, data) {
  try {
    // `id:` lets the browser send Last-Event-ID when it reconnects. We do not
    // replay from it — a client that reconnects refetches the whole tournament,
    // which is a few kilobytes and always correct — but it keeps the stream
    // well-formed for anything that does care.
    client.res.write(`id: ${Date.now()}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    drop(client);
    return false;
  }
}

function drop(client) {
  clients.delete(client);
  rooms.get(client.room)?.delete(client);
  if (rooms.get(client.room)?.size === 0) rooms.delete(client.room);
  try {
    client.res.end();
  } catch {
    /* already gone */
  }
}

/**
 * Tell everyone watching a tournament that something changed.
 *
 * The payload says *what* changed, not the new state. Clients refetch the
 * tournament, which keeps one code path for "first load" and "something moved",
 * and means a client that missed an event while reconnecting is still correct.
 * At a few kilobytes per tournament this is cheaper than being clever.
 */
export function broadcast(tournamentId, event, payload = {}) {
  const body = { ...payload, tournamentId, at: Date.now() };
  let delivered = 0;

  for (const room of [tournamentId, "*"]) {
    for (const client of rooms.get(room) ?? []) {
      if (send(client, event, body)) delivered++;
    }
  }
  return delivered;
}

export function streamStats() {
  return {
    clients: clients.size,
    rooms: [...rooms.entries()].map(([room, set]) => ({ room, clients: set.size })),
  };
}

export function closeAllStreams() {
  clearInterval(heartbeat);
  for (const client of [...clients]) {
    try {
      send(client, "bye", { reason: "server shutting down" });
    } catch {
      /* ignore */
    }
    drop(client);
  }
  rooms.clear();
}
