/**
 * One tournament per account — checked through HTTP, against the real app.
 *
 * The rule: an admin or referee account belongs to one tournament and can
 * neither see nor change any other. The console hides other tournaments, but
 * that is only tidiness. These tests are the lock.
 *
 * The central test does not use a hand-written list of routes. It reads every
 * route registered on the tournament router and calls each one against a
 * tournament the account does not belong to. A route added next season without
 * a permission check fails here before it can reach the live site.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/app.js";

let t;
let superC, adminA, refA, anon;
let A, B;
let tournamentRoutes;

/** Routes under /:tid that anybody may read, deliberately. Everything else is staff-only. */
const PUBLIC_READS = new Set(["GET /:tid"]);

before(async () => {
  t = await startTestServer();
  ({ tournamentRoutes } = await import("../../server/routes/tournaments.js"));

  const boss = await t.makeUser({ username: "boss", isSuper: true, email: "boss@wegro.test" });
  superC = t.client();
  await superC.login(boss.username, boss.password);

  A = (await superC.post("/api/tournaments", { name: "Alpha Cup", season: "2027" })).body.tournament;
  B = (await superC.post("/api/tournaments", { name: "Bravo Cup", season: "2027" })).body.tournament;
  // Published, so B's public scoreboard is readable — that must not be confused
  // with its admin data being readable.
  await superC.patch(`/api/tournaments/${A.id}`, { status: "active" });
  await superC.patch(`/api/tournaments/${B.id}`, { status: "active" });

  const mk = async (username, role, tid) => {
    const res = await superC.post("/api/users", {
      username,
      name: username,
      password: "correct-horse-battery",
      role,
      tournamentId: tid,
    });
    assert.equal(res.status, 201, `creating ${username}: ${res.body?.error?.message}`);
    const c = t.client();
    await c.login(username, "correct-horse-battery");
    return c;
  };
  adminA = await mk("alpha-admin", "admin", A.id);
  refA = await mk("alpha-ref", "referee", A.id);
  anon = t.client();
});

after(() => t?.stop());

/** Every registered route with its params filled in, aimed at tournament `tid`. */
function routesFor(tid) {
  const out = [];
  for (const layer of tournamentRoutes.stack) {
    if (!layer.route || !layer.route.path.includes(":tid")) continue;
    for (const method of Object.keys(layer.route.methods)) {
      const pattern = `${method.toUpperCase()} ${layer.route.path}`;
      const url = "/api/tournaments" + layer.route.path.replace(":tid", tid).replace(/:(\w+)/g, "x_$1");
      out.push({ pattern, method: method.toUpperCase(), url });
    }
  }
  return out;
}

describe("an account for one tournament, pointed at another", () => {
  it("finds the routes to check (a guard against this test silently checking nothing)", () => {
    const routes = routesFor("B");
    assert.ok(routes.length >= 25, `only ${routes.length} routes found`);
  });

  for (const who of ["admin", "referee"]) {
    it(`refuses the ${who} of A on every staff route of B`, async () => {
      const c = who === "admin" ? adminA : refA;
      const leaks = [];
      for (const r of routesFor(B.id)) {
        if (PUBLIC_READS.has(r.pattern)) continue;
        const res = await c.call(r.method, r.url, r.method === "GET" ? undefined : {});
        if (res.status !== 403) leaks.push(`${r.pattern} → ${res.status}`);
      }
      assert.deepEqual(leaks, [], "every one of these must be 403");
    });
  }

  it("refuses anybody signed out on every staff route", async () => {
    const leaks = [];
    for (const r of routesFor(B.id)) {
      if (PUBLIC_READS.has(r.pattern)) continue;
      const res = await anon.call(r.method, r.url, r.method === "GET" ? undefined : {});
      if (res.status !== 401) leaks.push(`${r.pattern} → ${res.status}`);
    }
    assert.deepEqual(leaks, []);
  });

  it("cannot read B's staff list or activity", async () => {
    assert.equal((await adminA.get(`/api/tournaments/${B.id}/staff`)).status, 403);
    assert.equal((await adminA.get(`/api/tournaments/${B.id}/activity`)).status, 403);
  });

  it("can still read its own", async () => {
    assert.equal((await adminA.get(`/api/tournaments/${A.id}/staff`)).status, 200);
    assert.equal((await adminA.get(`/api/tournaments/${A.id}/activity`)).status, 200);
  });

  it("is told about its own tournament only", async () => {
    const me = (await adminA.get("/api/auth/me")).body;
    assert.equal(me.tournaments.length, 1);
    assert.equal(me.tournaments[0].id, A.id);
    assert.equal(me.tournaments[0].code, A.code);
    assert.ok(!JSON.stringify(me).includes(B.id), "B's id must not appear anywhere in the response");
  });

  it("cannot reach the super admin's overview or accounts", async () => {
    assert.equal((await adminA.get("/api/tournaments/overview")).status, 403);
    assert.equal((await adminA.get("/api/users")).status, 403);
    assert.equal((await adminA.post("/api/users", { username: "sneaky" })).status, 403);
    assert.equal((await adminA.post("/api/tournaments", { name: "Mine" })).status, 403);
  });
});

