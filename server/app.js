/**
 * The Express application, without a port.
 *
 * Kept apart from server/index.js so the tests can start the real app — every
 * route, every permission check — on a temporary database, and so there is one
 * place that describes what the server does, separate from how it is run.
 */

import express from "express";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { env } from "./env.js";
import { attachUser } from "./auth/middleware.js";
import { parseCookies } from "./http/cookies.js";
import { notFound, errorHandler } from "./http/errors.js";
import { mountRoutes } from "./routes/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

export function createApp() {
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

  return app;
}
