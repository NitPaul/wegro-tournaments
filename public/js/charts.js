/* ==========================================================================
   Charts.

   Deliberately built from HTML + CSS rather than SVG or a charting library:
   text stays crisp at any size, it reflows on a phone for free, hover and
   keyboard focus are native, and it adds zero kilobytes of dependency.

   Colour method (see the palette validated against this site's card surface
   #0B3B36, all four checks passing at >= 3:1):
     - Nominal categories (teams, players, positions) have no natural order, so
       every bar in a single-series chart wears ONE hue. Colouring bars by their
       own value would just re-encode what bar length already says.
     - Goal difference is polarity, not magnitude, so it gets the diverging pair:
       blue above the line, red below, with a neutral zero baseline. Green/red
       is the classic colour-blind trap and is avoided on purpose.
     - Goals by pitch zone is magnitude over a map, so it is sequential: ONE hue
       (mint) stepped light to dark, never a rainbow.
     - The two stacked charts (saves vs clearances, chances vs shots) are the
       only two-series ones here, so they are the only ones with a legend — and
       each segment is labelled as well, so identity is never carried by colour
       alone. They share one blue/gold pair rather than spending four hues on
       four series: each chart is read on its own, against its own legend.

   On the palette: these steps sit above the generic dark-mode lightness band,
   deliberately. The card surface (#0B3B36) is far darker than a typical dark
   theme, so in-band steps drop under 3:1 against it — the band and the contrast
   floor pull opposite ways here, and contrast wins. What actually decides
   whether two series can be told apart is separation, and the blue/gold pair
   measures ΔE 31.6 under protanopia and 35.4 in normal vision, comfortably
   above the ≥8 target.

   Every value is directly labelled, so no number is trapped behind a tooltip.
   ========================================================================== */

import * as D from "./data.js";

const e = D.escapeHtml;

/* ------------------------------------------------------------------ tooltip */

let tipEl = null;
let tipAnchor = null;