describe("tournament codes", () => {
  it("are given at creation", () => {
    assert.match(A.code, /^WGT-[0-9A-F]{6}$/);
    assert.notEqual(A.code, B.code);
  });

  it("survive a rename by the tournament's own admin, and so does the link", async () => {
    const res = await adminA.patch(`/api/tournaments/${A.id}`, { name: "Alpha Premier League" });
    assert.equal(res.status, 200, res.body?.error?.message);
    assert.equal(res.body.tournament.name, "Alpha Premier League");
    assert.equal(res.body.tournament.code, A.code);
    assert.equal(res.body.tournament.slug, A.slug);
  });

  it("cannot be changed through an update, even by the super admin", async () => {
    await superC.patch(`/api/tournaments/${B.id}`, { code: "WGT-000000" });
    const after = (await superC.get(`/api/tournaments/${B.id}`)).body.tournament;
    assert.equal(after.code, B.code);
  });

  it("let the super admin follow a renamed tournament", async () => {
    const { tournaments } = (await superC.get("/api/tournaments/overview")).body;
    const row = tournaments.find((x) => x.code === A.code);
    assert.equal(row.name, "Alpha Premier League");
    assert.deepEqual(row.previousNames, ["Alpha Cup"]);
    assert.deepEqual(row.staff.map((s) => s.username).sort(), ["alpha-admin", "alpha-ref"]);
  });
});

describe("accounts", () => {
  it("require a tournament for an admin or referee", async () => {
    const res = await superC.post("/api/users", {
      username: "floating",
      name: "Floating",
      password: "correct-horse-battery",
      role: "admin",
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /tournament/);
  });

  it("cannot be moved onto a second tournament", async () => {
    const { users } = (await superC.get("/api/users")).body;
    const alphaAdmin = users.find((u) => u.username === "alpha-admin");
    const res = await superC.post(`/api/tournaments/${B.id}/staff`, { userId: alphaAdmin.id, role: "referee" });
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, new RegExp(A.code));
  });

  it("refuse a User ID that is taken, whatever its case", async () => {
    const res = await superC.post("/api/users", {
      username: "Alpha-Admin",
      name: "Copy",
      password: "correct-horse-battery",
      role: "referee",
      tournamentId: B.id,
    });
    assert.equal(res.status, 409);
  });

  it("sign in with a User ID, or with an email where the account has one", async () => {
    const byEmail = t.client();
    assert.equal((await byEmail.call("POST", "/api/auth/login", { login: "boss@wegro.test", password: "correct-horse-battery" })).status, 200);
    const byOldField = t.client();
    assert.equal(
      (await byOldField.call("POST", "/api/auth/login", { email: "BOSS", password: "correct-horse-battery" })).status,
      200,
      "the old `email` field and any letter case still work, so nobody is locked out by the deploy",
    );
  });

  it("have no self-registration any more", async () => {
    const res = await anon.post("/api/auth/register", { username: "x", password: "correct-horse-battery" });
    assert.equal(res.status, 404);
  });

  it("stop working the moment the super admin resets the password", async () => {
    const c = t.client();
    await c.login("alpha-ref", "correct-horse-battery");
    const { users } = (await superC.get("/api/users")).body;
    const ref = users.find((u) => u.username === "alpha-ref");
    assert.equal((await superC.post(`/api/users/${ref.id}/password`, { password: "a-brand-new-one" })).status, 200);
    assert.equal((await c.get(`/api/tournaments/${A.id}/staff`)).status, 401, "their old session is gone");
    refA = t.client();
    await refA.login("alpha-ref", "a-brand-new-one");
  });
});

describe("a finished tournament", () => {
  before(async () => {
    assert.equal((await superC.patch(`/api/tournaments/${A.id}`, { status: "completed" })).status, 200);
  });

  it("is read-only to its own admin", async () => {
    const res = await adminA.patch(`/api/tournaments/${A.id}`, { name: "Changed after the fact" });
    assert.equal(res.status, 403);
    assert.match(res.body.error.message, /finished/);
    assert.equal((await adminA.post(`/api/tournaments/${A.id}/teams`, { name: "Late" })).status, 403);
  });

  it("is read-only to its referee", async () => {
    assert.equal((await refA.post(`/api/tournaments/${A.id}/matches/x/events`, { type: "goal" })).status, 403);
  });

  it("can still be read by them", async () => {
    assert.equal((await adminA.get(`/api/tournaments/${A.id}/staff`)).status, 200);
    const doc = await adminA.get(`/api/tournaments/${A.id}`);
    assert.equal(doc.status, 200);
    assert.equal(doc.body.permissions.readOnly, true);
    assert.equal(doc.body.permissions.canManage, false);
  });

  it("stays editable by the super admin, who can also reopen it", async () => {
    assert.equal((await superC.post(`/api/tournaments/${A.id}/meta`, { venueName: "ChattoTurf" })).status, 200);
    assert.equal((await superC.patch(`/api/tournaments/${A.id}`, { status: "active" })).status, 200);
    assert.equal((await adminA.post(`/api/tournaments/${A.id}/meta`, { venueName: "Back open" })).status, 200);
  });
});
