// GM console client, part 2: Overview (live numbers, activity, server controls) and Content (the running catalog).
export const SCRIPT_OVERVIEW = String.raw`
function kpi(label, value, foot, accent) {
  return '<div class="panel kpi" style="--accent:' + (accent || "var(--violet)") + '"><div class="label">' +
    esc(label) +
    '</div><div class="value">' + value + '</div><div class="foot">' + (foot || "&nbsp;") + "</div></div>";
}
function serviceTone(status) {
  return status.draining ? ["bad", "Draining"] : status.maintenance ? ["warn", "Maintenance"]
    : status.admissionsOpen ? ["ok", "Online"] : ["bad", "Unavailable"];
}

views.overview = async function () {
  content().innerHTML = pageHead("Overview", "Players, matches and the server right now", "") + loadingHtml();
  await renderOverview();
  every(20000, renderOverview);
};
async function renderOverview() {
  var data = await api("/overview");
  if (parseRoute().view !== "overview" && window.location.hash) return;
  var service = data.service || {};
  var accounts = data.accounts || {};
  var economy = data.economy || {};
  var tone = serviceTone(service);
  state.status = service;
  renderTopStatus();
  setReportsBadge(data.reports ? data.reports.open : null);
  var head = pageHead("Overview", "Players, matches and the server right now",
    '<button class="btn" data-act="broadcast">' + icon("megaphone", 16) + "Broadcast</button>" +
    '<button class="btn" data-act="maintenance" data-enabled="' + (service.maintenance ? "0" : "1") + '">' +
    icon("wrench", 16) + (service.maintenance ? "End maintenance" : "Maintenance") + "</button>" +
    '<button class="btn ghost" data-act="reload" title="Refresh">' + icon("refresh", 16) + "</button>");
  var banner = service.draining
    ? '<div class="notice red"><b>Draining.</b>&nbsp;New matches are refused until the server restarts. ' +
      esc(service.message || "") + "</div>"
    : service.maintenance
      ? '<div class="notice"><b>Maintenance.</b>&nbsp;New matches are refused; running matches continue. ' +
        esc(service.message || "") + "</div>" : "";
  var tiles = '<div class="kpis">' +
    kpi("Players online", fmtNum(service.connectedClients), plural(service.reservedSeats || 0, "seat") + " on hold",
      "var(--green)") +
    kpi("Live matches", fmtNum(service.runningMatches), plural(service.rooms || 0, "room") + " open") +
    kpi("Parties", fmtNum(service.squads), plural(service.partyMembers || 0, "member")) +
    kpi("Searching", fmtNum(service.searching), "in matchmaking queues", "var(--cyan)") +
    kpi("Accounts", fmtNum(accounts.total), plural(accounts.guests, "guest") + " · " + fmtNum(accounts.registered) +
      " registered") +
    kpi("New accounts", fmtNum(accounts.new24h), fmtNum(accounts.new7d) + " in 7 days", "var(--sky)") +
    kpi("Active players", fmtNum(accounts.active24h), fmtNum(accounts.active7d) + " in 7 days", "var(--sky)") +
    kpi("Open reports", fmtNum(data.reports ? data.reports.open : 0),
      '<a href="#reports" style="color:inherit">Review reports</a>', "var(--red)") +
    kpi("Stars held", fmtNum(economy.stars), fmtNum(economy.shards) + " shards · " + plural(economy.wallets || 0,
      "wallet"),
      "var(--gold)") +
    kpi("Sanctions", fmtNum(accounts.banned), fmtNum(accounts.muted) + " muted", "var(--orange)") +
    "</div>";
  var activity = data.activity || { days: [], newAccounts: [], players: [], matches: [] };
  var series = [
    { name: "Players who played", color: "#6b55f0", values: activity.players || [], area: true },
    { name: "Matches played", color: "#ffad1f", values: activity.matches || [] },
    { name: "New accounts", color: "#2fa84a", values: activity.newAccounts || [] }
  ];
  var season = data.season;
  var premium = economy.premium;
  var server = '<div class="panel"><div class="panel-head"><h2>Server</h2>' + statusDot(tone[0], tone[1]) + "</div>" +
    '<div class="panel-body"><dl class="kv">' +
    "<dt>Revision</dt><dd class=\"mono\">" + esc(service.revision) + "</dd>" +
    "<dt>Protocol</dt><dd>" + esc(service.protocol) + "</dd>" +
    "<dt>Uptime</dt><dd>" + fmtDuration(service.uptimeSeconds) + "</dd>" +
    "<dt>Memory</dt><dd>" + fmtBytes(service.residentBytes) + "</dd>" +
    "<dt>Server time</dt><dd>" + fmtDate(service.serverTime) + "</dd>" +
    "<dt>Season</dt><dd>" + (season ? esc(season.id) + ' <span class="cell-sub">ends ' + fmtDate(season.endsAt) +
      "</span>" : "None running") + "</dd>" +
    "<dt>Premium pass</dt><dd>" + (premium ? plural(premium.owners, "owner") : "-") + "</dd>" +
    (service.message ? "<dt>Message</dt><dd>" + esc(service.message) + "</dd>" : "") +
    '</dl><div class="btn-row" style="margin-top:16px">' +
    '<button class="btn" data-act="go" data-to="#rooms">' + icon("rooms", 16) + "Live rooms</button>" +
    '<button class="btn danger" data-act="drain"' + (service.draining ? " disabled" : "") + ">" + icon("power", 16) +
    "Drain for restart</button></div></div></div>";
  var chart = '<div class="panel"><div class="panel-head"><h2>Last 14 days</h2><span class="hint">UTC days</span>' +
    '</div>' +
    '<div class="chart" id="activityChart"></div>' + legendHtml(series) + "</div>";
  content().innerHTML = head + banner + tiles + '<div class="grid2">' + chart + server + "</div>";
  drawChart(byId("activityChart"), { labels: (activity.days || []).map(fmtDay), series: series });
}
actions.broadcast = async function () {
  var values = await dialog({
    title: "Broadcast a message",
    text: "Every player in a match or a party sees it now, as a notice.",
    fields: [{ name: "message", label: "Message", type: "textarea", maxlength: 180,
      placeholder: "Server restart in 10 minutes" }],
    confirm: "Send"
  });
  if (!values || !values.message) return;
  var result = await post("/live/broadcast", { message: values.message });
  toast("Sent to " + plural(result.recipients, "player") + " in " + plural(result.rooms, "room") + ".", "ok");
};
actions.maintenance = async function (element) {
  var enable = element.dataset.enabled === "1";
  var values = await dialog(enable ? {
    title: "Start maintenance",
    text: "New matches and sign-ins to rooms are refused; matches already running finish normally.",
    fields: [{ name: "message", label: "Message shown to players", maxlength: 180, placeholder: "Back in 15 minutes" }],
    confirm: "Start maintenance", danger: true
  } : { title: "End maintenance", text: "Players can start matches again.", confirm: "End maintenance" });
  if (!values) return;
  await post("/live/maintenance", { enabled: enable, message: values === true ? "" : values.message });
  toast(enable ? "Maintenance started." : "Maintenance ended.", "ok");
  refreshStatus();
  route();
};
actions.drain = async function () {
  var values = await dialog({
    title: "Drain for restart",
    text: "The server stops accepting new matches until it restarts. Running matches finish. This cannot be undone " +
      "from the console: restart the server process afterwards.",
    fields: [{ name: "message", label: "Message shown to players", maxlength: 180, value: "Server restarting soon." }],
    confirm: "Drain", danger: true
  });
  if (!values) return;
  await post("/live/drain", { message: values.message });
  toast("Draining. Restart the server when the matches end.", "warn");
  route();
};

// ── Content ─────────────────────────────────────────────────────────
function listPanel(title, rows, columns, hint) {
  if (!rows || !rows.length) return "";
  return '<div class="panel"><div class="panel-head"><h2>' + esc(title) + '</h2><span class="hint">' +
    esc(hint || plural(rows.length, "entry")) + '</span></div><div class="table-wrap"><table><thead><tr>' +
    columns.map(function (column) { return "<th" + (column.numeric ? ' class="num"' : "") + ">" + esc(column.label) +
      "</th>"; })
      .join("") + "</tr></thead><tbody>" + rows.map(function (row) {
      return "<tr>" + columns.map(function (column) {
        return "<td" + (column.numeric ? ' class="num"' : "") + ">" + column.render(row) + "</td>";
      }).join("") + "</tr>";
    }).join("") + "</tbody></table></div></div>";
}
function field(name) { return function (row) { return esc(row[name] === undefined || row[name] === null ? "-" :
  row[name]); }; }
function idCell(row) {
  return '<div class="cell-main">' + esc(row.name || row.title || row.id) + '</div><div class="cell-sub mono">' +
    esc(row.id) +
    "</div>";
}
function windowCell(row) { return fmtDate(row.startsAt) + " – " + fmtDate(row.endsAt); }
function runningCell(row) { return row.running ? chip("Running", "green") : chip("Scheduled"); }

views.content = async function () {
  content().innerHTML = pageHead("Content", "What this server is running") + loadingHtml();
  state.catalog = null;
  var catalog = await loadCatalog();
  if (!catalog) throw new Error("The catalog could not be loaded.");
  var head = pageHead("Content", "Revision <span class=\"mono\">" + esc(catalog.revision) + "</span> · protocol " +
    esc(catalog.protocol) + " · edit in Unity, then Tools > Casual Party > Export to Server and restart");
  var economy = '<div class="kpis">' +
    kpi("Starting Stars", fmtNum(catalog.initialCredits), "for a new account", "var(--gold)") +
    kpi("Daily Stars", fmtNum(catalog.dailyCredits), "daily reward", "var(--gold)") +
    kpi("Starter", esc(characterName(catalog.starterId)), esc(catalog.starterId)) +
    kpi("Characters", fmtNum((catalog.characters || []).length), plural((catalog.banners || []).length, "banner")) +
    "</div>";
  content().innerHTML = head + economy + '<div class="stack">' +
    listPanel("Characters", catalog.characters, [
      { label: "Character", render: idCell },
      { label: "Rarity", render: function (row) { return rarityChip(row.rarity); } },
      { label: "Craft cost", numeric: true, render: field("craftCost") },
      { label: "Duplicate shards", numeric: true, render: field("duplicateShards") }
    ]) +
    listPanel("Banners", catalog.banners, [
      { label: "Banner", render: idCell },
      { label: "One draw", numeric: true, render: field("cost") },
      { label: "Ten draws", numeric: true, render: field("tenCost") }
    ]) +
    listPanel("Seasons", catalog.seasons, [
      { label: "Season", render: idCell },
      { label: "Window", render: windowCell },
      { label: "Tiers", numeric: true, render: field("tiers") },
      { label: "Premium", render: function (row) {
        return row.premiumCost ? fmtNum(row.premiumCost) + " " + esc(row.premiumCurrency || "") : "Free"; } },
      { label: "", render: runningCell }
    ]) +
    listPanel("Events", catalog.events, [
      { label: "Event", render: idCell },
      { label: "Queue", render: field("queue") },
      { label: "Plays", render: function (row) { return esc(row.playlist || row.courseId || "-"); } },
      { label: "Window", render: function (row) {
        return windowCell(row) + (row.repeatDays ? ' <span class="cell-sub">every ' + plural(row.repeatDays, "day") +
          "</span>" : ""); } },
      { label: "", render: runningCell }
    ]) +
    listPanel("Matchmaking queues", catalog.queues, [
      { label: "Queue", render: idCell },
      { label: "Mode", render: field("mode") }
    ]) +
    listPanel("Missions and achievements", catalog.goals, [
      { label: "Goal", render: idCell },
      { label: "Scope", render: field("scope") },
      { label: "Metric", render: field("metric") },
      { label: "Target", numeric: true, render: field("target") },
      { label: "Stars", numeric: true, render: field("credits") },
      { label: "XP", numeric: true, render: field("xp") },
      { label: "Pass XP", numeric: true, render: field("passXp") }
    ]) +
    '<div class="grid3">' +
    chipPanel("Modes", catalog.modes) + chipPanel("Playlists", catalog.playlists) + chipPanel("Courses",
      catalog.courses) +
    "</div></div>";
};
function chipPanel(title, rows) {
  return '<div class="panel"><div class="panel-head"><h2>' + esc(title) + '</h2><span class="hint">' +
    fmtNum((rows || []).length) + '</span></div><div class="panel-body chips">' + (rows || []).map(function (row) {
      return chip(row.name || row.title || row.id, "violet");
    }).join("") + "</div></div>";
}
function rarityChip(rarity) {
  var tone = { common: "", rare: "violet", epic: "violet", legendary: "gold" }[rarity] || "";
  return '<span class="rarity-' + esc(rarity) + '"><span class="rarity-dot"></span></span>' + chip(rarity || "-", tone);
}
`;
