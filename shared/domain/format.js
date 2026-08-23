/** Human-readable formatting. Pure, and shared with the server for the archive. */

export function formatUpdated(ts, nowMs = Date.now()) {
  if (!ts) return "not yet";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "not yet";

  const diff = nowMs - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function countdown(toISO, nowMs = Date.now()) {
  const target = new Date(toISO).getTime();
  if (Number.isNaN(target)) return null;
  const ms = target - nowMs;
  if (ms <= 0) return null;

  const s = Math.floor(ms / 1000);
  return {
    days: Math.floor(s / 86400),
    hours: Math.floor((s % 86400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
  };
}

/** "1 August 2026" from an ISO date, without pulling in a date library. */
export function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
