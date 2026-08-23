/**
 * Importing from the old Firebase site.
 *
 * The assertion that matters: a goal the old console stored as
 * `scorerName: "Robiullah"` — with no player id, because captains were not
 * players — must come out of this import attached to a real player and counted
 * in the statistics tables. That is the reported bug being fixed retroactively
 * against data that already exists.
 */

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

let D;
let importFirebaseBackup;
let loadTournament;
let closeDatabase;
let workDir;

/**
 * Point the database at a throwaway directory before anything imports it — the
 * db module resolves its file path at module-evaluation time, so this has to
 * happen before the dynamic imports below.
 */
before(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wgt-import-"));
  process.env.DATA_DIR = workDir;
  process.env.SESSION_SECRET = "test".repeat(12);
  process.env.NODE_ENV = "test";

  D = await import("../../shared/domain/index.js");
  const dbModule = await import("../../server/db/index.js");
  dbModule.applySchema();
  closeDatabase = dbModule.closeDatabase;

  ({ importFirebaseBackup } = await import("../../server/import/firebase-backup.js"));
  ({ loadTournament } = await import("../../server/db/repo/tournaments.js"));
});

after(() => {
  closeDatabase?.();
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** A backup in exactly the shape the old site's Danger → Download backup wrote. */
function legacyBackup(overrides = {}) {
  return {
    _format: "wegro-champions-league",
    _version: 1,
    tournament: {
      meta: { name: "WeGro Champions League", season: "2026", venueName: "ChattoTurf" },
      settings: { budget: 100, basePrice: 8, squadSize: 6 },
      teams: {
        t1: { id: "t1", slot: "A", name: "LOSS MAKER", captainName: "KBD MD. Robiullah", jerseyCost: 3 },
        t2: { id: "t2", slot: "B", name: "LEGACY", captainName: "MD. Alvi Rahman", jerseyCost: 5 },
      },
      players: {
        p01: { id: "p01", name: "Sabbir", pos: "GK", price: 17, teamId: "t2" },
        p02: { id: "p02", name: "Jubair", pos: "GK", price: 8, teamId: "t1" },
        p18: { id: "p18", name: "Munna", pos: "FWD", price: 12, teamId: "t1" },
        s1: { id: "s1", name: "Chairman", pos: "MID", price: 0, special: true, teamId: null },
      },
      matches: {
        m1: {
          id: "m1",
          no: 1,
          homeId: "t1",
          awayId: "t2",
          homeScore: 3,
          awayScore: 1,
          status: "ft",
          events: {
            // A normal goal — the old model stored a real id for these.
            e1: { id: "e1", type: "goal", teamId: "t1", scorerId: "p18", assistId: "p02" },
            // A CAPTAIN goal. No id anywhere: this is the data that vanished.
            e2: { id: "e2", type: "goal", teamId: "t1", scorerName: "KBD MD. Robiullah" },
            // A captain assist, same problem.
            e3: { id: "e3", type: "goal", teamId: "t1", scorerId: "p18", assistName: "KBD MD. Robiullah" },
            // A save by the opposing captain, stored under playerName.
            e4: { id: "e4", type: "save", teamId: "t2", playerName: "MD. Alvi Rahman" },
            // The old console's placeholder when nobody caught the scorer.
            e5: { id: "e5", type: "goal", teamId: "t2", scorerName: "Player not recorded" },
          },
        },
      },
      ...overrides,
    },
  };
}

function importFixture(backup, options = {}) {
  const file = path.join(workDir, `backup-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(backup));
  const report = importFirebaseBackup(file, { status: "active", ...options });
  return { report, data: loadTournament(report.tournamentId) };
}

describe("importing a legacy backup", () => {
  it("turns every captain into a real player", () => {
    const { report, data } = importFixture(legacyBackup());

    assert.equal(report.counts.captains, 2);
    const captains = Object.values(data.players).filter((p) => p.kind === "captain");
    assert.equal(captains.length, 2);
    assert.deepEqual(
      captains.map((c) => c.name).sort(),
      ["KBD MD. Robiullah", "MD. Alvi Rahman"],
    );
    assert.ok(captains.every((c) => c.teamId), "a captain always belongs to a team");
  });

  it("recovers a captain goal that had no player id — the reported bug", () => {
    const { data } = importFixture(legacyBackup());
    const captain = Object.values(data.players).find((p) => p.name === "KBD MD. Robiullah");

    const row = D.playerStats(data).find((r) => r.playerId === captain.id);
    assert.equal(row.goals, 1, "the captain's goal must now be counted");
    assert.equal(row.assists, 1, "and so must the captain's assist");

    const scorers = D.topScorers(data);
    assert.ok(
      scorers.some((s) => s.playerId === captain.id),
      "the captain must appear in the top scorers table",
    );
  });

  it("recovers a captain's save stored under playerName", () => {
    const { data } = importFixture(legacyBackup());
    const captain = Object.values(data.players).find((p) => p.name === "MD. Alvi Rahman");

    assert.equal(D.playerStats(data).find((r) => r.playerId === captain.id).saves, 1);
  });

  it("reports what it resolved by name", () => {
    const { report } = importFixture(legacyBackup());
    assert.ok(report.resolvedByName.length >= 3, "the name-only events should be reported, not silent");
    assert.ok(report.resolvedByName.every((r) => r.name && r.where));
  });

  it("leaves an unrecorded scorer unattributed rather than inventing a player", () => {
    const { report, data } = importFixture(legacyBackup());

    assert.ok(!Object.values(data.players).some((p) => p.name === "Player not recorded"));
    const left = report.unresolved.find((u) => u.name === "Player not recorded");
    assert.ok(left, "and it must say so");
    assert.match(left.action, /unattributed/);
  });

  it("adds an unknown name as a guest rather than discarding the event", () => {
    const backup = legacyBackup();
    backup.tournament.matches.m1.events.e6 = {
      id: "e6",
      type: "goal",
      teamId: "t1",
      scorerName: "Somebody Nobody Recorded",
    };

    const { report, data } = importFixture(backup);
    const created = Object.values(data.players).find((p) => p.name === "Somebody Nobody Recorded");
    assert.ok(created, "the goal must not be thrown away");
    assert.equal(created.kind, "guest");
    assert.ok(report.unresolved.some((u) => u.name === "Somebody Nobody Recorded"));
  });

  it("keeps the scoreline and the squads intact", () => {
    const { data } = importFixture(legacyBackup());
    const match = Object.values(data.matches)[0];

    assert.equal(match.homeScore, 3);
    assert.equal(match.awayScore, 1);
    assert.equal(match.status, "ft");

    const loss = Object.values(data.teams).find((t) => t.name === "LOSS MAKER");
    assert.equal(loss.jerseyCost, 3);
    assert.equal(D.teamSquad(data, loss.id).length, 2, "two bought players");
    assert.equal(D.teamPlayers(data, loss.id).length, 3, "plus the captain");
  });

  it("carries a special player across as a guest", () => {
    const { data } = importFixture(legacyBackup());
    const guest = Object.values(data.players).find((p) => p.name === "Chairman");
    assert.equal(guest.kind, "guest");
    assert.ok(!D.auctionPlayers(data).some((p) => p.id === guest.id));
  });

  it("preserves the auction prices", () => {
    const { data } = importFixture(legacyBackup());
    const sabbir = Object.values(data.players).find((p) => p.name === "Sabbir");
    assert.equal(sabbir.price, 17);
    assert.equal(sabbir.kind, "auction");
  });

  it("keeps normal id-based events working", () => {
    const { data } = importFixture(legacyBackup());
    const munna = Object.values(data.players).find((p) => p.name === "Munna");
    assert.equal(D.playerStats(data).find((r) => r.playerId === munna.id).goals, 2);
  });

  /**
   * The 2026 Golden Ball, Boot and Glove were not computed — the referee named
   * them, and the old console stored that decision as a player id in settings.
   * Those ids belong to the old site, so an import that copies them verbatim
   * produces an override pointing at nobody, which silently falls back to the
   * computed winner. Nobody notices until the wrong name is read out.
   */
  describe("medals that were awarded by hand", () => {
    const withPicks = () => {
      const backup = legacyBackup();
      backup.tournament.settings = {
        ...backup.tournament.settings,
        goldenBallPlayerId: "p01", // Sabbir, who has no points at all
        goldenBootPlayerId: "p02", // Jubair, a keeper with no goals
      };
      return backup;
    };

    it("translates the old player ids so the pick survives", () => {
      const { data } = importFixture(withPicks());
      const sabbir = Object.values(data.players).find((p) => p.name === "Sabbir");
      const jubair = Object.values(data.players).find((p) => p.name === "Jubair");

      const a = D.awards(data);
      assert.equal(a.goldenBall.playerId, sabbir.id);
      assert.equal(a.goldenBoot[0].playerId, jubair.id);
      assert.ok(a.goldenBall.picked, "and the card must say it was chosen, not computed");
      assert.ok(a.goldenBoot[0].picked);
    });

    it("does not leave the old site's ids in settings", () => {
      const { data } = importFixture(withPicks());
      assert.ok(
        !Object.values(D.getSettings(data)).includes("p01"),
        "a dangling id would look like an override and resolve to nobody",
      );
    });

    it("reports every hand-awarded medal by name", () => {
      const { report } = importFixture(withPicks());
      assert.deepEqual(
        report.medalPicks.map((m) => [m.label, m.who, m.kept]),
        [
          ["Golden Ball", "Sabbir", true],
          ["Golden Boot", "Jubair", true],
        ],
      );
    });

    it("warns loudly when the chosen player is not in the backup", () => {
      const backup = legacyBackup();
      backup.tournament.settings = { ...backup.tournament.settings, goldenGlovePlayerId: "p99" };

      const { report, data } = importFixture(backup);
      assert.ok(report.medalPicks.some((m) => m.label === "Golden Glove" && !m.kept));
      assert.ok(report.warnings.some((w) => /Golden Glove/.test(w) && /set it again/.test(w)));
      assert.ok(!D.awards(data).goldenGlove?.picked, "it must fall back, not point at nobody");
    });

    it("says so when a medal came out tied and nobody was named", () => {
      const backup = legacyBackup();
      // Two defenders on the same side with an identical record — which is
      // exactly how the 2026 Best Defender ended up: level, on one team, with
      // the card reading "tied on points" and no decision written down.
      backup.tournament.players.p30 = { id: "p30", name: "Anirban", pos: "DEF", price: 9, teamId: "t1" };
      backup.tournament.players.p31 = { id: "p31", name: "Shojeb", pos: "DEF", price: 9, teamId: "t1" };
      backup.tournament.matches.m1.events.e7 = { id: "e7", type: "clearance", teamId: "t1", playerId: "p30" };
      backup.tournament.matches.m1.events.e8 = { id: "e8", type: "clearance", teamId: "t1", playerId: "p31" };

      const { report } = importFixture(backup);
      const tie = report.warnings.find((w) => /Best Defender is tied/.test(w));
      assert.ok(tie, "a tie nobody resolved must be reported, not quietly settled");
      assert.match(tie, /Anirban/);
      assert.match(tie, /Shojeb/);
      assert.match(tie, /Settings/);
    });

    it("does not report a tie on a medal that was assigned", () => {
      const { report } = importFixture(withPicks());
      assert.ok(!report.warnings.some((w) => /Golden Ball is tied/.test(w)));
    });

    it("archives the declared winner, not the tally's", () => {
      const backup = withPicks();
      backup.tournament.matches.m2 = {
        id: "m2",
        no: 2,
        isFinal: true,
        homeScore: 2,
        awayScore: 0,
        status: "ft",
        events: {},
      };

      const { report } = importFixture(backup, { status: "completed" });
      const data = loadTournament(report.tournamentId);
      const medals = D.medalSummary(data);

      assert.equal(medals.goldenBall.playerName, "Sabbir");
      assert.ok(medals.goldenBall.picked);
      assert.equal(medals.goldenBoot.playerName, "Jubair");
    });
  });

  it("refuses a file that is not a tournament backup", () => {
    const file = path.join(workDir, "wrong.json");
    fs.writeFileSync(file, JSON.stringify({ _format: "something-else", tournament: {} }));
    assert.throws(() => importFirebaseBackup(file), /Unexpected backup format/);
  });

  it("refuses a backup with no squads", () => {
    const file = path.join(workDir, "empty.json");
    fs.writeFileSync(file, JSON.stringify({ tournament: { meta: {} } }));
    assert.throws(() => importFirebaseBackup(file), /no teams or players/);
  });

  it("writes a hall of fame entry when imported as completed", async () => {
    const backup = legacyBackup();
    // Give it a decided final so there is a champion to archive.
    backup.tournament.matches.m2 = {
      id: "m2",
      no: 2,
      isFinal: true,
      homeScore: 2,
      awayScore: 0,
      status: "ft",
      events: {},
    };

    const { report } = importFixture(backup, { status: "completed" });
    const { getArchiveRow } = await import("../../server/db/repo/archive.js");
    const row = getArchiveRow(report.tournamentId);

    assert.ok(row, "a completed import belongs in the hall of fame");
    assert.equal(row.champion, "LOSS MAKER");
    assert.equal(row.runnerUp, "LEGACY");
    assert.equal(row.finalScore, "2–0");
  });
});
