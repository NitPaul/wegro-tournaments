/**
 * The auction projector screen, at /auction/<slug>.
 *
 * Built to be read from the back of a meeting room: big faces, big numbers,
 * nothing to click. It follows the tournament over the same live stream as the
 * scoreboard. Whoever the auctioneer puts on the block appears with their photo
 * and record; when a sale lands, the screen shows SOLD with the face, the team
 * and the price.
 *
 * A sale is spotted by comparing the new state with the last one — a player who
 * was unsold now has a team — rather than by trusting a single event, so a
 * laptop that drops off the wifi for a moment still shows every sale when it
 * reconnects, instead of silently missing one.
 */

import * as D from "/shared/domain/index.js";
import { $, setHTML, show } from "./ui.js";
import { people, watchTournament } from "./api.js";
import { celebrate } from "./confetti.js";

const e = D.escapeHtml;
const slug = decodeURIComponent(location.pathname.split("/")[2] ?? "");

let previous = null;
const recent = []; // newest first: { player, team, price }
const personCache = new Map();

if (!slug) {
  problem("This screen needs a tournament in its address, like /auction/wegro-champions-league-2027.");
} else {
  watchTournament(slug, onData, (err) => problem(err.status === 404 ? "No published tournament has this address." : err.message));
}

keepAwake();
$("#fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
});

function problem(text) {
  $("#problemText").textContent = text;
  show($("#problem"), true);
}

function onData(data) {
  show($("#problem"), false);
  document.title = `Auction — ${data.name}`;
  $("#tournamentName").textContent = `${data.name}${data.season ? ` ${data.season}` : ""}`;

  if (previous) {
    for (const p of D.auctionPlayers(data)) {
      const before = previous.players[p.id];
      if (p.teamId && before && !before.teamId) {
        const sale = { player: p, team: data.teams[p.teamId], price: p.price };
        recent.unshift(sale);
        showSold(sale);
      }
    }
  } else {
    // First load: what has already sold, most expensive first, fills the ticker.
    for (const p of D.auctionPlayers(data).filter((x) => x.teamId).sort((a, b) => b.price - a.price)) {
      recent.push({ player: p, team: data.teams[p.teamId], price: p.price });
    }
  }
  recent.splice(12);
  previous = data;

  paintProgress(data);
  paintLot(data);
  paintBoards(data);
  paintTicker();
}

/* ------------------------------------------------------------------ parts */

