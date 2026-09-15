/**
 * The super admin's Accounts screen.
 *
 * Every account is made here and handed over — a User ID and a password on a
 * piece of paper, or in a message. An admin or referee account is tied to ONE
 * tournament when it is created and cannot be moved; running a second
 * tournament means a second account. The server enforces that; this screen just
 * makes it the obvious thing to do.
 */

import * as D from "/shared/domain/index.js";
import { $, setHTML, toast } from "../ui.js";
import { users } from "../api.js";
import { relativeTime } from "./overview.js";

const e = D.escapeHtml;

const ROLE_LABEL = { admin: "Tournament admin", referee: "Referee" };

/** Easy to read out and to copy from a screen: no 0/O, 1/l/I. */
export function generatePassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

let tournamentsList = [];

/** @param {{ getTournaments: () => Array<{id:string,code:string,name:string,season?:string}> }} hooks */
export function wireAccounts({ getTournaments }) {
  const panel = $("#panel-accounts");
  const roleSelect = $("#newAccountRole");
  const syncRole = () => {
    const isSuper = roleSelect.value === "super";
    $("#newAccountTournamentField").hidden = isSuper;
  };
  roleSelect.addEventListener("change", syncRole);
  syncRole();

  panel.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;

    if (btn.id === "generatePassword") {
      $("#newAccountPassword").value = generatePassword();
      $("#newAccountPassword").type = "text";
      return;
    }

    if (btn.id === "createAccount") {
      const body = {
        name: $("#newAccountName").value.trim(),
        username: $("#newAccountUsername").value.trim(),
        password: $("#newAccountPassword").value,
        role: roleSelect.value,
        tournamentId: roleSelect.value === "super" ? null : $("#newAccountTournament").value,
      };
      try {
        const { user } = await users.create(body);
        showHandover(user, body.password);
        for (const id of ["#newAccountName", "#newAccountUsername", "#newAccountPassword"]) $(id).value = "";
        $("#newAccountPassword").type = "password";
        await renderAccounts(getTournaments());
      } catch (err) {
        toast(err.message, "err");
      }
      return;
    }

    const id = btn.dataset.account;
    if (!id) return;

    try {
      if (btn.dataset.do === "reset") {
        const password = generatePassword();
        if (!confirm(`Give ${btn.dataset.username} a new password? They will be signed out everywhere.`)) return;
        const { user } = await users.resetPassword(id, password);
        showHandover(user, password);
      } else if (btn.dataset.do === "disable") {
        if (!confirm(`Switch off ${btn.dataset.username}? They are signed out straight away.`)) return;
        await users.setStatus(id, "disabled");
        toast("Account switched off.");
      } else if (btn.dataset.do === "enable") {
        await users.setStatus(id, "active");
        toast("Account switched back on.");
      } else if (btn.dataset.do === "delete") {
        if (!confirm(`Delete ${btn.dataset.username} for good? The activity log keeps their name.`)) return;
        await users.remove(id);
        toast("Account deleted.");
      }
      await renderAccounts(getTournaments());
    } catch (err) {
      toast(err.message, "err");
    }
  });
}

/** The details to hand over, shown once — the password is not stored anywhere readable. */
function showHandover(user, password) {
  const where = user.isSuper ? "Super admin — every tournament" : `${ROLE_LABEL[user.tournament?.role] ?? ""} · ${user.tournament?.code} ${user.tournament?.name}`;
  setHTML(
    $("#handover"),
    `<div class="handover" role="status">
      <p><b>Give these to ${e(user.name)}.</b> The password is shown only now.</p>
      <dl class="deflist">
        <dt>Sign in at</dt><dd>${e(location.origin)}/admin</dd>
        <dt>User ID</dt><dd><code>${e(user.username)}</code></dd>
        <dt>Password</dt><dd><code>${e(password)}</code></dd>
        <dt>For</dt><dd>${e(where)}</dd>
      </dl>
      <button class="btn btn--sm btn--ghost" type="button" data-copy>Copy</button>
    </div>`,
  );
  $("#handover [data-copy]").addEventListener("click", async () => {
    const text = `Sign in at ${location.origin}/admin\nUser ID: ${user.username}\nPassword: ${password}`;
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied.");
    } catch {
      toast("Could not copy — select the text instead.", "err");
    }
  });
  $("#handover").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

export async function renderAccounts(tournaments) {
  tournamentsList = tournaments;
  setHTML(
    $("#newAccountTournament"),
    tournamentsList.length
      ? tournamentsList
          .map((t) => `<option value="${e(t.id)}">${e(t.code)} · ${e(t.name)}${t.season ? ` ${e(t.season)}` : ""}</option>`)
          .join("")
      : `<option value="">Create a tournament first</option>`,
  );

  let list;
  try {
    ({ users: list } = await users.list());
  } catch (err) {
    setHTML($("#accountList"), `<p class="faint err">${e(err.message)}</p>`);
    return;
  }

  // Grouped by tournament code, super admins first — the question this screen
  // usually answers is "who runs WGT-7F4C2A?".
  const groups = new Map([["__super", { title: "Super admins", people: [] }]]);
  for (const t of tournamentsList) groups.set(t.id, { title: `${t.code} · ${t.name}`, people: [] });
  groups.set("__none", { title: "Not attached to a tournament", people: [] });

  for (const u of list) {
    const key = u.isSuper ? "__super" : u.tournament?.id ?? "__none";
    (groups.get(key) ?? groups.get("__none")).people.push(u);
  }

  setHTML(
    $("#accountList"),
    [...groups.values()]
      .filter((g) => g.people.length)
      .map(
        (g) => `<section class="acct-group">
          <h3 class="acct-group__title">${e(g.title)}</h3>
          ${g.people
            .map(
              (u) => `<div class="people-row${u.status === "disabled" ? " is-off" : ""}">
                <span class="grow">
                  <b>${e(u.name)}</b> <code class="faint">${e(u.username)}</code>
                  <span class="faint acct-meta">${u.isSuper ? "Super admin" : e(ROLE_LABEL[u.tournament?.role] ?? "No role")} · last seen ${e(relativeTime(u.lastSeenAt))}</span>
                </span>
                ${u.status === "disabled" ? `<span class="pill pill--danger">Off</span>` : ""}
                <button class="btn btn--sm btn--ghost" data-account="${e(u.id)}" data-username="${e(u.username)}" data-do="reset" type="button">New password</button>
                ${
                  u.status === "disabled"
                    ? `<button class="btn btn--sm btn--ghost" data-account="${e(u.id)}" data-username="${e(u.username)}" data-do="enable" type="button">Switch on</button>
                       <button class="btn btn--sm btn--danger" data-account="${e(u.id)}" data-username="${e(u.username)}" data-do="delete" type="button">Delete</button>`
                    : `<button class="btn btn--sm btn--danger" data-account="${e(u.id)}" data-username="${e(u.username)}" data-do="disable" type="button">Switch off</button>`
                }
              </div>`,
            )
            .join("")}
        </section>`,
      )
      .join(""),
  );
}
