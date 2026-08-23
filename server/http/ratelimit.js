/**
 * A small in-memory rate limiter.
 *
 * Scoped to what it is actually for: stopping someone grinding passwords
 * against the login form. It is per-process and resets on restart, which is
 * fine for a single container. If this is ever run behind more than one
 * instance, move the counter into SQLite or in front of the app — but do not
 * pretend the in-memory one is still doing its job.
 */

import { tooMany } from "./errors.js";

const buckets = new Map();

// Sweep occasionally so an abandoned bucket for every IP that ever tried does
// not accumulate. unref so it never keeps the process alive.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000);
sweeper.unref();

/**
 * @param {object}  options
 * @param {number}  options.max        attempts allowed inside the window
 * @param {number}  options.windowMs   window length
 * @param {string}  options.name       bucket namespace, so login and register do not share a count
 * @param {(req) => string} [options.key] what to count by; defaults to client IP
 */
export function rateLimit({ max = 10, windowMs = 60_000, name = "default", key } = {}) {
  return function limiter(req, res, next) {
    const id = `${name}:${key ? key(req) : req.ip}`;
    const now = Date.now();

    let bucket = buckets.get(id);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(id, bucket);
    }

    bucket.count++;

    const remaining = Math.max(0, max - bucket.count);
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(Math.ceil((bucket.resetAt - now) / 1000)));

    if (bucket.count > max) {
      const seconds = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(seconds));
      return next(
        tooMany(
          `Too many attempts. Try again in ${seconds < 60 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`}.`,
        ),
      );
    }
    next();
  };
}

/** Forget a bucket — called after a successful login so one typo does not cost the next attempt. */
export function clearLimit(name, id) {
  buckets.delete(`${name}:${id}`);
}