function ensureTip() {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "chart-tip";
    tipEl.setAttribute("role", "tooltip");
    tipEl.hidden = true;
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function showTip(target) {
  const text = target.dataset.tip;
  if (!text) return;
  tipAnchor = target;
  const tip = ensureTip();
  tip.textContent = text;
  tip.hidden = false;
  const r = target.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8));
  let top = r.top - t.height - 8;
  if (top < 8) top = r.bottom + 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${top + window.scrollY}px`;
}

const hideTip = () => {
  if (tipEl) tipEl.hidden = true;
  tipAnchor = null;
};

/**
 * Bind once. Tooltips enhance the visible labels — they never gate a value.
 *
 * Pointer and keyboard are tracked as separate, independent sources. Mixing
 * them makes the tooltip flicker: tabbing to a row scrolls the page, which
 * fires pointer events for wherever the (stationary) mouse now happens to sit,
 * and those would otherwise dismiss the tooltip the keyboard just opened.
 */
export function initCharts() {
  let mode = null; // "pointer" | "key" | null

  const open = (target, source) => {
    mode = source;
    showTip(target);
  };
  const close = (source) => {
    if (mode !== source) return; // only the source that opened it may close it
    mode = null;
    hideTip();
  };

  document.addEventListener("pointerover", (ev) => {
    const t = ev.target.closest("[data-tip]");
    if (t) open(t, "pointer");
    else close("pointer");
  });
  document.addEventListener("pointerout", (ev) => {
    if (ev.target.closest("[data-tip]")) close("pointer");
  });

  document.addEventListener("focusin", (ev) => {
    const t = ev.target.closest("[data-tip]");
    if (t) open(t, "key");
    else close("key");
  });
  document.addEventListener("focusout", () => close("key"));

  // Keep a keyboard tooltip pinned to its row while the browser scrolls it into
  // view; a pointer tooltip is stale the moment the page moves under the cursor.
  window.addEventListener(
    "scroll",
    () => {
      if (!tipAnchor || tipEl?.hidden) return;
      if (mode === "key") showTip(tipAnchor);
      else close("pointer");
    },
    { passive: true }
  );
}

/* ------------------------------------------------------------------ helpers */

const empty = (msg) => `<p class="chart-empty">${e(msg)}</p>`;

/**
 * Charts animate in only the first time a container is filled. Re-animating on
 * every live score update would make the page twitch all evening.
 */
function wrap(id, inner, seen) {
  const fresh = !seen.has(id);
  seen.add(id);
  return `<div class="chart${fresh ? " chart--enter" : ""}">${inner}</div>`;
}

const painted = new Set();
export const resetChartAnimations = () => painted.clear();

/* -------------------------------------------------------------- simple bars */

/**
 * Single-series horizontal bars. One hue for every bar (nominal categories),
 * value direct-labelled at the tip.
 * rows: [{ key, label, sub, value, tip }]
 */
function barChart({ rows, max, tone = "mint", unit = "" }) {
  const top = Math.max(max ?? 0, ...rows.map((r) => r.value), 1);
  return `<div class="bars bars--${e(tone)}">${rows
    .map(
      (r) => `<div class="bar-row" tabindex="0" data-tip="${e(r.tip || `${r.label}: ${r.value}${unit}`)}">
        <span class="bar-label">${e(r.label)}${
        r.sub ? `<span class="bar-sub">${e(r.sub)}</span>` : ""
      }</span>
        <span class="bar-track">
          <span class="bar-fill${r.value === 0 ? " is-zero" : ""}" style="--pct:${
        (r.value / top) * 100
      }%"></span>
        </span>
        <span class="bar-value num">${r.value}${e(unit)}</span>
      </div>`
    )
    .join("")}</div>`;
}

/**
 * Diverging bars around a zero baseline — the form for polarity.
 * rows: [{ label, value, tip }]
 */
function divergingChart({ rows, unit = "" }) {
  const span = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return `<div class="diverge">${rows
    .map((r) => {
      const pct = (Math.abs(r.value) / span) * 50;
      const pos = r.value >= 0;
      return `<div class="bar-row" tabindex="0" data-tip="${e(r.tip || `${r.label}: ${r.value > 0 ? "+" : ""}${r.value}${unit}`)}">
        <span class="bar-label">${e(r.label)}</span>
        <span class="diverge-track">
          <span class="diverge-zero" aria-hidden="true"></span>
          <span class="diverge-fill ${pos ? "is-pos" : "is-neg"}" style="--pct:${pct}%"></span>
        </span>
        <span class="bar-value num ${pos ? "is-pos" : "is-neg"}">${r.value > 0 ? "+" : ""}${r.value}</span>
      </div>`;
    })
    .join("")}
    <div class="diverge-legend">
      <span><i class="key key--pos"></i> Positive</span>
      <span><i class="key key--neg"></i> Negative</span>
    </div>
  </div>`;
}

/**
 * Goals by pitch zone — magnitude over a map, so a sequential single-hue scale.
 * Laid out exactly like the referee's picker: goal at the top, the box on the
 * row beneath it, long range below that. Every cell carries its own count, so
 * the colour is a summary and never the only way to read a value.
 */
function zoneChart({ counts, total, unknown }) {
  const max = Math.max(1, ...Object.values(counts));
  const cell = (k) => {
    const v = counts[k] || 0;
    // Steps of one hue. 0 stays at the surface so "none" never looks like "some".
    // The top step stops well short of opaque: the label sits ON the fill, and
    // light text needs the dark card to keep showing through behind it.
    const pct = v / max;
    const alpha = v === 0 ? 0 : 0.14 + pct * 0.36;
    const share = total ? Math.round((v / total) * 100) : 0;
    return `<div class="zone-cell-c" tabindex="0"
      data-tip="${e(D.ZONE_LABEL[k])} — ${v} goal${v === 1 ? "" : "s"}${
      total ? ` (${share}% of ${total})` : ""
    }"
      style="--fill:rgba(63,217,164,${alpha.toFixed(3)})">
      <b class="num">${v}</b><span>${e(D.ZONE_LABEL[k])}</span>
    </div>`;
  };

  return `<div class="zone-chart">
    <div class="zone-chart-goal">▲ GOAL</div>
    <div class="zone-chart-grid">
      ${cell("lb")}${cell("ib")}${cell("rb")}
      ${cell("lw")}${cell("lr")}${cell("rw")}
    </div>
    ${cell("pk")}
    ${
      unknown
        ? `<p class="chart-note faint">${unknown} goal${
            unknown === 1 ? "" : "s"
          } logged without a location.</p>`
        : ""
    }
  </div>`;
}

/**
 * Two series stacked into one bar — a player's workload split into its parts.
 * A legend is mandatory at two series, and each segment is labelled too. The 2px
 * gap between segments is a surface-coloured spacer, not a border, so the split
 * reads even where the two hues meet.
 *
 * `a` and `b` name the series: `{ label, one, many }`. Both stacked charts on the
 * page reuse the same validated blue/gold pair rather than inventing a third and
 * fourth hue — each carries its own legend and its own labelled segments, and the
 * chart titles say which pair of things is being split, so nothing is riding on
 * colour memory across two charts.
 */
function stackChart({ rows, a, b }) {
  const top = Math.max(1, ...rows.map((r) => r.a + r.b));
  const count = (v, s) => `${v} ${v === 1 ? s.one : s.many}`;
  return `<div class="stack">
    <div class="chart-legend">
      <span><i class="key key--saves"></i> ${e(a.label)}</span>
      <span><i class="key key--clears"></i> ${e(b.label)}</span>
    </div>
    ${rows
      .map((r) => {
        const seg = (v, cls) =>
          v
            ? `<span class="stack-seg ${cls}" style="--pct:${(v / top) * 100}%">${
                v / top > 0.12 ? `<b>${v}</b>` : ""
              }</span>`
            : "";
        return `<div class="bar-row" tabindex="0" data-tip="${e(
          `${r.label} — ${count(r.a, a)}, ${count(r.b, b)}`
        )}">
        <span class="bar-label">${e(r.label)}<span class="bar-sub">${e(r.sub)}</span></span>
        <span class="bar-track stack-track">${seg(r.a, "is-a")}${seg(r.b, "is-b")}</span>
        <span class="bar-value num">${r.a + r.b}</span>
      </div>`;
      })
      .join("")}
  </div>`;
}

/** A ratio against a fixed limit — a meter, not a chart. */
/** `flag` is an optional red badge appended to the sub-line (still escaped). */
function meter({ label, sub, flag, used, limit, tip }) {
  const pct = Math.max(0, Math.min(100, (used / limit) * 100));
  const over = used > limit;
  return `<div class="meter" tabindex="0" data-tip="${e(tip)}">
    <div class="meter-head"><b>${e(label)}</b><span class="num">${used} / ${limit}</span></div>
    <div class="meter-track"><i class="${over ? "is-over" : ""}" style="--pct:${pct}%"></i></div>
    <div class="meter-sub">${e(sub)}${
      flag ? ` <span class="flag-extra">${e(flag)}</span>` : ""
    }</div>
  </div>`;
}

/* -------------------------------------------------------------- the charts */

export function renderCharts(data) {
  const table = D.standings(data);
  const anyPlayed = D.matchesList(data).some(D.isPlayed);

  /* 1 — Points. Magnitude across nominal categories: one hue for every bar. */
  setChart(
    "chartPoints",
    anyPlayed
      ? barChart({
          tone: "mint",
          unit: "",
          rows: table.map((r) => ({
            key: r.teamId,
            label: r.team.name,
            sub: `${r.won}W ${r.drawn}D ${r.lost}L`,
            value: r.points,
            tip: `${r.team.name} — ${r.points} point${r.points === 1 ? "" : "s"} from ${r.played} match${
              r.played === 1 ? "" : "es"
            } (${r.won}W ${r.drawn}D ${r.lost}L)`,
          })),
        })
      : empty("Points appear here as results come in.")
  );

  /* 2 — Goal difference. Polarity, so the diverging pair with a zero baseline. */
  setChart(
    "chartGD",
    anyPlayed
      ? divergingChart({
          rows: table.map((r) => ({
            label: r.team.name,
            value: r.goalDiff,
            tip: `${r.team.name} — scored ${r.goalsFor}, conceded ${r.goalsAgainst}, difference ${
              r.goalDiff > 0 ? "+" : ""
            }${r.goalDiff}`,
          })),
        })
      : empty("Goal difference decides level teams (Rule 7).")
  );

  /* 3 — Top scorers. Single series, so no legend: the title names it. */
  const scorers = D.topScorers(data).slice(0, 8);
  setChart(
    "chartScorers",
    scorers.length
      ? barChart({
          tone: "gold",
          rows: scorers.map((r) => ({
            key: r.playerId,
            label: r.player.name,
            sub: r.team?.name || "",
            value: r.value,
            tip: `${r.player.name} (${r.team?.name || "unsold"}) — ${r.value} goal${
              r.value === 1 ? "" : "s"
            }`,
          })),
        })
      : empty("No goals logged yet.")
  );

  /* 4 — Where the goals came from. */
  const byPos = D.goalsByPosition(data);
  const totalPos = byPos.reduce((n, r) => n + r.value, 0);
  setChart(
    "chartPositions",
    totalPos
      ? barChart({
          tone: "blue",
          rows: byPos.map((r) => ({
            key: r.pos,
            label: r.label,
            value: r.value,
            tip: `${r.label} — ${r.value} of ${totalPos} goals (${Math.round(
              (r.value / totalPos) * 100
            )}%)`,
          })),
        })
      : empty("Goals are grouped by the scorer's position once they're logged.")
  );

  /* 5 — Where goals are scored from. Sequential: one hue over a pitch map. */
  const zones = D.goalsByZone(data);
  setChart(
    "chartZones",
    zones.total || zones.unknown
      ? zoneChart(zones)
      : empty("The referee records where every goal was struck from.")
  );

  /* 6 — Defensive workload. Two series, so a legend and labelled segments. */
  const stats = D.playerStats(data);
  const def = stats
    .filter((r) => r.saves || r.clearances)
    .sort((a, b) => b.saves + b.clearances - (a.saves + a.clearances))
    .slice(0, 8);
  setChart(
    "chartDefensive",
    def.length
      ? stackChart({
          a: { label: "Saves", one: "save", many: "saves" },
          b: { label: "Clearances", one: "clearance", many: "clearances" },
          // The segments and the legend already carry the split, so the sub-line
          // stays short — a long one just gets clipped by the label column.
          rows: def.map((r) => ({
            label: r.player.name,
            sub: r.team?.name || "",
            a: r.saves,
            b: r.clearances,
          })),
        })
      : empty("Saves and clearances appear here once the matches begin.")
  );

  /* 7 — The near misses. The work that shows up in a Golden Ball total without
     ever showing up on a scoreline, which is exactly why it is worth a chart. */
  const att = stats
    .filter((r) => r.chances || r.shots)
    .sort((a, b) => b.chances + b.shots - (a.chances + a.shots))
    .slice(0, 8);
  setChart(
    "chartAttacking",
    att.length
      ? stackChart({
          a: { label: "Chances created", one: "chance created", many: "chances created" },
          b: { label: "Shots on target", one: "shot on target", many: "shots on target" },
          rows: att.map((r) => ({
            label: r.player.name,
            sub: r.team?.name || "",
            a: r.chances,
            b: r.shots,
          })),
        })
      : empty("Shots on target and chances created appear here once the matches begin.")
  );

  /* 8 — Auction spend. A ratio against a fixed limit per team. */
  const s = D.getSettings(data);
  const st = D.auctionState(data);
  setChart(
    "chartSpend",
    `<div class="meters">${D.teamsList(data)
      .map((t) => {
        const x = st[t.id];
        // A squad running off-standard reads against its own size, with the
        // difference called out rather than left as a silent mismatch.
        return meter({
          label: t.name,
          sub: `${x.squad.length}/${x.squadSize} players${
            x.jerseyCost ? ` · ${x.jerseyCost} BDT jersey` : ""
          } · ${x.remaining} BDT left`,
          flag: x.extraPlayers > 0 ? `+${x.extraPlayers} extra` : "",
          used: x.spent,
          limit: Number(s.budget),
          tip: `${t.name} — spent ${x.spent} of ${s.budget} BDT on ${x.squad.length} player${
            x.squad.length === 1 ? "" : "s"
          }${
            x.extraPlayers > 0
              ? `, ${x.extraPlayers} more than the standard squad of ${s.squadSize}`
              : ""
          }${x.jerseyCost ? ` and a ${x.jerseyCost} BDT jersey` : ""}`,
        });
      })
      .join("")}</div>`
  );
}

function setChart(id, inner) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = wrap(id, inner, painted);
}