function initials(name) {
  const w = String(name ?? "").replace(/[^A-Za-z ]/g, " ").trim().split(" ").filter(Boolean);
  return ((w[0]?.[0] ?? "") + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase() || "?";
}

const face = (p, cls) =>
  p?.photo
    ? `<img class="${cls}" src="${e(p.photo)}" alt="" />`
    : `<span class="${cls} face-empty" aria-hidden="true">${e(initials(p?.name))}</span>`;

const POS_NAME = { GK: "Goalkeeper", DEF: "Defender", MID: "Midfielder", FWD: "Forward" };

function paintProgress(data) {
  const p = D.auctionProgress(data);
  $("#progressText").textContent = p.total ? `${p.sold} of ${p.total} sold` : "";
  $("#progressBar").style.width = p.total ? `${(p.sold / p.total) * 100}%` : "0";
}

async function paintLot(data) {
  const settings = D.getSettings(data);
  const player = settings.auctionOnBlock ? data.players[settings.auctionOnBlock] : null;
  const lot = $("#lot");

  if (!player) {
    const left = D.unsoldPlayers(data).length;
    lot.dataset.player = "";
    setHTML(
      lot,
      `<div class="lot__waiting">
        <span class="lot__eyebrow">${left ? "Up next" : "The auction is complete"}</span>
        <b>${left ? "The next player is coming up" : "Every player has a team"}</b>
        ${left ? `<span>${D.plural(left, "player")} still to go</span>` : ""}
      </div>`,
    );
    return;
  }

  if (lot.dataset.player === player.id) return; // already showing; don't restart the entrance
  lot.dataset.player = player.id;

  setHTML(
    lot,
    `<div class="lot__card">
      <div class="lot__photo">${face(player, "lot__img")}</div>
      <div class="lot__info">
        <span class="lot__eyebrow">On the block</span>
        <h1 class="lot__name">${e(player.name)}</h1>
        <p class="lot__pos"><span class="pos-tag ${e(player.pos)}">${e(player.pos)}</span> ${e(POS_NAME[player.pos] ?? "")}</p>
        <div class="lot__record" id="lotRecord"></div>
        <p class="lot__base">Base price <b>${e(D.bdt(settings.basePrice))}</b></p>
      </div>
    </div>`,
  );

  if (!player.personId) return;
  if (!personCache.has(player.personId)) {
    personCache.set(player.personId, people.get(player.personId).then((r) => r.person).catch(() => null));
  }
  const person = await personCache.get(player.personId);
  if (!person || $("#lot").dataset.player !== player.id) return;

  const t = person.totals;
  if (!t.matches && person.rating === null) {
    setHTML($("#lotRecord"), `<p class="lot__first">First tournament — no record yet.</p>`);
    return;
  }
  const tiles = [
    person.rating !== null ? ["Rating", person.rating, "is-rating"] : person.statsRating !== null ? ["From stats", person.statsRating, "is-rating"] : null,
    ["Matches", t.matches],
    player.pos === "GK" ? ["Saves", t.saves] : ["Goals", t.goals],
    player.pos === "GK" || player.pos === "DEF" ? ["Clean sheets", t.cleanSheets] : ["Assists", t.assists],
    person.titles ? ["Titles", `🏆 ${person.titles}`] : null,
  ].filter(Boolean);

  setHTML(
    $("#lotRecord"),
    `<dl class="lot__tiles">${tiles.map(([k, v, cls]) => `<div class="${cls ?? ""}"><dt>${e(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>
     ${person.medals.length ? `<p class="lot__medals">${person.medals.map((m) => `${m.icon} ${e(m.label)} ${e(m.season ?? "")}`).join(" · ")}</p>` : ""}`,
  );
}

function paintBoards(data) {
  const state = D.auctionState(data);
  setHTML(
    $("#boards"),
    D.teamsList(data)
      .map((t) => {
        const st = state[t.id];
        if (!st) return "";
        const captain = D.teamCaptain(data, t.id);
        const slots = D.POSITIONS.map((pos) => {
          const have = st.counts[pos];
          const max = st.max[pos];
          return `<span class="slot"><b>${pos}</b>${Array.from({ length: max }, (_, i) => `<i class="${i < have ? "on" : ""}"></i>`).join("")}</span>`;
        }).join("");
        return `<div class="board${st.complete ? " is-complete" : ""}">
          <div class="board__head">
            <span class="board__jersey" style="background:${e(t.jerseyColor || "#888")}"></span>
            <b class="board__name">${e(t.name)}</b>
            ${captain ? `<span class="board__cap">${face(captain, "board__cap-img")} ${e(captain.name)}</span>` : ""}
          </div>
          <div class="board__money">
            <span><small>Left</small><b>${e(D.bdt(st.remaining))}</b></span>
            <span><small>Max bid</small><b>${st.complete ? "Full" : e(D.bdt(st.maxBid))}</b></span>
          </div>
          <div class="board__slots">${slots}</div>
          <div class="board__squad">${st.squad.map((p) => face(p, "board__face")).join("")}</div>
        </div>`;
      })
      .join(""),
  );
}

function paintTicker() {
  setHTML(
    $("#ticker"),
    recent.length
      ? `<span class="ticker__label">Sold</span>${recent
          .map((s) => `<span class="ticker__item">${face(s.player, "ticker__face")} <b>${e(s.player.name)}</b> → ${e(s.team?.name ?? "")} <em>${e(D.bdt(s.price))}</em></span>`)
          .join("")}`
      : `<span class="ticker__label">No sales yet</span>`,
  );
}

/* ------------------------------------------------------------------ SOLD */

let soldTimer = null;
function showSold({ player, team, price }) {
  const el = $("#sold");
  setHTML(
    el,
    `<div class="sold__card">
      <span class="sold__stamp">SOLD</span>
      ${face(player, "sold__face")}
      <b class="sold__name">${e(player.name)}</b>
      <span class="sold__to"><span class="board__jersey" style="background:${e(team?.jerseyColor || "#888")}"></span> ${e(team?.name ?? "")}</span>
      <span class="sold__price">${e(D.bdt(price))}</span>
    </div>`,
  );
  show(el, true);
  el.classList.remove("is-out");
  celebrate("sale");
  clearTimeout(soldTimer);
  soldTimer = setTimeout(() => {
    el.classList.add("is-out");
    setTimeout(() => show(el, false), 350);
  }, 3200);
}

/* -------------------------------------------------------------- keep awake */

/** Stop the projector laptop dimming mid-auction, where the browser allows it. */
async function keepAwake() {
  if (!("wakeLock" in navigator)) return;
  const request = async () => {
    try {
      await navigator.wakeLock.request("screen");
    } catch {
      /* not allowed here; the screen may dim */
    }
  };
  await request();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") request();
  });
}
