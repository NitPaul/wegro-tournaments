/**
 * WeGro Tournaments — server entry point.
 *
 * Serves the browser app as plain static files (there is still no build step)
 * and a small JSON API behind it. Live updates go out over Server-Sent Events
 * rather than WebSockets: the traffic is one-directional — the referee writes,
 * everyone else reads — and SSE reconnects by itself, survives corporate
 * proxies, and needs no library on either end.
 */

import express from "express";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { env } from "./env.js";
import { applySchema, closeDatabase } from "./db/index.js";
import { ensureSuperAdmin } from "./auth/bootstrap.js";
import { attachUser } from "./auth/middleware.js";
import { parseCookies } from "./http/cookies.js";
import { notFound, errorHandler } from "./http/errors.js";
import { mountRoutes } from "./routes/index.js";
import { closeAllStreams } from "./stream/sse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

applySchema();
await ensureSuperAdmin();

const app = express();

// Behind Caddy/nginx the client IP arrives in X-Forwarded-For, and cookies need
// to know the original request was HTTPS.
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(express.json({ limit: "5mb" })); // 5mb covers a full tournament restore
app.use(parseCookies);
app.use(attachUser);

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  // script-src has no 'unsafe-inline': there are no inline <script> blocks or
  // onclick attributes anywhere in this app, and keeping it that way is what
  // makes this header worth having.
  //
  // style-src does allow inline, because generated markup sets real dynamic
  // values that way — a jersey swatch colour, a progress bar width, a chart
  // column height. Those cannot be precomputed into a stylesheet, and an
  // injected style attribute is a far smaller problem than injected script.
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-src https://www.google.com", // the venue map embed
      "form-action 'self'",
      "base-uri 'self'",
      "frame-ancestors 'self'",
      "object-src 'none'",
    ].join("; "),
  );

  if (env.isProduction && env.publicUrl.startsWith("https://")) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

// Deliberately before everything else and dependency-free, so an orchestrator
// gets a truthful answer even while the rest of the app is unhappy.
app.get("/healthz", (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), now: Date.now() });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

mountRoutes(app);

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

// Nothing is content-hashed, because there is no build step to hash it. So the
// markup and code must always revalidate: a score change must never be served
// from a stale cache. Fonts and images are safe to hold for a long time.
const staticOptions = {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (/[\\/]assets[\\/]fonts[\\/]/.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else if (/[\\/]assets[\\/]/.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=86400");
    } else {
      res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    }
  },
};

// The domain layer is shared verbatim between this server and the browser.
// One definition of how a league table sorts, imported by both.
app.use("/shared", express.static(path.join(root, "shared"), staticOptions));
app.use(express.static(path.join(root, "public"), { ...staticOptions, extensions: ["html"] }));

app.use(notFound);
app.use(errorHandler);

// ---------------------------------------------------------------------------
// Listen, and shut down cleanly
// ---------------------------------------------------------------------------

const server = app.listen(env.port, env.host, () => {
  console.log(`WeGro Tournaments listening on http://${env.host}:${env.port}`);
  console.log(`  public url : ${env.publicUrl}`);
  console.log(`  database   : ${env.databaseFile}`);
  console.log(`  mode       : ${env.isProduction ? "production" : "development"}`);
});

// SSE holds connections open indefinitely, so a plain server.close() would wait
// for viewers who are never going to disconnect on their own. Close the streams
// first, then the server, then the database.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — shutting down.`);

  closeAllStreams();
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });

  setTimeout(() => {
    console.warn("Shutdown took too long — exiting anyway.");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app, server };
