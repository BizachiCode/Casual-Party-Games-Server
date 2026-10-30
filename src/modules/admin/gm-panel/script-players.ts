// GM console client, part 4: the player list and one player's page (profile, economy, characters, progress,
// moderation, history) with every per-player action.
export const SCRIPT_PLAYERS = String.raw`
state.players = { q: "", filter: "all", sort: "lastSeen", dir: "desc", page: 1, pageSize: 50 };
var PLAYER_FILTERS = [
  { id: "all", label: "All" }, { id: "online", label: "Online" }, { id: "new", label: "New today" },
  { id: "registered", label: "Registered" }, { id: "guest", label: "Guests" }, { id: "banned", label: "Banned" },
  { id: "muted", label: "Muted" }
];
function playerChips(player, presence) {
  var live = presence || player;
  return (player.guest ? chip("Guest") : "") + (live.online ? chip(live.roomId ? "In a match" : "Online", "green") :
    "") +
    (player.banned || (player.moderation && player.moderation.ban) ? chip("Banned", "red") : "") +
    (player.muted || (player.moderation && player.moderation.mute) ? chip("Muted", "orange") : "");
}

views.players = async function (current) {
  if (current.id) return playerView(current.id, current.tab || "profile");
  var list = state.players;
  content().innerHTML = pageHead("Players", "Every account on this server") +
    '<div class="panel"><div class="toolbar">' +
    searchRow("players", "Search by name, username or id", list.q) + "</div>" +
      '<div class="toolbar" style="padding-top:0">' +
    tabsHtml(PLAYER_FILTERS, list.filter, "filterTab", "players") + '</div><div id="playersTable">' + loadingHtml() +
    "</div></div>";
  await loaders.players();
};
loaders.players = async function () {
  var list = state.players;
  var target = byId("playersTable");
  if (!target) return;
  Array.prototype.forEach.call(document.querySelectorAll('.tab[data-scope="players"]'), function (tab) {
    tab.classList.toggle("active", tab.dataset.tab === list.filter);
  });
  try {
    var data = await api("/players" + queryString({ q: list.q, filter: list.filter, sort: list.sort, dir: list.dir,
      page: list.page, pageSize: list.pageSize }));
    var rows = data.players || [];
    target.innerHTML = rows.length ? '<div class="table-wrap"><table><thead><tr>' + sortTh("Player", "name", list,
      "players") +
      sortTh("Level", "xp", list, "players", true) + sortTh("Wins", "wins", list, "players", true) +
      sortTh("Matches", "matches", list, "players", true) + sortTh("Stars", "stars", list, "players", true) +
      sortTh("Joined", "createdAt", list, "players") + sortTh("Last seen", "lastSeen", list, "players") +
      "</tr></thead><tbody>" + rows.map(function (player) {
        return '<tr class="click" data-act="go" data-to="#players/' + esc(encodeURIComponent(player.id)) + '"><td>' +
          '<div class="cell-main">' + esc(playerLabel(player)) + '</div><div class="cell-sub">@' +
            esc(player.username) +
          '</div><div class="chips">' + playerChips(player) + '</div></td><td class="num">' + fmtNum(player.level) +
          '</td><td class="num">' + fmtNum(player.wins) + '</td><td class="num">' + fmtNum(player.matches) +
          '</td><td class="num">' + fmtNum(player.stars) + "</td><td>" + (player.createdAt ?
            fmtDate(player.createdAt) : "-") +
          "</td><td>" + (player.online ? statusDot("ok", "Online") : fmtAgo(player.lastSeen)) + "</td></tr>";
      }).join("") + "</tbody></table></div>" + pagerHtml(list, data.total, "players")
      : emptyHtml(list.q ? "No players match the search." : "No players in this list.");
  } catch (error) {
    target.innerHTML = errorHtml(error.message);
  }
};

// ── One player ──────────────────────────────────────────────────────
var PLAYER_TABS = [
  { id: "profile", label: "Profile" }, { id: "economy", label: "Economy" }, { id: "characters", label: "Characters" },
  { id: "progress", label: "Progress" }, { id: "moderation", label: "Moderation" }, { id: "history", label: "History" }
];
async function playerView(id, tab) {
  content().innerHTML = pageHead("Player", "", "", crumbHtml("Players", "#players")) + loadingHtml();
  await loadCatalog();
  var detail = await api(playerPath(id));
  if (parseRoute().id !== id) return;
  state.player = detail;
  var player = detail.player;
  var moderation = detail.moderation || {};
  var presence = detail.presence || {};
  var hero = '<div class="panel"><div class="hero"><div class="big-avatar">' +
    esc(playerLabel(player).charAt(0).toUpperCase()) + "</div><div><h2>" + esc(playerLabel(player)) +
      '</h2><div class="meta">@' +
    esc(player.username) + ' · <span class="mono">' + esc(player.id) + '</span> <button class="btn small ghost" ' +
    'data-act="copy" data-text="' + esc(player.id) + '">Copy id</button></div><div class="chips">' +
    chip("Level " + fmtNum(player.level), "violet") + playerChips(player, presence) +
      '</div></div><div class="actions">' +
    '<button class="btn" data-act="playerRename" data-id="' + esc(player.id) + '" data-name="' +
      esc(player.displayName) +
    '">Rename</button>' + (presence.online ? '<button class="btn" data-act="playerKick" data-id="' + esc(player.id) +
    '" data-name="' + esc(playerLabel(player)) + '">Kick</button>' : "") +
    (moderation.mute ? '<button class="btn" data-act="playerUnmute" data-id="' + esc(player.id) + '">Unmute</button>'
      : '<button class="btn" data-act="playerMute" data-id="' + esc(player.id) + '" data-name="' +
        esc(playerLabel(player)) +
      '">Mute</button>') +
    (moderation.ban ? '<button class="btn gold" data-act="playerUnban" data-id="' + esc(player.id) + '">Unban</button>'
      : '<button class="btn danger" data-act="playerBan" data-id="' + esc(player.id) + '" data-name="' +
      esc(playerLabel(player)) + '">Ban</button>') + "</div></div>" +
    '<div class="toolbar" style="border-top:1px solid var(--line)">' + PLAYER_TABS.map(function (item) {
      return '<button type="button" class="tab' + (item.id === tab ? " active" : "") +
        '" data-act="go" data-to="#players/' +
        esc(encodeURIComponent(player.id)) + "/" + item.id + '">' + esc(item.label) + "</button>";
    }).join("") + "</div></div>";
  var banner = moderation.ban ? '<div class="notice red" style="margin-top:16px"><b>Banned.</b>&nbsp;' +
    esc(fmtUntil(moderation.ban.until)) + (moderation.ban.reason ? " · " + esc(moderation.ban.reason) : "") +
      "</div>" : "";
  var renderers = { profile: playerProfile, economy: playerEconomy, characters: playerCharacters,
    progress: playerProgress,
    moderation: playerModeration, history: playerHistory };
  content().innerHTML = '<div style="margin-bottom:14px">' + crumbHtml("Players", "#players") + "</div>" + hero +
    banner +
    '<div style="margin-top:16px">' + (renderers[tab] || playerProfile)(detail) + "</div>";
  if (tab === "moderation") await fillPlayerReports(player.id);
  if (tab === "economy") await fillPlayerPurchases(player.id);
}
function kvRows(pairs) {
  return '<dl class="kv">' + pairs.map(function (pair) { return "<dt>" + esc(pair[0]) + "</dt><dd>" + pair[1] +
    "</dd>"; })
    .join("") + "</dl>";
}
function playerProfile(detail) {
  var player = detail.player;
  var presence = detail.presence || {};
  var social = detail.social || {};
  var moderation = detail.moderation || {};
  var against = moderation.reportsAgainst || { open: 0, total: 0 };
  return '<div class="grid2"><div class="panel"><div class="panel-head"><h2>Account</h2></div><div ' +
    'class="panel-body">' +
    kvRows([
      ["Display name", esc(player.displayName)],
      ["Username", "@" + esc(player.username) + (player.guest ? " " + chip("Guest account") : "")],
      ["Level", fmtNum(player.level) + ' <span class="cell-sub">' + fmtNum(player.xp) + " XP</span> " +
        '<button class="btn small ghost" data-act="playerXp" data-id="' + esc(player.id) + '" data-xp="' +
          esc(player.xp) +
        '">Edit</button>'],
      ["Wins / matches", fmtNum(player.wins) + " / " + fmtNum(player.matches)],
      ["Joined", player.createdAt ? fmtDate(player.createdAt) : "Before the GM console"],
      ["Last seen", presence.online ? statusDot("ok", "Online now") : fmtAgo(player.lastSeen)],
      ["Sessions", plural(player.sessions, "signed-in device") +
        ' <button class="btn small ghost" data-act="playerRevoke" ' +
        'data-id="' + esc(player.id) + '">Sign out everywhere</button>'],
      ["Guest devices", fmtNum((player.devices || []).length)]
    ]) + '</div></div><div class="stack"><div class="panel"><div class="panel-head"><h2>Right now</h2></div>' +
    '<div class="panel-body">' + kvRows([
      ["Status", presence.online ? statusDot("ok", "Online") : statusDot("", "Offline")],
      ["Match room", presence.roomId ? '<a class="mono" href="#rooms/' + encodeURIComponent(presence.roomId) + '">' +
        esc(presence.roomId) + "</a>" : "-"],
      ["Party", presence.partyId ? '<a class="mono" href="#rooms/' + encodeURIComponent(presence.partyId) + '">' +
        esc(presence.partyId) + "</a>" : "-"]
    ]) + '</div></div><div class="panel"><div class="panel-head"><h2>Social and reports</h2></div><div ' +
      'class="panel-body">' +
    kvRows([
      ["Friends", fmtNum(social.friends)],
      ["Friend requests", fmtNum(social.incoming) + " received · " + fmtNum(social.outgoing) + " sent"],
      ["Blocks", fmtNum(social.blocking) + " made · blocked by " + fmtNum(social.blockedBy)],
      ["Reports against", '<a href="#reports" data-act="reportsFor" data-id="' + esc(player.id) + '">' +
        fmtNum(against.open) + " open · " + fmtNum(against.total) + " total</a>"],
      ["Reports filed", fmtNum(moderation.reportsFiled)]
    ]) + "</div></div></div></div>";
}
function playerEconomy(detail) {
  var player = detail.player;
  var wallet = detail.wallet;
  var ledger = detail.ledger || { entries: 0, gm: [] };
  var tiles = '<div class="kpis">' +
    kpi("Stars", wallet ? fmtNum(wallet.stars) : "0", '<button class="btn small" data-act="playerStars" data-id="' +
      esc(player.id) + '">Adjust</button>', "var(--gold)") +
    kpi("Shards", wallet ? fmtNum(wallet.shards) : "0", '<button class="btn small" data-act="playerShards" data-id="' +
      esc(player.id) + '">Adjust</button>', "var(--sky)") +
    kpi("Epic pity", wallet ? fmtNum(wallet.pityEpic) : "-", "draws since the last epic") +
    kpi("Legendary pity", wallet ? fmtNum(wallet.pityLegendary) : "-", "draws since the last legendary") + "</div>";
  var note = wallet ? "" : '<div class="notice">This player has no wallet yet: it is created on the first visit to ' +
    "the collection or the first grant.</div>";
  var rows = ledger.gm || [];
  return note + tiles +
    '<div class="panel"><div class="panel-head"><h2>Purchases</h2></div><div id="playerPurchases">' +
    loadingHtml() + "</div></div>" +
      '<div class="panel"><div class="panel-head"><h2>Star grants by GMs</h2><span class="hint">' +
    plural(ledger.entries, "ledger entry", "ledger entries") + " in total</span></div>" + (rows.length ?
    '<div class="table-wrap"><table><thead><tr><th>Source</th><th class="num">Stars</th></tr></thead><tbody>' +
    rows.map(function (row) {
      return '<tr><td class="mono">' + esc(row.source) + '</td><td class="num">' + (row.amount > 0 ? "+" : "") +
        fmtNum(row.amount) + "</td></tr>";
    }).join("") + "</tbody></table></div>" : emptyHtml("No GM has changed this player's Stars.")) + "</div>";
}
function playerCharacters(detail) {
  var player = detail.player;
  var characters = detail.characters || [];
  var owned = characters.filter(function (character) { return character.owned; }).length;
  return '<div class="panel"><div class="panel-head"><h2>Characters</h2><span class="hint">' + fmtNum(owned) + " of " +
    fmtNum(characters.length) + ' owned</span></div><div class="panel-body cards">' +
      characters.map(function (character) {
      return '<div class="card-item rarity-' + esc(character.rarity) + (character.owned ? " owned" : "") +
        (character.equipped ? " equipped" : "") + '"><div class="name"><span class="rarity-dot"></span>' +
          esc(character.name) +
        '</div><div class="cell-sub">' + esc(character.rarity) + " · " + esc(character.id) +
          '</div><div class="chips" ' +
        'style="margin-top:6px">' + (character.equipped ? chip("Equipped", "gold") : "") + (character.starter ?
          chip("Starter") : "") +
        (character.owned ? chip("Owned", "green") : "") + '</div><div class="actions">' + (character.owned
          ? (character.equipped ? "" : '<button class="btn small" data-act="playerEquip" data-id="' + esc(player.id) +
            '" data-character="' + esc(character.id) + '">Equip</button>') + (character.starter ? "" :
            '<button class="btn small" data-act="playerRevokeCharacter" data-id="' + esc(player.id) +
              '" data-character="' +
            esc(character.id) + '" data-name="' + esc(character.name) + '">Remove</button>')
          : '<button class="btn small primary" data-act="playerGrantCharacter" data-id="' + esc(player.id) +
            '" data-character="' + esc(character.id) + '">Grant</button>') + "</div></div>";
    }).join("") + "</div></div>";
}
function playerProgress(detail) {
  var player = detail.player;
  var season = detail.season;
  var seasonPanel = '<div class="panel"><div class="panel-head"><h2>Battle pass</h2>' + (season ? chip(season.id,
    "violet") : "") +
    '</div><div class="panel-body">' + (season ? kvRows([
      ["Pass XP", fmtNum(season.xp)],
      ["Tier", fmtNum(season.tier) + " of " + fmtNum(season.tiers)],
      ["Premium", season.premium ? chip("Owned", "gold") : chip("Not owned")]
    ]) + '<div class="btn-row" style="margin-top:14px"><button class="btn" data-act="playerPassXp" data-id="' +
      esc(player.id) + '">Grant pass XP</button><button class="btn ' + (season.premium ? "" : "gold") +
      '" data-act="playerPremium" data-id="' + esc(player.id) + '" data-season="' + esc(season.id) + '" data-owned="' +
      (season.premium ? "0" : "1") + '">' + (season.premium ? "Remove premium" : "Give premium") + "</button></div>"
      : emptyHtml("No season is running.")) + "</div></div>";
  var rankings = detail.rankings || [];
  var times = detail.times || [];
  var boards = '<div class="panel"><div class="panel-head"><h2>Leaderboard rows</h2><button class="btn small" ' +
    'data-act="playerRankingsReset" data-id="' + esc(player.id) + '" data-scope="boards"' + (rankings.length ? "" :
      " disabled") +
    ">Reset</button></div>" + (rankings.length ?
      '<div class="table-wrap"><table><thead><tr><th>Mode</th><th>Season</th>' +
    '<th class="num">Wins</th><th class="num">Matches</th><th class="num">Points</th></tr></thead><tbody>' +
    rankings.map(function (row) {
      return "<tr><td>" + esc(row.mode) + "</td><td>" + esc(row.season) + '</td><td class="num">' + fmtNum(row.wins) +
        '</td><td class="num">' + fmtNum(row.matches) + '</td><td class="num">' + fmtNum(row.points) + "</td></tr>";
    }).join("") + "</tbody></table></div>" : emptyHtml("No leaderboard rows.")) + "</div>";
  var records = '<div class="panel"><div class="panel-head"><h2>Time trial records</h2><button class="btn small" ' +
    'data-act="playerRankingsReset" data-id="' + esc(player.id) + '" data-scope="times"' + (times.length ? "" :
      " disabled") +
    ">Reset</button></div>" + (times.length ? '<div class="table-wrap"><table><thead><tr><th>Course</th>' +
    '<th class="num">Best time</th></tr></thead><tbody>' + times.map(function (row) {
      return "<tr><td>" + esc(row.courseId) + '</td><td class="num">' + num(row.seconds).toFixed(2) + " s</td></tr>";
    }).join("") + "</tbody></table></div>" : emptyHtml("No time trial records.")) + "</div>";
  return '<div class="grid2">' + seasonPanel + '<div class="stack">' + boards + records + "</div></div>";
}
function restrictionHtml(title, restriction, action, label) {
  return '<div class="panel"><div class="panel-head"><h2>' + esc(title) + "</h2>" + (restriction ? chip("Active", "red")
    : chip("None", "green")) + '</div><div class="panel-body">' + (restriction ? kvRows([
      ["Ends", esc(fmtUntil(restriction.until))],
      ["Reason", esc(restriction.reason || "-")],
      ["By", esc(restriction.createdBy || "-") + ' <span class="cell-sub">' + fmtDate(restriction.createdAt) +
        "</span>"]
    ]) + '<div class="btn-row" style="margin-top:14px">' + action + "</div>" : '<div class="btn-row">' + label +
      "</div>") +
    "</div></div>";
}
function playerModeration(detail) {
  var player = detail.player;
  var moderation = detail.moderation || {};
  var name = esc(playerLabel(player));
  var id = esc(player.id);
  return '<div class="grid2">' +
    restrictionHtml("Ban", moderation.ban, '<button class="btn gold" data-act="playerUnban" data-id="' + id +
      '">Unban</button>',
      '<button class="btn danger" data-act="playerBan" data-id="' + id + '" data-name="' + name + '">Ban</button>') +
    restrictionHtml("Chat mute", moderation.mute, '<button class="btn" data-act="playerUnmute" data-id="' + id +
      '">Unmute</button>', '<button class="btn" data-act="playerMute" data-id="' + id + '" data-name="' + name +
      '">Mute</button>') + '</div><div class="panel"><div class="panel-head"><h2>Reports about this player</h2>' +
    '<button class="btn small" data-act="reportsFor" data-id="' + id +
      '">Open in Reports</button></div><div id="playerReports">' +
    loadingHtml() + "</div></div>";
}
function playerHistory(detail) {
  var entries = detail.history || [];
  return '<div class="panel"><div class="panel-head"><h2>GM actions on this player</h2><span class="hint">latest ' +
    fmtNum(entries.length) + "</span></div>" + (entries.length ? auditTable(entries, false) :
    emptyHtml("No GM has acted on this player.")) + "</div>";
}
async function fillPlayerReports(id) {
  var target = byId("playerReports");
  if (!target) return;
  try {
    var data = await api("/reports" + queryString({ status: "all", target: id, pageSize: 25 }));
    target.innerHTML = (data.reports || []).length ? reportsTable(data.reports) :
      emptyHtml("Nobody has reported this player.");
  } catch (error) {
    target.innerHTML = errorHtml(error.message);
  }
}

// ── Player actions ──────────────────────────────────────────────────
function afterAction(message) {
  toast(message, "ok");
  route();
}
function idOf(element) { return element.dataset.id; }
var DURATIONS = [
  ["60", "1 hour"], ["360", "6 hours"], ["1440", "1 day"], ["4320", "3 days"], ["10080", "7 days"], ["43200", "30 days"]
];
actions.playerRename = async function (element) {
  var values = await dialog({ title: "Rename player", fields: [
    { name: "displayName", label: "Display name", value: element.dataset.name, maxlength: 20 }], confirm: "Rename" });
  if (!values) return;
  await post(playerPath(idOf(element), "rename"), { displayName: values.displayName });
  afterAction("Renamed to " + values.displayName + ".");
};
async function adjust(element, currency, path) {
  var values = await dialog({ title: "Adjust " + currency, text: "Use a negative amount to take " + currency + " away.",
    fields: [
      { name: "delta", label: "Amount", type: "number", placeholder: "e.g. 500 or -200" },
      { name: "note", label: "Note for the audit log", maxlength: 140, placeholder: "Compensation for ..." }
    ], confirm: "Apply" });
  if (!values || !values.delta) return;
  var result = await post(playerPath(idOf(element), path), { delta: values.delta, note: values.note,
    requestId: newRequestId() });
  afterAction(result.duplicate ? "That request had already been applied." : currency.charAt(0).toUpperCase() +
    currency.slice(1) + " updated.");
}
actions.playerStars = function (element) { return adjust(element, "Stars", "stars"); };
actions.playerShards = function (element) { return adjust(element, "shards", "shards"); };
actions.playerXp = async function (element) {
  var values = await dialog({ title: "Set account XP", text: "Level = 1 + XP / 250.", fields: [
    { name: "xp", label: "XP", type: "number", min: 0, value: element.dataset.xp }], confirm: "Save" });
  if (!values || values.xp === null) return;
  var result = await post(playerPath(idOf(element), "xp"), { xp: values.xp });
  afterAction("XP set: level " + result.level + ".");
};
actions.playerGrantCharacter = async function (element) {
  await post(playerPath(idOf(element), "characters/grant"), { characterId: element.dataset.character });
  afterAction(characterName(element.dataset.character) + " granted.");
};
actions.playerRevokeCharacter = async function (element) {
  if (!(await confirmAction("Remove " + element.dataset.name,
    "The player loses this character. If it is equipped, the " +
    "starter character is equipped instead.", "Remove"))) return;
  await post(playerPath(idOf(element), "characters/revoke"), { characterId: element.dataset.character });
  afterAction(element.dataset.name + " removed.");
};
actions.playerEquip = async function (element) {
  await post(playerPath(idOf(element), "equip"), { characterId: element.dataset.character });
  afterAction(characterName(element.dataset.character) + " equipped.");
};
actions.playerPassXp = async function (element) {
  var values = await dialog({ title: "Grant battle pass XP", fields: [
    { name: "xp", label: "Pass XP", type: "number", min: 1, placeholder: "e.g. 500" }], confirm: "Grant" });
  if (!values || !values.xp) return;
  var result = await post(playerPath(idOf(element), "pass-xp"), { xp: values.xp, requestId: newRequestId() });
  afterAction(fmtNum(result.granted) + " pass XP granted" + (result.granted < values.xp ?
    " (capped at the last tier)." : "."));
};
actions.playerPremium = async function (element) {
  var owned = element.dataset.owned === "1";
  if (!(await confirmAction(owned ? "Give the premium pass" : "Remove the premium pass", owned ?
    "The player gets the " +
    "premium track of " + element.dataset.season + " without paying." : "Rewards already claimed stay with the player.",
    owned ? "Give premium" : "Remove premium", !owned))) return;
  await post(playerPath(idOf(element), "premium"), { seasonId: element.dataset.season, owned: owned });
  afterAction(owned ? "Premium pass given." : "Premium pass removed.");
};
actions.playerRankingsReset = async function (element) {
  var scope = element.dataset.scope;
  if (!(await confirmAction("Reset " + (scope === "times" ? "time trial records" : "leaderboard rows"),
    "This removes the player's " + (scope === "times" ? "best times" : "wins and points on every board") +
    ". It cannot be undone.", "Reset"))) return;
  var result = await post(playerPath(idOf(element), "rankings/reset"), { scope: scope });
  afterAction(plural(result.removed, "row") + " removed.");
};
actions.playerKick = async function (element) {
  var values = await dialog({ title: "Kick " + (element.dataset.name || "player"), danger: true, confirm: "Kick",
    text: "Removes the player from every match and party on this server.",
    fields: [{ name: "message", label: "Message", maxlength: 180, value: "Removed by a moderator." }] });
  if (!values) return;
  var result = await post(playerPath(idOf(element), "kick"), { message: values.message });
  afterAction(result.removed ? "Player removed." : "The player was not in a match or party.");
};
actions.playerRevoke = async function (element) {
  if (!(await confirmAction("Sign out everywhere",
    "Ends every session of this account; the player must sign in again " +
    "(a guest signs in again automatically).", "Sign out"))) return;
  var result = await post(playerPath(idOf(element), "sessions/revoke"));
  afterAction(plural(result.sessions, "session") + " ended.");
};
actions.playerBan = async function (element) {
  var values = await dialog({ title: "Ban " + (element.dataset.name || "player"), danger: true, confirm: "Ban",
    text: "The player is signed out, removed from matches and cannot sign in until the ban ends.",
    fields: [
      { name: "minutes", label: "Duration", type: "select", value: "0", options: [["0",
        "Permanent"]].concat(DURATIONS) },
      { name: "reason", label: "Reason (shown to the player)", maxlength: 280, placeholder: "Cheating" }
    ] });
  if (!values) return;
  var minutes = Number(values.minutes) || null;
  await post(playerPath(idOf(element), "ban"), { reason: values.reason, minutes: minutes });
  afterAction("Player banned.");
};
actions.playerUnban = async function (element) {
  if (!(await confirmAction("Unban player", "The player can sign in again.", "Unban", false))) return;
  await post(playerPath(idOf(element), "unban"));
  afterAction("Ban lifted.");
};
actions.playerMute = async function (element) {
  var values = await dialog({ title: "Mute " + (element.dataset.name || "player"), confirm: "Mute",
    text: "The player's match chat is dropped until the mute ends.",
    fields: [
      { name: "minutes", label: "Duration", type: "select", value: "60", options: DURATIONS },
      { name: "reason", label: "Reason", maxlength: 280, placeholder: "Abusive chat" }
    ] });
  if (!values) return;
  await post(playerPath(idOf(element), "mute"), { reason: values.reason, minutes: Number(values.minutes) });
  afterAction("Player muted.");
};
actions.playerUnmute = async function (element) {
  await post(playerPath(idOf(element), "unmute"));
  afterAction("Mute lifted.");
};
`;
