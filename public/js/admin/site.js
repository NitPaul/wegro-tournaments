/**
 * The Site screen — the whole platform, for the person who owns it.
 *
 * Everything here is deliberately concrete: how big the database is, how many
 * photos are on disk, which copies already exist and when they were taken.
 * "Back up regularly" is advice nobody acts on; a line saying the last copy was
 * made eleven days ago is a prompt.
 */

import * as D from "/shared/domain/index.js";
import { $, setHTML } from "../ui.js";
import { site } from "../api.js";

const e = D.escapeHtml;

let toast = () => {};
let loaded = false;

/** Bytes as a person reads them. */
function size(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** "11 days ago", for a backup's age. */
function ago(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${D.plural(mins, "minute")} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${D.plural(hours, "hour")} ago`;
  return `${D.plural(Math.round(hours / 24), "day")} ago`;
}

export function wireSite({ toast: toastFn }) {
  toast = toastFn;

  // A plain navigation, so the browser saves the file itself and the download
  // keeps the name the server gave it.
  const downloads = {
    siteBackupZip: "zip",
    siteBackupDb: "sqlite",
    siteBackupJson: "json",
  };

  for (const [id, kind] of Object.entries(downloads)) {
    $(`#${id}`).addEventListener("click", () => {
      $("#siteBackupNote").textContent =
        kind === "zip"
          ? "Preparing the archive. A site with a lot of photos takes a few seconds."
          : "Preparing the download…";
      location.href = site.downloadUrl(kind);
    });
  }

  $("#siteBackupServer").addEventListener("click", async () => {
    const button = $("#siteBackupServer");
    button.disabled = true;
    try {
      const { backup, backups } = await site.backupOnServer();
      $("#siteBackupNote").textContent = `Written to ${backup.dir} as ${backup.database}, with ${D.plural(backup.photos, "photo")}.`;
      paintBackups(backups);
      toast("Copy made on the server.");
    } catch (err) {
      toast(err.message, "err");
    } finally {
      button.disabled = false;
    }
  });
}

/** Load the overview the first time the tab is opened, and on demand after. */
export async function renderSite({ force = false } = {}) {
  if (loaded && !force) return;
  loaded = true;

  let data;
  try {
    data = await site.overview();
  } catch (err) {
    loaded = false;
    setHTML($("#siteCounts"), `<p class="faint err">${e(err.message)}</p>`);
    return;
  }

  const { counts, database, photos, config, backups, warnings } = data;

  const stat = (label, value, note = "") =>
    `<div><dt>${e(label)}</dt><dd>${e(String(value))}</dd>${note ? `<dd class="faint">${e(note)}</dd>` : ""}</div>`;

  setHTML(
    $("#siteCounts"),
    [
      stat("Tournaments", counts.tournaments),
      stat("People on the roster", counts.people),
      stat("Players", counts.players, "across every tournament"),
      stat("Matches", counts.matches),
      stat("Logged events", counts.events),
      stat("Accounts", counts.users),
      stat("Photos", photos.count, size(photos.bytes)),
      stat("Database", size(database.bytes), `schema v${database.version}`),
    ].join(""),
  );

  setHTML(
    $("#siteWarnings"),
    warnings.length
      ? warnings.map((w) => `<p class="banner banner--warn">${e(w.text)}</p>`).join("")
      : `<p class="faint">Nothing looks wrong with how this server is configured.</p>`,
  );

  // A definition list lays itself out in two columns; wrapping each pair in a
  // div would make every pair one cell and squeeze the long paths to a sliver.
  const row = (label, value) => `<dt>${e(label)}</dt><dd><code>${e(String(value))}</code></dd>`;
  setHTML(
    $("#siteConfig"),
    [
      row("Address people use", config.publicUrl),
      row("Data folder", config.dataDir),
      row("Photos", photos.dir),
      row("Backups", config.backupDir),
      row("Mode", config.isProduction ? "production" : "development"),
      row("Sign-in lasts", `${D.plural(config.sessionDays, "day")}`),
      row("Node", config.node),
      row("Running for", `${D.plural(Math.max(1, Math.round(config.uptimeSeconds / 60)), "minute")}`),
    ].join(""),
  );

  $("#siteBackupDir").textContent = config.backupDir;
  paintBackups(backups);
}

function paintBackups(backups) {
  setHTML(
    $("#siteBackups"),
    backups?.length
      ? `<div class="table-scroll"><table class="tbl">
           <thead><tr><th>File</th><th>Size</th><th>Taken</th></tr></thead>
           <tbody>${backups
             .map(
               (b) => `<tr><td><code>${e(b.name)}</code></td><td>${e(size(b.bytes))}</td><td>${e(ago(b.at))}</td></tr>`,
             )
             .join("")}</tbody>
         </table></div>`
      : `<p class="faint">None yet. Press “Also keep one on the server”, or run <code>npm run backup</code>.</p>`,
  );
}
