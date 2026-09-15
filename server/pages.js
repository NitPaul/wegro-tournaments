/**
 * The site's pages, at clean addresses.
 *
 *   /                 landing page — every tournament, upcoming, live and past
 *   /t/:slug          one tournament's scoreboard
 *   /players          the player list
 *   /players/:id      one player
 *   /hall-of-fame     every champion
 *   /admin            the console
 *   /auction/:slug    the auction projector screen
 *
 * Pages are served here rather than straight from the static folder for two
 * reasons: the addresses stay the same whatever file sits behind them, and
 * `{{PUBLIC_URL}}` in a page is filled in, because link previews on WhatsApp and
 * Facebook need an absolute image address and the domain is only known at run
 * time.
 *
 * Links shared for the 2026 tournament were `/?t=<slug>`. They still work: they
 * are redirected to `/t/<slug>`.
 */

import fs from "node:fs";
import path from "node:path";

import { env } from "./env.js";

const PAGES = [
  ["/", "index.html"],
  ["/t/:slug", "tournament.html"],
  ["/players", "players.html"],
  ["/players/:id", "players.html"],
  ["/hall-of-fame", "hall-of-fame.html"],
  ["/admin", "admin.html"],
  ["/auction/:slug", "auction.html"],
];

/** Old file addresses, so a bookmark to /admin.html still lands. */
const LEGACY = {
  "/index.html": "/",
  "/tournament.html": "/",
  "/players.html": "/players",
  "/hall-of-fame.html": "/hall-of-fame",
  "/admin.html": "/admin",
};

export function mountPages(app, publicDir) {
  const cache = new Map();

  const render = (file) => {
    if (env.isProduction && cache.has(file)) return cache.get(file);
    const html = fs
      .readFileSync(path.join(publicDir, file), "utf8")
      .replaceAll("{{PUBLIC_URL}}", env.publicUrl.replace(/\/+$/, ""));
    if (env.isProduction) cache.set(file, html);
    return html;
  };

  app.get("/", (req, res, next) => {
    const t = req.query.t;
    if (typeof t === "string" && t) return res.redirect(301, `/t/${encodeURIComponent(t)}`);
    next();
  });

  for (const [from, to] of Object.entries(LEGACY)) {
    app.get(from, (req, res) => {
      const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
      res.redirect(301, from === "/index.html" && req.query.t ? `/t/${encodeURIComponent(req.query.t)}` : to + qs);
    });
  }

  for (const [route, file] of PAGES) {
    app.get(route, (req, res) => {
      // Pages are not content-hashed, so they must always revalidate — a new
      // deploy has to reach phones that loaded the site yesterday.
      res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
      res.type("html").send(render(file));
    });
  }
}
