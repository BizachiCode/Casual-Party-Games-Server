// GM console client, part 6: bulk grants, leaderboards and the audit log.
export const SCRIPT_TOOLS = String.raw`
// ── Grants ──────────────────────────────────────────────────────────
// One request id per grant: a retry after a lost answer reuses it, so the server pays once. A new id is made only
// after a grant succeeded.
state.grant = { requestId: newRequestId(), results: null };
views.grants = async function () {
  var catalog = await loadCatalog();
  var characters = catalog && catalog.characters ? catalog.characters : [];
  content().innerHTML = pageHead("Grants",
    "Give Stars, shards, characters or battle pass XP to up to 100 players at once") +
    '<div class="grid2"><div class="panel"><div class="panel-head"><h2>New grant</h2></div><div class="panel-body">' +
    '<form id="grantForm" class="form" autocomplete="off">' +
    fieldHtml({ name: "targets", label: "Players", type: "textarea", maxlength: 8000,
      placeholder: "One username or account id per line", hint: "Commas and spaces also separate players." }) +
    '<div class="form two">' + fieldHtml({ name: "stars", label: "Stars", type: "number", min: 0 }) +
    fieldHtml({ name: "shards", label: "Shards", type: "number", min: 0 }) +
    fieldHtml({ name: "passXp", label: "Battle pass XP", type: "number", min: 0 }) +
    fieldHtml({ name: "characterId", label: "Character", type: "select", value: "",
      options: [["", "None"]].concat(characters.map(function (character) {
        return [character.id, character.name + " (" + character.rarity + ")"];
      })) }) + "</div>" +
    fieldHtml({ name: "note", label: "Note for the audit log", maxlength: 140,
      placeholder: "Compensation for the outage" }) +
    '<div class="btn-row"><button type="submit" class="btn primary">' + icon("grants", 16) +
      "Grant</button></div></form>" +
    '</div></div><div class="panel"><div class="panel-head"><h2>Result</h2></div><div id="grantResults">' +
    (state.grant.results ? grantResultsHtml(state.grant.results) : emptyHtml("Results appear here.")) +
      "</div></div></div>";
  byId("grantForm").addEventListener("submit", function (event) {
    event.preventDefault();
    submitGrant(event.target).catch(fail);
  });
};
function grantResultsHtml(results) {
  var good = results.filter(function (result) { return result.ok; }).length;
  return '<div class="toolbar">' + chip(good + " granted", "green") + (results.length - good ?
    chip((results.length - good) +
    " failed", "red") : "") +
      '</div><div class="table-wrap"><table><thead><tr><th>Player</th><th>Result</th></tr></thead>' +
    "<tbody>" + results.map(function (result) {
      return "<tr><td>" + (result.id ? '<a href="#players/' + encodeURIComponent(result.id) + '">' +
        esc(result.name || result.target) + "</a>" : esc(result.target)) + "</td><td>" + (result.ok ?
          chip(result.duplicate ?
        "Already granted" : "Granted", "green") : chip("Failed", "red") + ' <span class="cell-sub">' +
          esc(result.error || "") +
        "</span>") + "</td></tr>";
    }).join("") + "</tbody></table></div>";
}
async function submitGrant(form) {
  var targets = form.elements.targets.value.split(/[\s,;]+/).map(function (target) { return target.trim(); })
    .filter(Boolean);
  var body = { targets: targets, requestId: state.grant.requestId, note: form.elements.note.value.trim() };
  ["stars", "shards", "passXp"].forEach(function (name) {
    var amount = Number(form.elements[name].value);
    if (amount > 0) body[name] = amount;
  });
  if (form.elements.characterId.value) body.characterId = form.elements.characterId.value;
  if (!targets.length) { toast("Add at least one player.", "bad"); return; }
  if (!body.stars && !body.shards && !body.passXp && !body.characterId) { toast("Choose at least one reward.", "bad");
    return; }
  var summary = [body.stars ? fmtNum(body.stars) + " Stars" : "", body.shards ? fmtNum(body.shards) + " shards" : "",
    body.passXp ? fmtNum(body.passXp) + " pass XP" : "", body.characterId ? characterName(body.characterId) : ""]
    .filter(Boolean).join(", ");
  if (!(await confirmAction("Confirm grant", "Give " + summary + " to " + plural(targets.length, "player") + "?",
    "Grant",
    false))) return;
  var data = await post("/grants", body);
  state.grant = { requestId: newRequestId(), results: data.results || [] };
  byId("grantResults").innerHTML = grantResultsHtml(state.grant.results);
  form.reset();
  toast("Grant finished.", "ok");
}

// ── Leaderboards ────────────────────────────────────────────────────
state.rankings = { board: "wins", mode: "", courseId: "" };
var BOARDS = [
  { id: "wins", label: "Wins" }, { id: "points", label: "Points" }, { id: "season", label: "This month" },
  { id: "mode", label: "By mode" }, { id: "timeTrial", label: "Time trials" }, { id: "level", label: "Level" }
];
views.rankings = async function () {
  content().innerHTML = pageHead("Leaderboards", "The boards players see; open a player to reset their rows") +
    '<div class="panel"><div class="toolbar" id="rankingFilters"></div><div id="rankingTable">' + loadingHtml() +
    "</div></div>";
  await loadCatalog();
  await loaders.rankings();
};
function rankingColumns(board) {
  if (board === "timeTrial") return [["Time", function (row) { return num(row.seconds).toFixed(2) + " s"; }]];
  if (board === "level") return [["Score", function (row) { return fmtNum(row.score); }]];
  return [["Wins", function (row) { return fmtNum(row.wins); }], ["Matches",
    function (row) { return fmtNum(row.matches); }],
    ["Points", function (row) { return fmtNum(Math.round(num(row.points) * 100) / 100); }]];
}
loaders.rankings = async function () {
  var list = state.rankings;
  var target = byId("rankingTable");
  if (!target) return;
  var catalog = state.catalog || {};
  var modes = (catalog.modes || []).map(function (mode) { return [mode.id, mode.name || mode.id]; });
  var courses = (catalog.courses || []).map(function (course) { return [course.id, course.name || course.id]; });
  if (list.board === "timeTrial" && !list.courseId && courses.length) list.courseId = courses[0][0];
  if (list.board === "mode" && !list.mode && modes.length) list.mode = modes[0][0];
  byId("rankingFilters").innerHTML = tabsHtml(BOARDS, list.board, "rankingBoard") +
    (list.board === "timeTrial" ? selectHtml("rankingCourse", courses, list.courseId, "Course")
      : list.board === "mode" ? selectHtml("rankingMode", modes, list.mode, "Mode") : "");
  try {
    var data = await api("/rankings" + queryString({ board: list.board,
      mode: list.board === "mode" ? list.mode : "", courseId: list.board === "timeTrial" ? list.courseId : "" }));
    var rows = data.entries || [];
    var columns = rankingColumns(list.board);
    target.innerHTML = rows.length ? '<div class="table-wrap"><table><thead><tr><th class="num">#</th><th>Player</th>' +
      columns.map(function (column) { return '<th class="num">' + column[0] + "</th>"; }).join("") +
      "</tr></thead><tbody>" + rows.map(function (row, index) {
        return '<tr class="click" data-act="go" data-to="#players/' + esc(encodeURIComponent(row.id)) +
          '/progress"><td class="num">' + fmtNum(row.rank || index + 1) + '</td><td><div class="cell-main">' +
          esc(row.displayName || row.username || row.id) + '</div><div class="cell-sub">@' + esc(row.username) +
          "</div></td>" + columns.map(function (column) { return '<td class="num">' + column[1](row) + "</td>"; })
          .join("") + "</tr>";
      }).join("") + "</tbody></table></div>" : emptyHtml("Nobody is on this board yet.");
  } catch (error) {
    target.innerHTML = errorHtml(error.message);
  }
};
function selectHtml(act, options, value, emptyLabel) {
  return '<select data-change="' + act + '"><option value="">' + esc(emptyLabel) + "</option>" +
    options.map(function (option) {
    return '<option value="' + esc(option[0]) + '"' + (option[0] === value ? " selected" : "") + ">" + esc(option[1]) +
      "</option>";
  }).join("") + "</select>";
}
actions.rankingBoard = function (element) { state.rankings.board = element.dataset.tab; loaders.rankings(); };
actions.rankingMode = function (element) { state.rankings.mode = element.value; loaders.rankings(); };
actions.rankingCourse = function (element) { state.rankings.courseId = element.value; loaders.rankings(); };

// ── Audit log ───────────────────────────────────────────────────────
state.audit = { action: "", operator: "", target: "", page: 1, pageSize: 50 };
function detailsHtml(details) {
  if (!details) return "-";
  return Object.keys(details).filter(function (name) {
    return details[name] !== null && details[name] !== undefined && details[name] !== "";
  }).map(function (name) {
    var value = details[name];
    return '<span class="chip">' + esc(name) + ": " + esc(typeof value === "object" ? JSON.stringify(value) : value) +
      "</span>";
  }).join(" ") || "-";
}
function auditTable(entries, withTarget) {
  return '<div class="table-wrap"><table><thead><tr><th>When</th><th>Operator</th><th>Action</th>' +
    (withTarget ? "<th>Player</th>" : "") + "<th>Details</th></tr></thead><tbody>" + entries.map(function (entry) {
      return "<tr><td>" + fmtDate(entry.at) + '</td><td><div class="cell-main">' + esc(entry.operator) +
        '</div><div class="cell-sub">' +
        esc(entry.address) + "</div></td><td>" + chip(entry.action, "violet") + "</td>" + (withTarget ? "<td>" +
        (entry.targetId ? '<a href="#players/' + encodeURIComponent(entry.targetId) + '">' + esc(entry.targetName ||
        shortId(entry.targetId)) + "</a>" : "-") + "</td>" : "") + '<td><div class="chips">' +
          detailsHtml(entry.details) +
        "</div></td></tr>";
    }).join("") + "</tbody></table></div>";
}
views.audit = async function () {
  content().innerHTML = pageHead("Audit log", "Every action taken from this console, newest first") +
    '<div class="panel">' +
    '<div class="toolbar" id="auditFilters"></div><div id="auditTable">' + loadingHtml() + "</div></div>";
  var filters = await api("/audit/filters");
  byId("auditFilters").innerHTML =
    selectHtml("auditAction", (filters.actions || []).map(function (name) { return [name, name]; }), state.audit.action,
      "Every action") +
    selectHtml("auditOperator", (filters.operators || []).map(function (name) { return [name, name]; }),
      state.audit.operator,
      "Every operator") +
    (state.audit.target ? chip("Player " + shortId(state.audit.target), "violet") +
      '<button class="btn small ghost" data-act="auditClearTarget">Everyone</button>' : "");
  await loaders.audit();
};
loaders.audit = async function () {
  var list = state.audit;
  var target = byId("auditTable");
  if (!target) return;
  try {
    var data = await api("/audit" + queryString({ action: list.action, operator: list.operator, target: list.target,
      page: list.page, pageSize: list.pageSize }));
    target.innerHTML = (data.entries || []).length ? auditTable(data.entries, true) + pagerHtml(list, data.total,
      "audit")
      : emptyHtml("No actions match.");
  } catch (error) {
    target.innerHTML = errorHtml(error.message);
  }
};
actions.auditAction = function (element) { state.audit.action = element.value; state.audit.page = 1; loaders.audit(); };
actions.auditOperator = function (element) { state.audit.operator = element.value; state.audit.page = 1;
  loaders.audit(); };
actions.auditClearTarget = function () { state.audit.target = ""; route(); };
`;
