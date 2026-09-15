/**
 * Page addresses. The ones that matter most are the old ones: every link shared
 * for the 2026 tournament was /?t=<slug>, and those must keep landing.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/app.js";

let t;
const get = (url) => fetch(t.base + url, { redirect: "manual" });

before(async () => {
  t = await startTestServer();
});
after(() => t?.stop());

describe("pages", () => {
  it("serves the landing page at /", async () => {
    const res = await get("/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /html/);
    assert.match(await res.text(), /Every match/);
  });

  it("sends old /?t=<slug> links to the tournament's new address", async () => {
    const res = await get("/?t=wegro-champions-league-2026");
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "/t/wegro-champions-league-2026");
  });

  it("serves a tournament, the player list and a player at clean addresses", async () => {
    for (const url of ["/t/anything", "/players", "/players/pp_12345678", "/hall-of-fame", "/admin"]) {
      const res = await get(url);
      assert.equal(res.status, 200, url);
      assert.match(res.headers.get("cache-control"), /must-revalidate/, `${url} must never be served stale after a deploy`);
    }
  });

  it("redirects the old .html addresses", async () => {
    for (const [from, to] of [["/admin.html", "/admin"], ["/hall-of-fame.html", "/hall-of-fame"], ["/index.html", "/"]]) {
      const res = await get(from);
      assert.equal(res.status, 301, from);
      assert.equal(res.headers.get("location"), to);
    }
  });

  it("fills in the public address for link previews", async () => {
    const html = await (await get("/")).text();
    assert.ok(!html.includes("{{PUBLIC_URL}}"));
    assert.match(html, /og:image" content="http:\/\/127\.0\.0\.1\/assets\/og\.png"/);
  });

  it("still serves scripts, styles and images", async () => {
    for (const url of ["/js/landing.js", "/css/landing.css", "/assets/wegro-logo-on-dark.svg", "/shared/domain/phase.js"]) {
      assert.equal((await get(url)).status, 200, url);
    }
  });

  it("gives the landing page its numbers", async () => {
    const res = await get("/api/site");
    assert.equal(res.status, 200);
    const { totals } = await res.json();
    assert.deepEqual(Object.keys(totals).sort(), ["goals", "matches", "players", "tournaments"]);
  });
});
