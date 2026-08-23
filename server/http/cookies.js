/**
 * Cookie reading and writing, without a dependency.
 *
 * This is about forty lines of well-specified string handling, and every line
 * of it is visible here rather than in a package somebody has to audit. Given
 * the whole point of this rewrite is a system a senior developer can take over,
 * a dependency that saves forty readable lines is a bad trade.
 */

import { env } from "../env.js";

/** Express middleware: populates `req.cookies`. */
export function parseCookies(req, res, next) {
  req.cookies = decode(req.headers.cookie);
  next();
}

export function decode(header) {
  const out = Object.create(null);
  if (!header) return out;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (name in out) continue; // first wins, matching browser precedence
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value; // malformed percent-encoding — keep it raw rather than throw
    }
  }
  return out;
}

/**
 * Build a Set-Cookie value.
 *
 * `Secure` follows PUBLIC_URL rather than being hardcoded, because a cookie
 * marked Secure is simply never sent over plain HTTP — so hardcoding it would
 * make local development fail with a login form that silently forgets you,
 * while hardcoding it off would leak the session on a production deployment.
 */
export function serialize(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  parts.push(`Path=${options.path || "/"}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure ?? env.publicUrl.startsWith("https://")) parts.push("Secure");

  // Lax, not Strict: Strict would drop the session cookie when someone opens
  // the admin console from a link in an email or a chat message, which reads
  // as "it logged me out again" rather than as a security feature.
  parts.push(`SameSite=${options.sameSite || "Lax"}`);

  return parts.join("; ");
}

export function setCookie(res, name, value, options) {
  const existing = res.getHeader("Set-Cookie");
  const cookie = serialize(name, value, options);
  res.setHeader("Set-Cookie", existing ? [].concat(existing, cookie) : cookie);
}

export function clearCookie(res, name, options = {}) {
  setCookie(res, name, "", { ...options, maxAge: 0, expires: new Date(0) });
}
