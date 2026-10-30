// GM console client, part 5: player reports (queue, one report, resolving) and the active bans and mutes.
export const SCRIPT_MODERATION = String.raw`
var REASONS = { cheating: "Cheating", abuse: "Abusive chat", name: "Offensive name", other: "Other" };
var RESOLUTIONS = { none: "No action", warn: "Warned", mute: "Muted", kick: "Kicked", ban: "Banned" };
state.reports = { filter: "open", target: "", targetName: "", page: 1, pageSize: 50 };

function reasonChip(reason) {
  return chip(REASONS[reason] || reason, reason === "cheating" ? "red" : reason === "abuse" ? "orange" : "violet");
}
function reportStatus(report) {
  if (report.status === "open") return chip("Open", "gold");
  if (report.status === "dismissed") return chip("Dismissed");
  return chip(RESOLUTIONS[report.resolution] || "Resolved", report.resolution === "ban" ? "red" : "green");
}
function reportsTable(reports) {
  return '<div class="table-wrap"><table><thead><tr><th>Reported player</th><th>Reason</th><th>Details</th>' +
    "<th>Reporter</th><th>Filed</th><th>Status</th></tr></thead><tbody>" + reports.map(function (report) {
      var others = num(report.targetOpenReports) - (report.status === "open" ? 1 : 0);
      return '<tr class="click" data-act="go" data-to="#reports/' + esc(encodeURIComponent(report.id)) + '"><td>' +
        '<div class="cell-main">' + esc(playerLabel(report.target)) + '</div><div class="cell-sub">' +
        (report.target ? "@" + esc(report.target.username) : "") + (others > 0 ? " · " + plural(others,
          "other open report") : "") +
        "</div></td><td>" + reasonChip(report.reason) + "</td><td>" + esc(report.details ? report.details.slice(0,
          90) : "-") +
        (report.evidenceCount ? '<div class="cell-sub">' + plural(report.evidenceCount, "chat line") + "</div>" : "") +
        "</td><td>" + esc(playerLabel(report.reporter)) + "</td><td>" + fmtAgo(report.createdAt) + "</td><td>" +
        reportStatus(report) + "</td></tr>";
    }).join("") + "</tbody></table></div>";
}

views.reports = async function (current) {
  if (current.id) return reportView(current.id);
  var list = state.reports;
  content().innerHTML = pageHead("Reports", "What players reported, newest first") + '<div class="panel">' +
    '<div class="toolbar" id="reportsTabs"></div><div id="reportsTable">' + loadingHtml() + "</div></div>";
  await loaders.reports();
  every(20000, function () { return list.filter === "open" ? loaders.reports() : null; });
};
loaders.reports = async function () {
  var list = state.reports;
  var target = byId("reportsTable");
  if (!target) return;
  try {
    var data = await api("/reports" + queryString({ status: list.filter, target: list.target, page: list.page,
      pageSize: list.pageSize }));
    setReportsBadge(data.open);
    byId("reportsTabs").innerHTML = tabsHtml([
      { id: "open", label: "Open", count: data.open }, { id: "resolved", label: "Resolved" },
      { id: "dismissed", label: "Dismissed" }, { id: "all", label: "All" }
    ], list.filter, "filterTab", "reports") + (list.target ? '<span class="chip violet">About ' + esc(list.targetName ||
      shortId(list.target)) +
        '</span><button class="btn small ghost" data-act="reportsClearTarget">Show everyone</button>' : "");
    var reports = data.reports || [];
    target.innerHTML = reports.length ? reportsTable(reports) + pagerHtml(list, data.total, "reports")
      : emptyHtml(list.filter === "open" ? "No open reports. Nice." : "No reports in this list.");
  } catch (error) {
    target.innerHTML = errorHtml(error.message);
  }
};
actions.reportsFor = function (element) {
  var player = state.player && state.player.player;
  state.reports.target = element.dataset.id;
  state.reports.targetName = player && player.id === element.dataset.id ? playerLabel(player) : "";
  state.reports.filter = "all";
  state.reports.page = 1;
  go("#reports");
};
actions.reportsClearTarget = function () {
  state.reports.target = "";
  state.reports.targetName = "";
  state.reports.page = 1;
  loaders.reports();
};

async function reportView(id) {
  content().innerHTML = pageHead("Report", "", "", crumbHtml("Reports", "#reports")) + loadingHtml();
  var data = await api("/reports/" + encodeURIComponent(id));
  var report = data.report;
  var open = report.status === "open";
  var targetLink = report.target ? '<a href="#players/' + encodeURIComponent(report.target.id) + '">' +
    esc(playerLabel(report.target)) + "</a> @" + esc(report.target.username) : "Unknown";
  var head = pageHead("Report about " + playerLabel(report.target), reasonChip(report.reason) + " " +
    reportStatus(report) +
    ' · filed ' + fmtAgo(report.createdAt), open ? '<button class="btn" data-act="reportDismiss" data-id="' +
      esc(report.id) +
    '">Dismiss</button><button class="btn primary" data-act="reportResolve" data-id="' + esc(report.id) +
      '" data-name="' +
    esc(playerLabel(report.target)) + '" data-others="' + esc(Math.max(0, num(report.targetOpenReports) - 1)) +
    '">Resolve</button>' : "", crumbHtml("Reports", "#reports"));
  var details = '<div class="panel"><div class="panel-head"><h2>Report</h2></div><div class="panel-body">' + kvRows([
    ["Reported player", targetLink],
    ["Reason", reasonChip(report.reason)],
    ["Details", esc(report.details || "-")],
    ["Reporter", report.reporter ? '<a href="#players/' + encodeURIComponent(report.reporter.id) + '">' +
      esc(playerLabel(report.reporter)) + "</a>" : "Unknown"],
    ["Filed", fmtDate(report.createdAt)],
    ["Match room", report.roomId ? '<span class="mono">' + esc(report.roomId) + "</span>" : "-"],
    ["Open reports about them", fmtNum(report.targetOpenReports)]
  ]) + (open ? "" : '<hr style="border:0;border-top:1px solid var(--line);margin:14px 0">' + kvRows([
    ["Outcome", reportStatus(report)],
    ["Handled by", esc(report.handledBy || "-") + ' <span class="cell-sub">' + fmtDate(report.handledAt) + "</span>"],
    ["Note", esc(report.note || "-")]
  ])) + "</div></div>";
  var evidence = report.evidence || [];
  var chat = '<div class="panel"><div class="panel-head"><h2>Chat on record</h2><span class="hint">the reported ' +
    'player\'s ' +
    "lines when the report was filed</span></div>" + (evidence.length ? '<div class="evidence">' +
      evidence.map(function (line) {
      return '<div class="chat-line" style="grid-template-columns:120px minmax(0,1fr)"><time>' + esc(fmtDate(line.at)) +
        '</time><div><span class="who">' + esc(line.name) + '</span><span class="text">' + esc(line.text) +
          "</span></div></div>";
    }).join("") + "</div>" : emptyHtml("No chat was on record.")) + "</div>";
  content().innerHTML = head + '<div class="grid2">' + details + chat + "</div>";
}
actions.reportResolve = async function (element) {
  var others = num(element.dataset.others);
  var values = await dialog({ title: "Resolve the report about " + element.dataset.name, confirm: "Resolve",
    fields: [
      { name: "action", label: "Action", type: "select", value: "warn", options: [
        ["none", "No action (the report was right, nothing to do now)"], ["warn", "Warn the player"],
        ["mute", "Mute chat"], ["kick", "Kick from matches"], ["ban", "Ban"]] },
      { name: "minutes", label: "Duration (mute or ban)", type: "select", value: "1440",
        options: DURATIONS.concat([["0", "Permanent (ban only)"]]) },
      { name: "note", label: "Note for the record", maxlength: 280 },
      { name: "allForTarget", label: "Also close the " + plural(others, "other open report") + " about this player",
        type: "checkbox", value: others > 0 }
    ] });
  if (!values) return;
  var minutes = Number(values.minutes) || null;
  if (values.action === "mute" && !minutes) { toast("A mute needs a duration.", "bad"); return; }
  var result = await post("/reports/" + encodeURIComponent(element.dataset.id) + "/resolve", {
    action: values.action, minutes: values.action === "mute" || values.action === "ban" ? minutes : undefined,
    note: values.note, allForTarget: values.allForTarget });
  toast(plural(result.resolved, "report") + " resolved.", "ok");
  refreshStatus();
  route();
};
actions.reportDismiss = async function (element) {
  var values = await dialog({ title: "Dismiss report", text: "Nothing happens to the reported player.",
    confirm: "Dismiss",
    fields: [{ name: "note", label: "Note for the record", maxlength: 280 }] });
  if (!values) return;
  await post("/reports/" + encodeURIComponent(element.dataset.id) + "/dismiss", { note: values.note });
  toast("Report dismissed.", "ok");
  refreshStatus();
  route();
};

// ── Bans and mutes ──────────────────────────────────────────────────
state.sanctions = { filter: "bans", page: 1, pageSize: 50 };
views.sanctions = async function () {
  content().innerHTML = pageHead("Bans & mutes", "Sanctions in force right now") + '<div class="panel">' +
    '<div class="toolbar" id="sanctionsTabs"></div><div id="sanctionsTable">' + loadingHtml() + "</div></div>";
  await loaders.sanctions();
};
loaders.sanctions = async function () {
  var list = state.sanctions;
  var target = byId("sanctionsTable");
  if (!target) return;
  byId("sanctionsTabs").innerHTML = tabsHtml([{ id: "bans", label: "Bans" }, { id: "mutes", label: "Chat mutes" }],
    list.filter, "filterTab", "sanctions");
  try {
    var data = await api("/moderation/" + list.filter + queryString({ page: list.page, pageSize: list.pageSize }));
    var entries = data.entries || [];
    var bans = list.filter === "bans";
    target.innerHTML = entries.length ?
      '<div class="table-wrap"><table><thead><tr><th>Player</th><th>Reason</th><th>Ends</th>' +
      "<th>By</th><th></th></tr></thead><tbody>" + entries.map(function (entry) {
        return '<tr><td><a href="#players/' + encodeURIComponent(entry.player.id) + '" class="cell-main">' +
          esc(playerLabel(entry.player)) + '</a><div class="cell-sub">@' + esc(entry.player.username) +
            "</div></td><td>" +
          esc(entry.reason || "-") + "</td><td>" + esc(fmtUntil(entry.until)) + "</td><td>" + esc(entry.createdBy ||
            "-") +
          '<div class="cell-sub">' + fmtDate(entry.createdAt) + '</div></td><td><button class="btn small" data-act="' +
          (bans ? "playerUnban" : "playerUnmute") + '" data-id="' + esc(entry.player.id) + '">' + (bans ? "Unban" :
            "Unmute") +
          "</button></td></tr>";
      }).join("") + "</tbody></table></div>" + pagerHtml(list, data.total, "sanctions")
      : emptyHtml(bans ? "Nobody is banned." : "Nobody is muted.");
  } catch (error) {
    target.innerHTML = errorHtml(error.message);
  }
};
`;
