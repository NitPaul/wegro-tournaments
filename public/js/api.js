/**
 * The browser's view of the server.
 *
 * This replaces the Firebase SDK entirely. What used to be `onValue` on a
 * database node is now a Server-Sent Events subscription; what used to be
 * `writeMany` on that node is now ordinary POSTs to endpoints that check
 * permissions before they do anything.
 *
 * One behaviour worth understanding: an SSE message never carries the new
 * state, only a note that something changed. The client then refetches the
 * whole tournament. That sounds wasteful and is not — a tournament is a few
 * kilobytes — and it buys two real things: one code path for "first load" and
 * "something moved", and a client that is always correct even if it missed an
 * event while its phone was reconnecting on bad turf wifi.
 */

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Thrown for any non-2xx response, carrying the server's human-readable message. */
export class ApiError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : JSON_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    // fetch only rejects when the request never completed — offline, DNS, a
    // server that is down. Say that, rather than "Failed to fetch".
    throw new ApiError(0, "offline", "Cannot reach the server. Check your connection.");
  }

  if (res.status === 204) return null;

  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, "bad_response", "The server sent something unexpected.");
  }

  if (!res.ok) {
    const err = payload?.error ?? {};
    throw new ApiError(res.status, err.code ?? "error", err.message ?? `Request failed (${res.status}).`, err.detail);
  }
  return payload;
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body ?? {}),
  patch: (path, body) => request("PATCH", path, body ?? {}),
  del: (path, body) => request("DELETE", path, body),
};

/* ------------------------------------------------------------------- auth */

export const auth = {
  me: () => api.get("/auth/me"),
  login: (email, password) => api.post("/auth/login", { email, password }),
  register: (name, email, password) => api.post("/auth/register", { name, email, password }),
  logout: () => api.post("/auth/logout"),
  changePassword: (currentPassword, newPassword) =>
    api.post("/auth/password", { currentPassword, newPassword }),
};

/* ------------------------------------------------------------ tournaments */

export const tournaments = {
  list: () => api.get("/tournaments"),
  get: (tid) => api.get(`/tournaments/${encodeURIComponent(tid)}`),
  create: (body) => api.post("/tournaments", body),
  update: (tid, body) => api.patch(`/tournaments/${encodeURIComponent(tid)}`, body),
  remove: (tid) => api.del(`/tournaments/${encodeURIComponent(tid)}`),
  settings: (tid, body) => api.post(`/tournaments/${encodeURIComponent(tid)}/settings`, body),
  meta: (tid, body) => api.post(`/tournaments/${encodeURIComponent(tid)}/meta`, body),

  staff: (tid) => api.get(`/tournaments/${encodeURIComponent(tid)}/staff`),
  assign: (tid, userId, role) => api.post(`/tournaments/${encodeURIComponent(tid)}/staff`, { userId, role }),
  unassign: (tid, userId) => api.del(`/tournaments/${encodeURIComponent(tid)}/staff/${userId}`),

  addTeam: (tid, body) => api.post(`/tournaments/${encodeURIComponent(tid)}/teams`, body),
  updateTeam: (tid, teamId, body) => api.patch(`/tournaments/${encodeURIComponent(tid)}/teams/${teamId}`, body),
  removeTeam: (tid, teamId) => api.del(`/tournaments/${encodeURIComponent(tid)}/teams/${teamId}`),

  addPlayer: (tid, body) => api.post(`/tournaments/${encodeURIComponent(tid)}/players`, body),
  updatePlayer: (tid, playerId, body) =>
    api.patch(`/tournaments/${encodeURIComponent(tid)}/players/${playerId}`, body),
  removePlayer: (tid, playerId) => api.del(`/tournaments/${encodeURIComponent(tid)}/players/${playerId}`),

  sell: (tid, playerId, teamId, price) =>
    api.post(`/tournaments/${encodeURIComponent(tid)}/auction/sell`, { playerId, teamId, price }),
  unsell: (tid, playerId) => api.post(`/tournaments/${encodeURIComponent(tid)}/auction/unsell`, { playerId }),
  placeGuest: (tid, playerId, teamId) =>
    api.post(`/tournaments/${encodeURIComponent(tid)}/auction/guest`, { playerId, teamId }),
  resetAuction: (tid) => api.post(`/tournaments/${encodeURIComponent(tid)}/auction/reset`),

  generateFixtures: (tid, body) =>
    api.post(`/tournaments/${encodeURIComponent(tid)}/matches/generate`, body ?? {}),
  addMatch: (tid, body) => api.post(`/tournaments/${encodeURIComponent(tid)}/matches`, body),
  updateMatch: (tid, matchId, body) =>
    api.patch(`/tournaments/${encodeURIComponent(tid)}/matches/${matchId}`, body),
  clearMatch: (tid, matchId) => api.post(`/tournaments/${encodeURIComponent(tid)}/matches/${matchId}/clear`),
  removeMatch: (tid, matchId) => api.del(`/tournaments/${encodeURIComponent(tid)}/matches/${matchId}`),
  clearAllScores: (tid) => api.post(`/tournaments/${encodeURIComponent(tid)}/scores/clear`),

  addEvent: (tid, matchId, body) =>
    api.post(`/tournaments/${encodeURIComponent(tid)}/matches/${matchId}/events`, body),
  updateEvent: (tid, matchId, eventId, body) =>
    api.patch(`/tournaments/${encodeURIComponent(tid)}/matches/${matchId}/events/${eventId}`, body),
  removeEvent: (tid, matchId, eventId, body) =>
    api.del(`/tournaments/${encodeURIComponent(tid)}/matches/${matchId}/events/${eventId}`, body),

  recomputeArchive: (tid) => api.post(`/tournaments/${encodeURIComponent(tid)}/archive/recompute`),
};

