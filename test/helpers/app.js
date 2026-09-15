/**
 * Start the real server on a throwaway database, for tests that go through
 * HTTP: every route, every permission check, exactly as deployed.
 *
 * Each test file runs in its own process under `node --test`, so pointing
 * DATA_DIR somewhere temporary before the first import is enough to isolate it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export async function startTestServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wgt-api-"));
  process.env.DATA_DIR = dataDir;
  process.env.SESSION_SECRET = "test-secret-".repeat(4);
  process.env.NODE_ENV = "test";
  process.env.PUBLIC_URL = "http://127.0.0.1";

  const dbm = await import("../../server/db/index.js");
  dbm.applySchema();
  const { createApp } = await import("../../server/app.js");
  const { hashPassword } = await import("../../server/auth/password.js");

  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  /** Insert an account directly, bypassing the API — for arranging a test. */
  async function makeUser({ username, password = "correct-horse-battery", name = username, isSuper = false, email = null }) {
    const id = dbm.newId("us");
    dbm.db
      .prepare(
        `INSERT INTO users (id, username, email, password_hash, name, is_super, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(id, username, email, await hashPassword(password), name, isSuper ? 1 : 0, Date.now());
    return { id, username, password };
  }

  /** A client with its own cookie jar. */
  function client() {
    let cookie = "";
    const call = async (method, url, body) => {
      const res = await fetch(base + url, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
      });
      const set = res.headers.getSetCookie?.() ?? [];
      for (const c of set) {
        const pair = c.split(";")[0];
        if (pair.startsWith("wgt_session=")) cookie = pair.endsWith("=") ? "" : pair;
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON */
      }
      return { status: res.status, body: json };
    };
    return {
      get: (url) => call("GET", url),
      post: (url, body = {}) => call("POST", url, body),
      patch: (url, body = {}) => call("PATCH", url, body),
      put: (url, body = {}) => call("PUT", url, body),
      del: (url, body) => call("DELETE", url, body),
      call,
      async login(login, password) {
        const res = await call("POST", "/api/auth/login", { login, password });
        if (res.status !== 200) throw new Error(`login ${login} failed: ${res.status} ${res.body?.error?.message}`);
        return res;
      },
    };
  }

  async function stop() {
    await new Promise((resolve) => server.close(resolve));
    dbm.closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return { base, db: dbm.db, makeUser, client, stop };
}
