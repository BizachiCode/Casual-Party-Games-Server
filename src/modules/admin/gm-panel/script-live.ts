// GM console client, part 3: live rooms (matches and parties), one room, and the live chat of this server process.
export const SCRIPT_LIVE = String.raw`
var PHASE_TONE = { lobby: "violet", countdown: "gold", running: "green", results: "orange", finished: "" };
function phaseChip(room) {
  return chip(room.phase + (room.round ? " · round " + room.round : ""), PHASE_TONE[room.phase] || "");
}
function roomKindChips(room) {
  return chip(room.kind === "private" ? "Private" : "Public", room.kind === "private" ? "orange" : "") +
    (room.eventId ? " " + chip("Event " + room.eventId, "gold") : "") + (room.locked ? " " + chip("Locked") : "");
}
function accountCell(accountId, name) {
  if (!accountId) return '<span class="cell-sub">No account</span>';
  return '<a href="#players/' + encodeURIComponent(accountId) + '">' + esc(name || shortId(accountId)) + "</a>";
}

views.rooms = async function (current) {
  if (current.id) return roomView(current.id);
  content().innerHTML = pageHead("Rooms", "Matches and parties on this server process") + loadingHtml();
  await renderRooms();
  every(5000, renderRooms);
};
async function renderRooms() {
  var data = await api("/live/rooms");
  if (parseRoute().view !== "rooms" || parseRoute().id) return;
  var totals = data.totals || {};
  var matches = data.matches || [];
  var squads = data.squads || [];
  var head = pageHead("Rooms", "Matches and parties on this server process · refreshes every 5 seconds",
    '<button class="btn" data-act="broadcast">' + icon("megaphone", 16) + "Broadcast</button>");
  var tiles = '<div class="kpis">' + kpi("Match rooms", fmtNum(totals.matches)) +
    kpi("Players in matches", fmtNum(totals.humans), plural(totals.bots || 0, "bot"), "var(--green)") +
    kpi("Parties", fmtNum(totals.squads), plural(totals.partyMembers || 0, "member"), "var(--sky)") + "</div>";
  var matchTable = matches.length ?
    '<div class="table-wrap"><table><thead><tr><th>Room</th><th>Mode</th><th>Phase</th>' +
    '<th class="num">Players</th><th>Host</th><th>Opened</th></tr></thead><tbody>' + matches.map(function (room) {
      return '<tr class="click" data-act="go" data-to="#rooms/' + esc(encodeURIComponent(room.roomId)) + '"><td>' +
        '<div class="cell-main mono">' + esc(room.roomId) + '</div><div class="chips">' + roomKindChips(room) +
          "</div></td>" +
        '<td><div class="cell-main">' + esc(room.mode) + '</div><div class="cell-sub">' + esc(room.playlist ||
          room.queue) +
        "</div></td><td>" + phaseChip(room) + (room.remaining > 0 ? '<div class="cell-sub">' +
        fmtDuration(room.remaining) + " left</div>" : "") + '</td><td class="num"><b>' + fmtNum(room.humans) + "</b>" +
        (room.bots ? " + " + fmtNum(room.bots) + " bots" : "") + ' <span class="cell-sub">/ ' +
          fmtNum(room.maxClients) +
        "</span></td><td>" + esc(room.hostName || "-") + "</td><td>" + fmtAgo(room.openedAt) + "</td></tr>";
    }).join("") + "</tbody></table></div>" : emptyHtml("No match rooms are open.");
  var squadTable = squads.length ? '<div class="table-wrap"><table><thead><tr><th>Party</th><th>Leader</th>' +
    '<th>Members</th><th>Status</th></tr></thead><tbody>' + squads.map(function (squad) {
      return '<tr class="click" data-act="go" data-to="#rooms/' + esc(encodeURIComponent(squad.roomId)) +
        '"><td class="mono">' +
        esc(squad.roomId) + "</td><td>" + esc(squad.leaderName || "-") + "</td><td>" + (squad.members ||
          []).map(function (member) {
          return esc(member.name);
        }).join(", ") + ' <span class="cell-sub">(' + fmtNum(squad.size) + "/" + fmtNum(squad.maxMembers) +
          ")</span></td><td>" +
        (squad.status === "searching" ? chip("Searching", "gold") : chip("In menu")) + "</td></tr>";
    }).join("") + "</tbody></table></div>" : emptyHtml("No parties are open.");
  content().innerHTML = head + tiles +
    '<div class="panel"><div class="panel-head"><h2>Matches</h2><span class="hint">' +
    plural(matches.length, "room") + "</span></div>" + matchTable +
      '</div><div class="panel"><div class="panel-head">' +
    "<h2>Parties</h2><span class=\"hint\">" + plural(squads.length, "party", "parties") + "</span></div>" +
    squadTable + "</div>";
}

async function roomView(roomId) {
  content().innerHTML = pageHead("Room", "", "", crumbHtml("Rooms", "#rooms")) + loadingHtml();
  await renderRoom(roomId);
  every(4000, function () { return renderRoom(roomId); });
}
async function renderRoom(roomId) {
  var data;
  try {
    data = await api("/live/rooms/" + encodeURIComponent(roomId));
  } catch (error) {
    stopTimers();
    content().innerHTML = pageHead("Room " + roomId, "", "", crumbHtml("Rooms", "#rooms")) +
      '<div class="panel">' + emptyHtml(error.message + " The room may have closed.") + "</div>";
    return;
  }
  if (parseRoute().id !== roomId) return;
  if (data.kind === "squad") return renderSquad(data.room);
  var room = data.room;
  var players = data.players || [];
  var head = pageHead(room.mode + " · " + (room.playlist || room.queue || "match"),
    '<span class="mono">' + esc(room.roomId) + "</span> · " + roomKindChips(room),
    '<button class="btn" data-act="roomNotice" data-room="' + esc(room.roomId) + '">' + icon("megaphone", 16) +
    "Send notice</button>" + '<button class="btn danger" data-act="roomClose" data-room="' + esc(room.roomId) + '">' +
    "Close match</button>", crumbHtml("Rooms", "#rooms"));
  var summary = '<div class="panel"><div class="panel-head"><h2>Match</h2>' + phaseChip(room) +
    '</div><div class="panel-body">' +
    '<dl class="kv"><dt>Players</dt><dd>' + fmtNum(room.humans) + " + " + plural(room.bots, "bot") + " / " +
    fmtNum(room.maxClients) + "</dd><dt>Queue</dt><dd>" + esc(room.queue || "-") + "</dd><dt>Time left</dt><dd>" +
    (room.remaining > 0 ? fmtDuration(room.remaining) : "-") + "</dd><dt>Host</dt><dd>" + esc(room.hostName || "-") +
    "</dd><dt>Opened</dt><dd>" + fmtDate(room.openedAt) + "</dd></dl></div></div>";
  var table = '<div class="panel"><div class="panel-head"><h2>Players</h2><span class="hint">' + plural(players.length,
    "runner") +
    '</span></div><div class="table-wrap"><table><thead><tr><th>Runner</th><th>Account</th><th>Team</th>' +
      '<th>Status</th>' +
    '<th class="num">Score</th><th></th></tr></thead><tbody>' + players.map(function (player) {
      return "<tr><td><div class=\"cell-main\">" + esc(player.name) + '</div><div class="chips">' +
        (player.bot ? chip("Bot") : "") + (player.host ? chip("Host", "violet") : "") +
        (!player.bot && !player.connected ? chip("Reconnecting", "orange") : "") + (player.ready ? chip("Ready",
          "green") : "") +
        "</div></td><td>" + (player.bot ? "-" : accountCell(player.accountId, player.accountId ? "Open player" : "")) +
        "</td><td>" + esc(player.team || "-") + "</td><td>" + esc(player.status) + '</td><td class="num">' +
        fmtNum(Math.round((num(player.totalScore) + num(player.score)) * 100) / 100) + "</td><td>" + (player.bot ? "" :
        '<button class="btn small" data-act="roomKick" data-room="' + esc(room.roomId) + '" data-session="' +
        esc(player.sessionId) + '" data-name="' + esc(player.name) + '">Kick</button>') + "</td></tr>";
    }).join("") + "</tbody></table></div></div>";
  content().innerHTML = head + '<div class="grid2 top" style="grid-template-columns:minmax(0,1fr) minmax(0,2fr)">' +
    summary +
    table + "</div>" + chatPanel("Room chat", data.chat || [], false);
}
function renderSquad(squad) {
  content().innerHTML = pageHead("Party of " + (squad.leaderName || "?"), '<span class="mono">' + esc(squad.roomId) +
    "</span>", "", crumbHtml("Rooms", "#rooms")) + '<div class="panel"><div class="panel-head"><h2>Members</h2>' +
    (squad.status === "searching" ? chip("Searching", "gold") : chip("In menu")) +
      '</div><div class="table-wrap"><table>' +
    "<thead><tr><th>Member</th><th></th></tr></thead><tbody>" + (squad.members || []).map(function (member) {
      return "<tr><td>" + accountCell(member.accountId, member.name) + '</td><td><button class="btn small" ' +
        'data-act="playerKick" data-id="' + esc(member.accountId) + '" data-name="' + esc(member.name) +
          '">Kick</button></td></tr>';
    }).join("") + "</tbody></table></div></div>";
}
actions.roomNotice = async function (element) {
  var values = await dialog({ title: "Notice to this room", fields: [
    { name: "message", label: "Message", type: "textarea", maxlength: 180 }], confirm: "Send" });
  if (!values || !values.message) return;
  var result = await post("/live/rooms/" + encodeURIComponent(element.dataset.room) + "/notice",
    { message: values.message });
  toast("Sent to " + plural(result.recipients, "player") + ".", "ok");
};
actions.roomClose = async function (element) {
  var values = await dialog({ title: "Close this match", danger: true, confirm: "Close match",
    text: "Every player is sent back to the menu. Nobody is rewarded for an unfinished match.",
    fields: [{ name: "message", label: "Message shown to players", maxlength: 180,
      value: "This match was closed by a moderator." }] });
  if (!values) return;
  await post("/live/rooms/" + encodeURIComponent(element.dataset.room) + "/close", { message: values.message });
  toast("Match closed.", "ok");
  go("#rooms");
};
actions.roomKick = async function (element) {
  var values = await dialog({ title: "Kick " + element.dataset.name, danger: true, confirm: "Kick",
    text: "The player leaves this match and cannot rejoin it.",
    fields: [{ name: "message", label: "Message", maxlength: 180, value: "Removed by a moderator." }] });
  if (!values) return;
  await post("/live/rooms/" + encodeURIComponent(element.dataset.room) + "/kick",
    { sessionId: element.dataset.session, message: values.message });
  toast(element.dataset.name + " was removed.", "ok");
  route();
};

// ── Chat ────────────────────────────────────────────────────────────
function chatLineHtml(line, withRoom) {
  return '<div class="chat-line"><time title="' + esc(fmtDate(line.at)) + '">' + fmtTime(line.at) + '</time><div>' +
    '<span class="who">' + (line.accountId ? '<a href="#players/' + encodeURIComponent(line.accountId) + '">' +
      esc(line.name) +
    "</a>" : esc(line.name)) + '</span><span class="text">' + esc(line.text) + "</span>" + (withRoom ?
      '<div class="cell-sub">' +
    '<a href="#rooms/' + encodeURIComponent(line.roomId) + '" class="mono">' + esc(line.roomId) + "</a></div>" : "") +
    '</div><div class="acts">' + (line.accountId ? '<button class="btn small" data-act="playerMute" data-id="' +
    esc(line.accountId) + '" data-name="' + esc(line.name) + '">Mute</button>' : "") + '<button class="btn small" ' +
    'data-act="roomKick" data-room="' + esc(line.roomId) + '" data-session="' + esc(line.sessionId) + '" data-name="' +
    esc(line.name) + '">Kick</button></div></div>';
}
function chatPanel(title, lines, withRoom) {
  return '<div class="panel"><div class="panel-head"><h2>' + esc(title) + '</h2><span class="hint">' +
    plural(lines.length, "message") + ", newest first</span></div>" + (lines.length ? lines.map(function (line) {
      return chatLineHtml(line, withRoom);
    }).join("") : emptyHtml("No chat yet.")) + "</div>";
}
state.chat = { q: "", paused: false };
views.chat = async function () {
  content().innerHTML = pageHead("Chat", "Match chat on this server process, kept in memory") + loadingHtml();
  await renderChat(true);
  every(5000, function () { return state.chat.paused ? null : renderChat(false); });
};
async function renderChat(full) {
  var data = await api("/live/chat" + queryString({ q: state.chat.q, limit: 200 }));
  if (parseRoute().view !== "chat") return;
  var lines = data.lines || [];
  if (full || !byId("chatLines")) {
    content().innerHTML = pageHead("Chat", "Match chat on this server process, kept in memory (not stored on disk)",
      '<button class="btn" data-act="chatPause">' + (state.chat.paused ? "Resume" : "Pause") + "</button>") +
      '<div class="panel"><div class="toolbar">' + searchRow("chatFilter", "Filter by text or name", state.chat.q) +
        "</div>" +
      '<div id="chatLines"></div></div>';
  }
  byId("chatLines").innerHTML = lines.length ? lines.map(function (line) { return chatLineHtml(line, true); }).join("")
    : emptyHtml(state.chat.q ? "No messages match." : "Nobody has chatted since the server started.");
}
state.chatFilter = { q: "", page: 1 };
loaders.chatFilter = function () { state.chat.q = state.chatFilter.q; return renderChat(false).catch(fail); };
actions.chatPause = function (element) {
  state.chat.paused = !state.chat.paused;
  element.textContent = state.chat.paused ? "Resume" : "Pause";
};
`;