export const users = {
  list: (status) => api.get(`/users${status ? `?status=${status}` : ""}`),
  create: (body) => api.post("/users", body),
  setStatus: (id, status) => api.post(`/users/${id}/status`, { status }),
  setSuper: (id, isSuper) => api.post(`/users/${id}/super`, { isSuper }),
  remove: (id) => api.del(`/users/${id}`),
};

export const archive = {
  list: () => api.get("/archive"),
};

export const transfer = {
  /** Import a parsed backup from the old Firebase site. */
  firebase: (backup, options = {}) => api.post("/import/firebase", { backup, ...options }),
  /** A download URL rather than a fetch — the browser saves the file itself. */
  exportUrl: (tid) => `/api/import/export/${encodeURIComponent(tid)}`,
};

/* -------------------------------------------------------------- live sync */

/**
 * Watch a tournament and call `onChange(data)` whenever it moves.
 *
 * Fetches immediately, then on every server event. Returns an unsubscribe.
 *
 * `EventSource` handles reconnection itself, including backoff, which is the
 * main reason this is SSE rather than a WebSocket: there is no reconnection
 * code here to get wrong, and a phone that goes through a dead spot at the turf
 * comes back on its own.
 */
export function watchTournament(tid, onChange, onError) {
  let stopped = false;
  let source = null;
  let inFlight = false;
  let queued = false;

  async function refresh() {
    if (stopped) return;
    // Collapse a burst — several goals logged in quick succession should cost
    // one refetch after the last one, not one each.
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    try {
      const payload = await tournaments.get(tid);
      if (!stopped) onChange(payload.tournament, payload.permissions ?? null);
    } catch (err) {
      if (!stopped) onError?.(err);
    } finally {
      inFlight = false;
      if (queued && !stopped) {
        queued = false;
        refresh();
      }
    }
  }

  refresh();

  try {
    source = new EventSource(`/api/stream/${encodeURIComponent(tid)}`);
    source.addEventListener("changed", refresh);
    source.addEventListener("deleted", () => onError?.(new ApiError(404, "deleted", "This tournament was removed.")));
  } catch {
    // No EventSource (very old browser, or a proxy that refuses the stream).
    // Fall back to polling so the scoreboard still updates, just less promptly.
    const timer = setInterval(refresh, 10_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  return () => {
    stopped = true;
    source?.close();
  };
}

/**
 * The server's clock, so a viewer whose phone is minutes out still sees the
 * right match time. Measured once on load from the health endpoint, then
 * applied as a fixed offset.
 */
let clockOffset = 0;

export async function syncClock() {
  try {
    const before = Date.now();
    const res = await fetch("/healthz", { credentials: "same-origin" });
    const { now } = await res.json();
    const latency = (Date.now() - before) / 2;
    clockOffset = now + latency - Date.now();
  } catch {
    clockOffset = 0; // the device clock is better than nothing
  }
}

export const serverNow = () => Date.now() + clockOffset;
