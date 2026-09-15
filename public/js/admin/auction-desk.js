/**
 * The auctioneer's desk.
 *
 * The flow on the day: tap a face in the pool to put that player on the block —
 * the projector in the room shows them straight away — take bids out loud,
 * choose the team, type the price, Sell. The projector shows SOLD, the budgets
 * update, and the next face goes up.
 *
 * Every sale is checked twice with the same rules: here, as the price is typed,
 * so the auctioneer sees "Looks good" or the reason it will be refused; and on
 * the server, which is the one that counts.
 */

import * as D from "/shared/domain/index.js";
import { $, setHTML, toast } from "../ui.js";
import { people, tournaments } from "../api.js";

const e = D.escapeHtml;

let getData = () => null;
let posFilter = "";
const personCache = new Map();

function initials(name) {
  const words = String(name ?? "").replace(/[^A-Za-z ]/g, " ").trim().split(" ").filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase() || "?";
}

const face = (p, cls) =>
  p?.photo
    ? `<img class="${cls}" src="${e(p.photo)}" alt="" loading="lazy" width="120" height="120" />`
    : `<span class="${cls} desk-face--empty" aria-hidden="true">${e(initials(p?.name))}</span>`;

/** The roster record behind a tournament player — rating and career — fetched once. */
async function personFor(player) {
  if (!player?.personId) return null;
  if (!personCache.has(player.personId)) {
    personCache.set(
      player.personId,
      people.get(player.personId).then((r) => r.person).catch(() => null),
    );
  }
  return personCache.get(player.personId);
}

export function wireAuctionDesk(dataGetter) {
  getData = dataGetter;
  const panel = $("#panel-auction");

  panel.addEventListener("click", async (ev) => {
    const data = getData();
    const btn = ev.target.closest("button");
    if (!btn || !data) return;

    try {
      if (btn.dataset.block) {
        await tournaments.block(data.id, btn.dataset.block);
        $("#sellPrice").value = "";
        // On a phone the block card sits above the pool; bring it back into view
        // so the auctioneer is looking at the Sold button, not the list.
        if (window.matchMedia("(max-width: 979px)").matches) {
          $("#panel-auction .block").scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          $("#sellPrice").focus({ preventScroll: true });
        }
      } else if (btn.id === "clearBlock") {
        await tournaments.block(data.id, null);
      } else if (btn.dataset.pos !== undefined && btn.closest("#deskPos")) {
        posFilter = btn.dataset.pos;
        renderAuctionDesk();
      } else if (btn.dataset.bid) {
        const input = $("#sellPrice");
        const base = Number(input.value || D.getSettings(data).basePrice);
        input.value = String(input.value ? base + Number(btn.dataset.bid) : base);
        input.dispatchEvent(new Event("input"));
      }
    } catch (err) {
      toast(err.message, "err");
    }
  });

  $("#deskSearch").addEventListener("input", renderAuctionDesk);

  for (const id of ["#sellTeam", "#sellPrice"]) {
    $(id).addEventListener("input", hint);
    $(id).addEventListener("change", hint);
  }
}

/** The live "will this sale be allowed?" line, from the same validator the server runs. */
function hint() {
  const data = getData();
  if (!data) return;
  const playerId = D.getSettings(data).auctionOnBlock;
  const teamId = $("#sellTeam").value;
  const raw = $("#sellPrice").value;
  const el = $("#sellHint");
  if (!playerId) return (el.textContent = "Put a player on the block first — tap one in the pool.");
  if (!teamId || !raw) return (el.textContent = "");
  const res = D.validateSale(data, playerId, teamId, Number(raw));
  el.textContent = res.ok ? "Looks good." : res.error;
  el.className = res.ok ? "faint ok" : "faint err";
}

