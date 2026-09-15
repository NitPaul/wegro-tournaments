/**
 * The super admin's Tournaments screen: create one, and watch all of them.
 *
 * Every tournament is listed by its permanent code. Its own admin may rename it
 * at any time, so the row shows the current name, the names it used to have,
 * who runs it, and when anyone last did anything — enough to notice a
 * tournament that has gone quiet, or one that is busier than expected.
 */

import * as D from "/shared/domain/index.js";
import { $, setHTML, toast } from "../ui.js";
import { tournaments } from "../api.js";

const e = D.escapeHtml;

const STATUS = {
  draft: ["Hidden", ""],
  active: ["Published", "pill--mint"],
  completed: ["Finished", "pill--gold"],
};

/** Plain-English labels for the audit log. Anything unlisted shows its raw name. */
const ACTION = {
  "tournament.create": "created the tournament",
  "tournament.update": "changed tournament details",
  "tournament.meta": "changed venue or dates",
  "tournament.settings": "changed settings",
  "team.create": "added a team",
  "team.update": "edited a team",
  "team.delete": "removed a team",
  "player.create": "added a player",
  "player.update": "edited a player",
  "player.delete": "removed a player",
  "auction.sell": "sold a player",
  "auction.unsell": "returned a player to the pool",
  "auction.guest": "placed a guest",
  "auction.reset": "reset the auction",
  "match.create": "added a match",
  "match.generate": "generated fixtures",
  "match.update": "updated a match",
  "match.clear": "cleared a match",
  "match.delete": "removed a match",
  "event.add": "logged a match event",
  "event.update": "edited a match event",
  "event.delete": "removed a match event",
  "scores.clear_all": "cleared every score",
  "staff.assign": "assigned staff",
  "staff.remove": "removed staff",
  "user.create": "created an account",
  "archive.recompute": "recomputed the Hall of Fame entry",
  "export.tournament": "downloaded a backup",
  "import.firebase": "imported data",
};

export function relativeTime(ms) {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

let rows = [];

/**
 * @param {object}   hooks
 * @param {(tid: string) => void} hooks.open      open a tournament in the console
 * @param {() => Promise<void>}   hooks.refresh   reload the signed-in identity after a change
 */
export function wireOverview({ open, refresh }) {
  const panel = $("#panel-tournaments");

  $("#overviewSearch").addEventListener("input", paint);

  panel.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;

    if (btn.id === "createTournament") {
      const name = $("#newTournamentName").value.trim();
      if (!name) return toast("Give the tournament a name. Everything else can wait.", "err");
      try {
        const { tournament } = await tournaments.create({
          name,
          season: $("#newTournamentSeason").value.trim(),
          format: $("#newTournamentFormat").value,
          startsOn: $("#newTournamentDate").value || null,
        });
        $("#newTournamentName").value = "";
        $("#newTournamentSeason").value = "";
        $("#newTournamentDate").value = "";
        toast(`${tournament.name} created — code ${tournament.code}.`);
        await refresh();
        await renderOverview();
      } catch (err) {
        toast(err.message, "err");
      }
      return;
    }

    if (btn.dataset.open) return open(btn.dataset.open);

    if (btn.dataset.activity) {
      const box = $(`#activity-${CSS.escape(btn.dataset.activity)}`);
      if (!box.hidden) {
        box.hidden = true;
        btn.setAttribute("aria-expanded", "false");
        return;
      }
      box.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      setHTML(box, `<p class="faint">Loading…</p>`);
      try {
        const { activity } = await tournaments.activity(btn.dataset.activity, 40);
        setHTML(
          box,
          activity.length
            ? `<ol class="activity">${activity
                .map(
                  (a) => `<li>
                    <span class="activity__when">${e(relativeTime(a.at))}</span>
                    <b>${e(a.username || a.userEmail || "system")}</b>
                    <span>${e(ACTION[a.action] ?? a.action)}${a.detail?.renamedFrom ? ` (was “${e(a.detail.renamedFrom)}”)` : ""}</span>
                  </li>`,
                )
                .join("")}</ol>`
            : `<p class="faint">Nothing has happened here yet.</p>`,
        );
      } catch (err) {
        setHTML(box, `<p class="faint err">${e(err.message)}</p>`);
      }
    }
  });
}

export async function renderOverview() {
  try {
    ({ tournaments: rows } = await tournaments.overview());
  } catch (err) {
    setHTML($("#overviewList"), `<p class="faint err">${e(err.message)}</p>`);
    return;
  }
  paint();
}

function paint() {
  const q = $("#overviewSearch").value.trim().toLowerCase();
  const shown = rows.filter(
    (t) => !q || t.code.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.previousNames.some((n) => n.toLowerCase().includes(q)),
  );

  setHTML(
    $("#overviewList"),
    shown
      .map((t) => {
        const [label, tone] = STATUS[t.status] ?? [t.status, ""];
        const staff = t.staff.length
          ? t.staff
              .map((s) => `<span class="staff-chip${s.status === "disabled" ? " is-off" : ""}">${e(s.role === "admin" ? "Admin" : "Referee")}: <b>${e(s.username)}</b></span>`)
              .join("")
          : `<span class="faint">No admin or referee yet — create one under Accounts.</span>`;
        return `<article class="ov">
          <div class="ov__head">
            <span class="code-chip">${e(t.code)}</span>
            <span class="pill ${tone}">${e(label)}</span>
            <span class="faint ov__when">Last activity ${e(relativeTime(t.lastActivityAt))}</span>
          </div>
          <h3 class="ov__name">${e(t.name)}${t.season ? ` <span class="faint">${e(t.season)}</span>` : ""}</h3>
          ${t.previousNames.length ? `<p class="faint ov__was">Previously ${t.previousNames.map((n) => `“${e(n)}”`).join(", ")}</p>` : ""}
          <p class="faint">${e(t.format === "friendly" ? "Friendly" : "League")} · ${t.teamCount} teams · ${t.playerCount} players · ${t.matchCount} matches${t.startsOn ? ` · starts ${e(t.startsOn)}` : " · no date yet"}</p>
          <div class="ov__staff">${staff}</div>
          <div class="card-buttons">
            <button class="btn btn--sm btn--primary" data-open="${e(t.id)}" type="button">Open</button>
            <button class="btn btn--sm btn--ghost" data-activity="${e(t.id)}" aria-expanded="false" type="button">Activity</button>
          </div>
          <div class="ov__activity" id="activity-${e(t.id)}" hidden></div>
        </article>`;
      })
      .join("") || `<p class="faint">${rows.length ? "No tournament matches that." : "No tournaments yet. Create the first one above."}</p>`,
  );
}
