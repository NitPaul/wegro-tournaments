/**
 * Import a backup from the old Firebase site.
 *
 *   npm run import:firebase -- ../wegro-cl-backup-2026-08-01.json
 *
 * Take the file from the old admin console: Danger → Download backup. Use a
 * FRESH one — a backup taken before match day has every match still marked
 * "scheduled" and no goals in it, so it will import a tournament with no
 * results.
 *
 * The interesting part of this file is captains.
 *
 * In the old model a captain was two strings on a team row, not a player. So
 * when a captain scored, the console could not store a player id and stored
 * `scorerName: "KBD MD. Robiullah"` instead. The match log rendered it fine —
 * the renderers had a name fallback — but every statistics table keys off a
 * player id, so those goals were silently dropped. That is the bug behind
 * "captain data is not showing in player point stats".
 *
 * This importer gives every captain a real player record and then rewrites
 * those name strings into proper foreign keys. The goals have been in the
 * database the whole time; after this they are reachable.
 *
 * Anything it cannot resolve is reported by name at the end, never dropped.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { applySchema, closeDatabase, db, transaction } from "../db/index.js";
import { createTournament, loadTournament, patchSettings, updateTournament } from "../db/repo/tournaments.js";
import { createPlayer, createTeam } from "../db/repo/squads.js";
import { addEvent, createMatch, updateMatch } from "../db/repo/matches.js";
import { recomputeArchive } from "../db/repo/archive.js";
import { DEFAULT_SETTINGS, MEDALS, TEAM_MEDALS } from "../../shared/domain/constants.js";
import { awards } from "../../shared/domain/awards.js";

const norm = (s) => String(s ?? "").trim().toLowerCase();

/** The settings keys that hold a manually awarded medal winner. */
const MEDAL_PICK_KEYS = [...MEDALS, ...TEAM_MEDALS].map(([, , , settingKey]) => settingKey);

/**
 * Strip the medal overrides out of the incoming settings.
 *
 * They name ids from the old site, which mean nothing here until the players
 * and teams exist. Left in place they would look like valid overrides and
 * resolve to nobody — the medal would quietly revert to the computed winner
 * with no sign that a decision had been lost. They are rewritten at the end of
 * the import instead, once the id maps are built.
 */
function withoutMedalPicks(settings) {
  const out = { ...settings };
  for (const key of MEDAL_PICK_KEYS) delete out[key];
  return out;
}

/** Import from a file on disk — the command line path. */
export function importFirebaseBackup(file, options = {}) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") throw new Error(`No such file: ${file}`);
    throw new Error(`That file is not valid JSON: ${err.message}`);
  }
  return importFirebaseData(raw, options);
}