export function renderAuctionDesk() {
  const data = getData();
  if (!data) return;

  const settings = D.getSettings(data);
  const progress = D.auctionProgress(data);
  const state = D.auctionState(data);
  const onBlock = settings.auctionOnBlock ? data.players[settings.auctionOnBlock] : null;

  $("#projectorLink").href = `/auction/${encodeURIComponent(data.slug)}`;
  $("#deskProgress").textContent = progress.total
    ? `${progress.sold} of ${progress.total} sold · ${D.bdt(progress.spend)} spent`
    : "The auction pool is empty. Add players on the Setup tab.";

  /* ---- the player on the block ---- */
  const teamSelect = $("#sellTeam");
  const keepTeam = teamSelect.value;
  setHTML(
    teamSelect,
    `<option value="">Sold to…</option>` +
      D.teamsList(data)
        .map((t) => {
          const st = state[t.id];
          return `<option value="${e(t.id)}"${t.id === keepTeam ? " selected" : ""}${st?.complete ? " disabled" : ""}>${e(t.name)} — ${e(D.bdt(st?.remaining ?? 0))} left, max ${e(D.bdt(st?.maxBid ?? 0))}${st?.complete ? " (full)" : ""}</option>`;
        })
        .join(""),
  );

  const block = $("#blockPlayer");
  if (onBlock) {
    block.dataset.player = onBlock.id;
    setHTML(
      block,
      `${face(onBlock, "desk-face desk-face--xl")}
       <div class="block__who">
         <span class="pos-tag ${e(onBlock.pos)}">${e(onBlock.pos)}</span>
         <h3 class="block__name">${e(onBlock.name)}</h3>
         <p class="faint block__record" id="blockRecord">${onBlock.personId ? "Loading their record…" : "Not on the roster yet — no record."}</p>
       </div>`,
    );
    personFor(onBlock).then((person) => {
      if ($("#blockPlayer").dataset.player !== onBlock.id) return;
      const rec = $("#blockRecord");
      if (!rec || !person) return;
      const t = person.totals;
      rec.innerHTML = [
        person.rating !== null ? `<b class="block__rating">${person.rating}</b> rating` : null,
        person.statsRating !== null ? `stats ${person.statsRating}` : null,
        t.matches ? `${D.plural(t.matches, "match", "matches")} · ${D.plural(t.goals, "goal")} · ${D.plural(t.saves, "save")}` : "Yet to play",
        person.titles ? `🏆 ${person.titles}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    });
  } else {
    delete block.dataset.player;
    setHTML(block, `<div class="block__empty"><b>Nobody on the block</b><span class="faint">Tap a player in the pool below to put them up.</span></div>`);
  }
  $("#clearBlock").hidden = !onBlock;
  $("#sellPrice").placeholder = String(settings.basePrice);
  hint();

  /* ---- the pool ---- */
  for (const b of document.querySelectorAll("#deskPos button")) {
    b.setAttribute("aria-pressed", String(b.dataset.pos === posFilter));
  }
  const q = $("#deskSearch").value.trim().toLowerCase();
  const unsold = D.unsoldPlayers(data)
    .filter((p) => !posFilter || p.pos === posFilter)
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .sort((a, b) => D.POSITIONS.indexOf(a.pos) - D.POSITIONS.indexOf(b.pos) || a.name.localeCompare(b.name));

  setHTML(
    $("#poolGrid"),
    unsold
      .map(
        (p) => `<button class="pool-pick${p.id === onBlock?.id ? " is-up" : ""}" type="button" data-block="${e(p.id)}" aria-pressed="${p.id === onBlock?.id}">
          ${face(p, "desk-face")}
          <span class="pool-pick__name">${e(p.name)}</span>
          <span class="pos-tag ${e(p.pos)}">${e(p.pos)}</span>
        </button>`,
      )
      .join("") || `<p class="faint">${D.unsoldPlayers(data).length ? "Nobody matches that." : "Everyone has been sold."}</p>`,
  );

  /* ---- budgets ---- */
  setHTML(
    $("#captainGrid"),
    D.teamsList(data)
      .map((t) => {
        const st = state[t.id];
        if (!st) return "";
        const chips = D.POSITIONS.map(
          (pos) => `<span class="slot-chip${st.counts[pos] >= st.max[pos] ? " is-full" : ""}">${pos} ${st.counts[pos]}/${st.max[pos]}</span>`,
        ).join("");
        return `<div class="budget-row">
          <span class="jersey-dot" style="background:${e(t.jerseyColor || "#888")}"></span>
          <b class="budget-row__name">${e(t.name)}</b>
          <span class="budget-row__money"><b>${e(D.bdt(st.remaining))}</b> left · max bid ${e(D.bdt(st.maxBid))}</span>
          <span class="budget-row__slots">${st.squad.length}/${st.squadSize} ${chips}</span>
        </div>`;
      })
      .join("") || `<p class="faint">Add teams first.</p>`,
  );

  /* ---- sold, newest first as far as the data knows (by team) ---- */
  const sold = D.auctionPlayers(data).filter((p) => p.teamId);
  setHTML(
    $("#poolList"),
    sold
      .map(
        (p) => `<div class="people-row">
          ${face(p, "desk-face desk-face--sm")}
          <span class="grow">${e(p.name)} <span class="faint">${e(p.pos)}</span></span>
          <span class="pill pill--mint">${e(D.teamById(data, p.teamId)?.name)} · ${e(D.bdt(p.price))}</span>
          <button class="btn btn--sm btn--ghost" data-unsell="${e(p.id)}" type="button">Unsell</button>
        </div>`,
      )
      .join("") || `<p class="faint">Nothing sold yet.</p>`,
  );
}

/** The sale itself, called by the console's Sell button. */
export async function sellOnBlock() {
  const data = getData();
  const playerId = D.getSettings(data).auctionOnBlock;
  if (!playerId) throw new Error("Put a player on the block first.");
  const player = data.players[playerId];
  const team = data.teams[$("#sellTeam").value];
  if (!team) throw new Error("Choose the team that won the bid.");
  const price = Number($("#sellPrice").value);
  await tournaments.sell(data.id, playerId, team.id, price);
  $("#sellPrice").value = "";
  $("#sellTeam").value = "";
  return `${player.name} sold to ${team.name} for ${D.bdt(price)}.`;
}
