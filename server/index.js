/**
 * WeGro Tournaments — server entry point.
 *
 * Serves the browser app as plain static files (there is still no build step)
 * and a small JSON API behind it. Live updates go out over Server-Sent Events
 * rather than WebSockets: the traffic is one-directional — the referee writes,
 * everyone else reads — and SSE reconnects by itself, survives corporate
 * proxies, and needs no library on either end.
 */

import process from "node:process";

import { createApp } from "./app.js";
import { env } from "./env.js";
import { applySchema, closeDatabase } from "./db/index.js";
import { ensureSuperAdmin } from "./auth/bootstrap.js";
import { closeAllStreams } from "./stream/sse.js";

applySchema();
await ensureSuperAdmin();

const app = createApp();

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