/** Import from an already-parsed backup — what the upload button in the console uses. */
export function importFirebaseData(raw, { name, season, status = "completed", startsOn } = {}) {
  if (raw._format && raw._format !== "wegro-champions-league") {
    throw new Error(`Unexpected backup format "${raw._format}".`);
  }
  const src = raw.tournament ?? raw;
  if (!src.teams || !src.players) {
    throw new Error("That file has no teams or players in it — is it a tournament backup?");
  }

  const report = {
    tournamentId: null,
    slug: null,
    counts: { teams: 0, captains: 0, auctionPlayers: 0, guests: 0, matches: 0, events: 0 },
    resolvedByName: [],
    medalPicks: [],
    unresolved: [],
    warnings: [],
  };

  const meta = src.meta ?? {};

  return transaction(() => {
    const tournament = createTournament({
      name: name ?? meta.name ?? "Imported tournament",
      season: season ?? meta.season ?? "",
      format: "league",
      startsOn: startsOn ?? isoDate(meta.kickoffISO) ?? null,
      meta: {
        venueName: meta.venueName ?? "",
        plusCode: meta.plusCode ?? "",
        mapUrl: meta.mapUrl ?? "",
        mapEmbedUrl: meta.mapEmbedUrl ?? "",
        dateLabel: meta.dateLabel ?? "",
        timeLabel: meta.timeLabel ?? "",
        kickoffISO: meta.kickoffISO ?? "",
        auctionLabel: meta.auctionLabel ?? "",
      },
      settings: { ...DEFAULT_SETTINGS, ...withoutMedalPicks(src.settings ?? {}) },
      userId: null,
    });

    report.tournamentId = tournament.id;
    report.slug = tournament.slug;

    /* ------------------------------------------------------------- teams */

    const teamIdMap = new Map(); // old id -> new id
    /** New team id -> its captain's new player id, for resolving name strings. */
    const captainOfTeam = new Map();

    for (const [oldId, t] of Object.entries(src.teams)) {
      const newId = createTeam(tournament.id, {
        name: t.name ?? oldId,
        slot: t.slot ?? "",
        jerseyColor: t.jerseyColor ?? null,
        jerseyLabel: t.jerseyLabel ?? "",
        jerseyCost: Number(t.jerseyCost ?? 0),
        squadSize: t.squadSize ?? null,
      });
      teamIdMap.set(oldId, newId);
      report.counts.teams++;

      // THE FIX: the captain becomes a real player.
      const captainName = String(t.captainName ?? "").trim();
      if (captainName) {
        const capId = createPlayer(tournament.id, {
          name: captainName,
          // The old model never recorded a captain's position, because it never
          // had anywhere to put one. Midfield is the safe default — it earns no
          // clean-sheet points, so a guess cannot inflate anybody's total. An
          // admin can correct it, and the ledger will follow.
          pos: "MID",
          teamId: newId,
          price: 0,
          kind: "captain",
          photo: t.captainPhoto ?? null,
        });
        captainOfTeam.set(newId, capId);
        report.counts.captains++;
      } else {
        report.warnings.push(`Team "${t.name}" had no captain name recorded.`);
      }
    }

    /* ----------------------------------------------------------- players */

    const playerIdMap = new Map();
    /** Lowercased name -> new player id, for resolving the old name strings. */
    const byName = new Map();

    for (const [oldId, p] of Object.entries(src.players)) {
      const kind = p.special ? "guest" : "auction";
      const newId = createPlayer(tournament.id, {
        name: p.name ?? oldId,
        pos: p.pos ?? "MID",
        teamId: p.teamId ? (teamIdMap.get(p.teamId) ?? null) : null,
        price: p.price ?? null,
        kind,
      });
      playerIdMap.set(oldId, newId);
      byName.set(norm(p.name), newId);
      report.counts[kind === "guest" ? "guests" : "auctionPlayers"]++;
    }

    // Captains go into the name index too, and win ties: a captain's name is
    // exactly what the old console stored when a captain scored.
    for (const [teamId, capId] of captainOfTeam) {
      const row = db.prepare("SELECT name FROM players WHERE id = ?").get(capId);
      byName.set(norm(row.name), capId);
    }

    /* ----------------------------------------------------------- matches */

    const matchIdMap = new Map();
    const orderedMatches = Object.entries(src.matches ?? {}).sort(
      (a, b) => Number(a[1].no ?? 0) - Number(b[1].no ?? 0),
    );

    for (const [oldId, m] of orderedMatches) {
      const newId = createMatch(tournament.id, {
        no: Number(m.no ?? matchIdMap.size + 1),
        homeId: m.homeId ? (teamIdMap.get(m.homeId) ?? null) : null,
        awayId: m.awayId ? (teamIdMap.get(m.awayId) ?? null) : null,
        isFinal: Boolean(m.isFinal),
        kickoff: m.time ?? null,
      });
      matchIdMap.set(oldId, newId);
      report.counts.matches++;

      updateMatch(newId, {
        homeScore: m.homeScore ?? null,
        awayScore: m.awayScore ?? null,
        status: m.status ?? "scheduled",
        clock: m.clock ?? { period: "pre", running: false, startedAt: null, elapsed: 0, addedSeconds: 0 },
      });

      /* ---------------------------------------------------------- events */

      for (const [evOldId, ev] of Object.entries(m.events ?? {})) {
        const teamId = ev.teamId ? (teamIdMap.get(ev.teamId) ?? null) : null;

        // The old model split the credited player across three fields
        // depending on the event type. Unify them here.
        const idField = ev.scorerId ?? ev.playerId ?? null;
        const nameField = ev.scorerName ?? ev.playerName ?? null;

        const player = resolve(idField, nameField, teamId, `${m.no ?? oldId}/${evOldId}`);
        const assist = resolve(ev.assistId ?? null, ev.assistName ?? null, teamId, `${m.no ?? oldId}/${evOldId} assist`);

        addEvent(newId, {
          type: ev.type ?? "goal",
          teamId,
          playerId: player,
          assistId: assist,
          zone: ev.zone ?? null,
          penalty: Boolean(ev.penalty),
          critical: Boolean(ev.critical),
          ownGoal: Boolean(ev.ownGoal),
          clockLabel: ev.clockLabel ?? null,
        });
        report.counts.events++;
      }
    }

    /**
     * Turn an old id-or-name into a real player id.
     *
     * A name is what a captain's event carries, so this is where those goals
     * come back. If a name matches nothing at all the player is created as a
     * guest rather than thrown away — a goal with no scorer is worse than a
     * goal credited to a player record somebody can rename afterwards.
     */
    function resolve(oldId, name, teamId, where) {
      if (oldId && playerIdMap.has(oldId)) return playerIdMap.get(oldId);

      const wanted = norm(name);
      if (!wanted) return null;

      // Prefer this team's captain, since that is what the old code wrote.
      const capId = teamId ? captainOfTeam.get(teamId) : null;
      if (capId) {
        const cap = db.prepare("SELECT name FROM players WHERE id = ?").get(capId);
        if (norm(cap.name) === wanted) {
          report.resolvedByName.push({ name, as: "captain", where });
          return capId;
        }
      }

      const known = byName.get(wanted);
      if (known) {
        report.resolvedByName.push({ name, as: "player", where });
        return known;
      }

      if (wanted === "captain" || wanted === "player not recorded") {
        // The old console's placeholder for "we did not catch who it was".
        report.unresolved.push({ name, where, action: "left unattributed" });
        return null;
      }

      const created = createPlayer(tournament.id, {
        name: String(name).trim(),
        pos: "MID",
        teamId,
        price: 0,
        kind: "guest",
      });
      byName.set(wanted, created);
      report.counts.guests++;
      report.unresolved.push({ name, where, action: "added as a guest player" });
      return created;
    }

    /* --------------------------------------------- manually awarded medals */

    // On the old site a medal could be assigned by hand — that is what
    // "organisers' pick" on the public card meant, and it is how the 2026
    // Golden Ball, Golden Boot and Golden Glove were actually decided. The
    // decision was stored as a player id in settings, so it has to be
    // translated into this database's ids to survive the move.
    //
    // Reported either way. A pick that silently turned back into a computed
    // winner is the kind of change nobody notices until the wrong name is read
    // out at the presentation.
    const picks = {};

    const carryPick = (label, key, map, kind) => {
      const oldId = src.settings?.[key];
      if (!oldId) return;
      const newId = map.get(oldId) ?? null;
      if (newId) {
        picks[key] = newId;
        report.medalPicks.push({ label, who: nameOf(kind, newId), kept: true });
      } else {
        report.medalPicks.push({ label, who: String(oldId), kept: false });
        report.warnings.push(
          `${label} was awarded by hand on the old site to ${kind} "${oldId}", which is not in this backup. ` +
            `The medal has fallen back to the computed winner — set it again under Settings → Medals.`,
        );
      }
    };

    for (const [, label, , key] of MEDALS) carryPick(label, key, playerIdMap, "player");
    for (const [, label, , key] of TEAM_MEDALS) carryPick(label, key, teamIdMap, "team");

    // Applied before the archive is computed, so the hall of fame records the
    // declared winner rather than the tally's opinion of one.
    if (Object.keys(picks).length) patchSettings(tournament.id, picks);

    function nameOf(kind, id) {
      const table = kind === "team" ? "teams" : "players";
      return db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id)?.name ?? "";
    }

    /* ---------------------------------------------------------- finish up */

    updateTournament(tournament.id, {
      status,
      completedAt: status === "completed" ? Date.now() : null,
    });
    if (status === "completed") recomputeArchive(tournament.id);

    // A medal that came out tied and was never assigned is the one case where
    // the import is technically correct and still probably wrong: the old site
    // printed "tied on points" on the card, but somebody decided it on the day
    // and the decision was never written down. Say so, rather than leaving a
    // coin-flip to be discovered on the hall of fame page.
    const finished = loadTournament(tournament.id);
    const decided = awards(finished);

    // Who each medal was actually ranked against — the same pools awards() uses.
    const pool = {
      goldenBall: () => decided.all,
      goldenGlove: () => decided.all.filter((r) => r.player.pos === "GK" && r.player.kind !== "guest"),
      bestDefender: () => decided.all.filter((r) => r.player.pos === "DEF" && r.player.kind !== "guest"),
    };

    for (const [key, label] of MEDALS) {
      const row = Array.isArray(decided[key]) ? decided[key][0] : decided[key];
      if (!row || row.picked) continue;
      const shared = Array.isArray(decided[key])
        ? decided[key].slice(1).map((r) => r.player?.name)
        : pool[key]?.()
            .filter((r) => r.points === row.points && r.playerId !== row.playerId)
            .map((r) => r.player?.name) ?? [];
      if (!shared.length) continue;
      report.warnings.push(
        `${label} is tied between ${[row.player?.name, ...shared].join(" and ")}. ` +
          `It is showing the first of them. If a winner was declared on the day, name them under Settings → Medals.`,
      );
    }

    return report;
  });
}

function isoDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/* --------------------------------------------------------------------- cli */

if (process.argv[1]?.endsWith("firebase-backup.js")) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const opt = (flag) => {
    const found = args.find((a) => a.startsWith(`--${flag}=`));
    return found ? found.slice(flag.length + 3) : undefined;
  };

  if (!file) {
    console.error("\nUsage: npm run import:firebase -- <backup.json> [--name=...] [--season=...] [--status=completed|active]\n");
    process.exit(1);
  }

  try {
    applySchema();
    const report = importFirebaseBackup(path.resolve(file), {
      name: opt("name"),
      season: opt("season"),
      status: opt("status") ?? "completed",
      startsOn: opt("startsOn"),
    });

    console.log(`\nImported into tournament ${report.tournamentId} (/${report.slug})\n`);
    for (const [what, n] of Object.entries(report.counts)) {
      console.log(`  ${what.padEnd(16)} ${n}`);
    }

    if (report.resolvedByName.length) {
      console.log(`\n  Resolved ${report.resolvedByName.length} event(s) that stored a name instead of an id:`);
      const grouped = new Map();
      for (const r of report.resolvedByName) {
        grouped.set(`${r.name} (${r.as})`, (grouped.get(`${r.name} (${r.as})`) ?? 0) + 1);
      }
      for (const [who, n] of grouped) console.log(`    ${who} — ${n} event(s)`);
      console.log("\n  These are the ones that were missing from the statistics tables before.");
    }

    if (report.medalPicks.length) {
      console.log("\n  Medals that were awarded by hand on the old site:");
      for (const m of report.medalPicks) {
        console.log(`    ${m.label.padEnd(14)} ${m.who}${m.kept ? "" : "  — NOT CARRIED OVER, see warnings"}`);
      }
    }

    if (report.unresolved.length) {
      console.log(`\n  ${report.unresolved.length} could not be matched to an existing player:`);
      for (const u of report.unresolved) console.log(`    "${u.name}" at ${u.where} — ${u.action}`);
      console.log("\n  Check these in the admin console. Nothing was discarded.");
    }

    if (report.warnings.length) {
      console.log("\n  Warnings:");
      for (const w of report.warnings) console.log(`    ${w}`);
    }

    const data = loadTournament(report.tournamentId);
    console.log(`\n  Verify against the old site: ${Object.keys(data.teams).length} teams, ` +
      `${Object.keys(data.players).length} players, ${Object.keys(data.matches).length} matches.\n`);
  } catch (err) {
    console.error(`\nImport failed: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    closeDatabase();
  }
}
