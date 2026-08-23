/**
 * Error handling.
 *
 * Two audiences, and they need different things. The browser gets a stable
 * `{ error: { code, message } }` shape it can render straight into a toast, in
 * language an organiser can act on. The server log gets the stack trace.
 *
 * What the browser never gets is an internal message: a 500 says "Something
 * went wrong on the server" no matter what actually threw, because SQLite
 * constraint text and file paths are not for the touchline.
 */

import { env } from "../env.js";

export class HttpError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.expected = true; // distinguishes "the user did something invalid" from "we broke"
  }
}

export const badRequest = (message, detail) => new HttpError(400, "bad_request", message, detail);
export const unauthorized = (message = "Sign in to do that.") =>
  new HttpError(401, "unauthorized", message);
export const forbidden = (message = "You do not have permission to do that.") =>
  new HttpError(403, "forbidden", message);
export const notFoundError = (message = "Not found.") => new HttpError(404, "not_found", message);
export const conflict = (message, detail) => new HttpError(409, "conflict", message, detail);
export const tooMany = (message = "Too many attempts. Wait a moment and try again.") =>
  new HttpError(429, "too_many_requests", message);

/**
 * Wrap an async route handler so a rejected promise reaches the error handler.
 * Express 5 does forward rejections on its own, but being explicit keeps the
 * behaviour obvious at every call site rather than depending on a version.
 */
export const route = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

export function notFound(req, res, next) {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      error: { code: "not_found", message: `No such endpoint: ${req.method} ${req.path}` },
    });
  }
  next();
}

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const known = err instanceof HttpError || err?.expected;
  const status = known ? err.status || 400 : 500;

  if (!known) {
    console.error(`[error] ${req.method} ${req.originalUrl}`);
    console.error(err);
  } else if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl} — ${err.message}`);
  }

  const body = {
    error: {
      code: known ? err.code || "error" : "server_error",
      message: known ? err.message : "Something went wrong on the server. Please try again.",
    },
  };
  if (known && err.detail) body.error.detail = err.detail;
  // A stack trace in development saves a trip to the terminal. Never in production.
  if (!known && !env.isProduction) body.error.stack = err.stack;

  res.status(status).json(body);
}
