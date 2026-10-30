// GM console client, part 1: helpers, API client, dialogs, toasts, tables, charts, session and router. The parts are
// joined inside one function by renderGmPanelPage(). Client code is plain browser script in String.raw: it must not
// contain backticks or dollar-brace sequences, and it builds HTML by concatenation, always through esc().
export const SCRIPT_CORE = String.raw`
var KEY_STORAGE = "casual_party_gm_key";
var OPERATOR_STORAGE = "casual_party_gm_operator";
var API_ROOT = "/api/admin";
var actions = {};   // click / change handlers by data-act
var views = {};     // view renderers by route name
var loaders = {};   // list reloaders by data-scope
var state = { catalog: null, status: null, timer: 0, authorized: false, reportsOpen: null };

function byId(id) { return document.getElementById(id); }
function esc(value) {
  return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, function (character) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
  });
}
function readStorage(storage, name) { try { return storage.getItem(name) || ""; } catch (error) { return ""; } }
function writeStorage(storage, name, value) {
  try { if (value) storage.setItem(name, value); else storage.removeItem(name); } catch (error) { /* blocked */ }
}
function getKey() { return readStorage(window.sessionStorage, KEY_STORAGE) || readStorage(window.localStorage,
  KEY_STORAGE); }
function setKey(value, remember) {
  writeStorage(window.sessionStorage, KEY_STORAGE, remember ? "" : value);
  writeStorage(window.localStorage, KEY_STORAGE, remember ? value : "");
}
function keyRemembered() { return !!readStorage(window.localStorage, KEY_STORAGE); }
function getOperator() { return readStorage(window.localStorage, OPERATOR_STORAGE); }
function setOperator(value) { writeStorage(window.localStorage, OPERATOR_STORAGE, value); }

// ── Formatting ──────────────────────────────────────────────────────
function num(value, fallback) { var parsed = Number(value); return isFinite(parsed) ? parsed : (fallback || 0); }
function fmtNum(value) { return num(value).toLocaleString("en-US"); }
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function pad2(value) { return (value < 10 ? "0" : "") + value; }
function fmtDate(value) {
  if (!value) return "-";
  var date = new Date(value);
  if (isNaN(date.getTime())) return "-";
  return MONTHS[date.getMonth()] + " " + date.getDate() + ", " + date.getFullYear() + " " +
    pad2(date.getHours()) + ":" + pad2(date.getMinutes());
}
function fmtTime(value) {
  var date = new Date(value);
  return isNaN(date.getTime()) ? "-" : pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" +
    pad2(date.getSeconds());
}
function fmtDay(value) {
  var date = new Date(value + (String(value).length === 10 ? "T00:00:00Z" : ""));
  return isNaN(date.getTime()) ? String(value) : MONTHS[date.getUTCMonth()] + " " + date.getUTCDate();
}
function fmtAgo(value) {
  if (!value) return "never";
  var seconds = (Date.now() - value) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return Math.floor(seconds / 60) + " min ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + " h ago";
  if (seconds < 86400 * 30) return Math.floor(seconds / 86400) + " d ago";
  return fmtDate(value);
}
function fmtDuration(totalSeconds) {
  var seconds = Math.max(0, Math.floor(num(totalSeconds)));
  var days = Math.floor(seconds / 86400);
  var hours = Math.floor((seconds % 86400) / 3600);
  var minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return days + "d " + hours + "h";
  if (hours > 0) return hours + "h " + minutes + "m";
  return minutes + "m " + (seconds % 60) + "s";
}
function fmtBytes(bytes) {
  var value = num(bytes);
  return value < 1048576 ? (value / 1024).toFixed(0) + " KB" : (value / 1048576).toFixed(1) + " MB";
}
function fmtUntil(until) { return until === null || until === undefined ? "Permanent" : "Until " + fmtDate(until); }
function shortId(value) { return String(value || "").slice(0, 8); }
function plural(count, word, many) { return fmtNum(count) + " " + (num(count) === 1 ? word : many || word + "s"); }
function queryString(params) {
  var parts = [];
  Object.keys(params).forEach(function (name) {
    var value = params[name];
    if (value === null || value === undefined || value === "") return;
    parts.push(encodeURIComponent(name) + "=" + encodeURIComponent(value));
  });
  return parts.length ? "?" + parts.join("&") : "";
}
function newRequestId() {
  var bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return "gm-" + Array.prototype.map.call(bytes, function (part) { return (part + 256).toString(16).slice(1);
    }).join("");
}
function playerLabel(player) {
  if (!player) return "Unknown player";
  return player.displayName || player.username || shortId(player.id);
}

// ── Icons (inline SVG, stroke) ──────────────────────────────────────
var ICONS = {
  overview: '<path d="M3 13h4v8H3zM10 8h4v13h-4zM17 3h4v18h-4z"/>',
  rooms: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  chat: '<path d="M4 5h16v11H9l-5 4V5z"/><path d="M8 9h8M8 12h5"/>',
  players: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/>' +
    '<circle cx="17" cy="9" r="2.5"/><path d="M17 14c2.6 0 4.5 1.8 4.5 5"/>',
  reports: '<path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/>',
  sanctions: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
  grants: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v9h14v-9M12 8v13"/>' +
    '<path d="M12 8c-2-4-6-3-5 0 .6 1.7 3 1 5 0zM12 8c2-4 6-3 5 0-.6 1.7-3 1-5 0z"/>',
  purchases: '<path d="M3 5h2l2.4 10.2a1 1 0 0 0 1 .8h8.8a1 1 0 0 0 1-.8L20 8H6.2"/><circle cx="9" cy="19.5" ' +
    'r="1.5"/>' +
    '<circle cx="17" cy="19.5" r="1.5"/>',
  rankings: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 ' +
    '4"/>',
  audit: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  content: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  star: '<path d="M12 3l2.6 5.6 6.1.6-4.6 4.1 1.3 6L12 16.3 6.6 19.3l1.3-6L3.3 9.2l6.1-.6z"/>',
  megaphone: '<path d="M4 10v4h3l7 4V6L7 10H4z"/><path d="M18 9a4 4 0 0 1 0 6"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>'
};
function icon(name, size) {
  var side = size || 18;
  return '<svg width="' + side + '" height="' + side + '" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || "") +
    "</svg>";
}

// ── API ─────────────────────────────────────────────────────────────
async function api(path, options) {
  var settings = options || {};
  var headers = { Authorization: "Bearer " + getKey(), "X-GM-Operator": getOperator() || "gm" };
  if (settings.body !== undefined) headers["Content-Type"] = "application/json";
  var response;
  try {
    response = await fetch(API_ROOT + path, {
      method: settings.method || "GET",
      headers: headers,
      body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
      cache: "no-store"
    });
  } catch (networkError) {
    throw new Error("Cannot reach the server. Check that it is running, then try again.");
  }
  var text = await response.text();
  var data = null;
  try { data = text ? JSON.parse(text) : {}; } catch (parseError) { data = null; }
  if (response.status === 401) {
    state.authorized = false;
    renderSession();
    throw new Error("The admin key was rejected. Set the right key in the session menu.");
  }
  if (!response.ok) {
    if (data && data.error) throw new Error(data.error);
    if (response.status === 404) throw new Error("The admin API is not available here (no admin key or address not " +
      "allowed).");
    throw new Error("The server answered " + response.status + ".");
  }
  state.authorized = true;
  return data || {};
}
function post(path, body) { return api(path, { method: "POST", body: body || {} }); }
function playerPath(id, tail) { return "/players/" + encodeURIComponent(id) + (tail ? "/" + tail : ""); }

// ── Feedback ────────────────────────────────────────────────────────
function toast(message, tone) {
  var element = document.createElement("div");
  element.className = "toast " + (tone || "");
  element.textContent = message;
  byId("toasts").appendChild(element);
  window.setTimeout(function () { element.remove(); }, tone === "bad" ? 8000 : 4500);
}
function fail(error) { toast(error && error.message ? error.message : "Request failed.", "bad"); }

function fieldHtml(field) {
  var id = "field_" + field.name;
  var value = field.value === undefined || field.value === null ? "" : field.value;
  var control;
  if (field.type === "select") {
    control = '<select id="' + id + '" name="' + esc(field.name) + '">' + field.options.map(function (option) {
      return '<option value="' + esc(option[0]) + '"' + (String(option[0]) === String(value) ? " selected" : "") + ">" +
        esc(option[1]) + "</option>";
    }).join("") + "</select>";
  } else if (field.type === "textarea") {
    control = '<textarea id="' + id + '" name="' + esc(field.name) + '" maxlength="' + esc(field.maxlength || 1000) +
      '" placeholder="' + esc(field.placeholder || "") + '">' + esc(value) + "</textarea>";
  } else if (field.type === "checkbox") {
    return '<label class="check"><input type="checkbox" name="' + esc(field.name) + '"' + (value ? " checked" : "") +
      " /><span>" + esc(field.label) + "</span></label>";
  } else if (field.type === "lookup") {
    return lookupHtml(id, field.label, field.name);
  } else {
    control = '<input id="' + id + '" name="' + esc(field.name) + '" type="' +
      (field.type === "number" || field.type === "password" ? field.type : "text") + '" value="' + esc(value) + '"' +
      (field.min !== undefined ? ' min="' + esc(field.min) + '"' : "") +
      (field.max !== undefined ? ' max="' + esc(field.max) + '"' : "") +
      (field.maxlength ? ' maxlength="' + esc(field.maxlength) + '"' : "") +
      (field.list ? ' list="' + esc(field.list) + '"' : "") +
      ' placeholder="' + esc(field.placeholder || "") + '" autocomplete="off" />';
  }
  return '<label class="field"><span>' + esc(field.label) + "</span>" + control +
    (field.hint ? "<small>" + esc(field.hint) + "</small>" : "") + "</label>";
}

// A modal confirmation or form. Resolves with the field values (true for a plain confirmation) or null.
function dialog(options) {
  return new Promise(function (resolve) {
    var root = byId("modalRoot");
    var fields = options.fields || [];
    root.innerHTML = '<div class="backdrop" data-backdrop="1"><form class="modal' + (options.wide ? " wide" : "") +
      '" autocomplete="off"><h3>' + esc(options.title) + '</h3><div class="body">' +
      (options.text ? '<p style="margin:0 0 14px">' + esc(options.text) + "</p>" : "") + (options.html || "") +
      (fields.length ? '<div class="form">' + fields.map(fieldHtml).join("") + "</div>" : "") +
      '</div><div class="foot"><button type="button" class="btn" data-cancel="1">' + esc(options.cancel || "Cancel") +
      "</button>" + (options.confirm === false ? "" : '<button type="submit" class="btn ' +
      (options.danger ? "danger" : "primary") + '">' + esc(options.confirm || "OK") + "</button>") +
        "</div></form></div>";
    var form = root.querySelector("form");
    var finished = false;
    function finish(value) {
      if (finished) return;
      finished = true;
      document.removeEventListener("keydown", onKey, true);
      root.innerHTML = "";
      resolve(value);
    }
    function onKey(event) { if (event.key === "Escape") { event.preventDefault(); finish(null); } }
    document.addEventListener("keydown", onKey, true);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var values = {};
      fields.forEach(function (field) {
        var element = form.elements[field.name];
        if (!element) return;
        if (field.type === "checkbox") values[field.name] = !!element.checked;
        else if (field.type === "number") values[field.name] = element.value === "" ? null : Number(element.value);
        else if (field.type === "lookup") values[field.name] = lookupValue(element);
        else values[field.name] = String(element.value || "").trim();
      });
      finish(fields.length ? values : true);
    });
    root.querySelector("[data-cancel]").addEventListener("click", function () { finish(null); });
    root.querySelector("[data-backdrop]").addEventListener("mousedown", function (event) {
      if (event.target.hasAttribute("data-backdrop")) finish(null);
    });
    var first = form.querySelector("input, select, textarea");
    if (first) first.focus();
    else if (form.querySelector('button[type="submit"]')) form.querySelector('button[type="submit"]').focus();
  });
}
function confirmAction(title, text, label, danger) {
  return dialog({ title: title, text: text, confirm: label || "Confirm", danger: danger !== false });
}

// ── Player lookup (autocomplete over /players/search) ───────────────
function lookupHtml(id, label, name) {
  return '<div class="lookup"><label class="field"><span>' + esc(label || "Player") +
    '</span><input type="text" id="' + id +
    '" name="' + esc(name || id) + '" data-lookup="1" maxlength="120" autocomplete="off"' +
    ' placeholder="Name, username or id" /></label><div class="lookup-list hidden" data-lookup-list="' + id +
      '"></div></div>';
}
function lookupValue(input) {
  return (input.dataset.userId && input.dataset.label === input.value ? input.dataset.userId : input.value).trim();
}
var lookupTimer = 0;
document.addEventListener("input", function (event) {
  var input = event.target;
  if (!input || !input.hasAttribute || !input.hasAttribute("data-lookup")) return;
  delete input.dataset.userId;
  var list = document.querySelector('[data-lookup-list="' + input.id + '"]');
  window.clearTimeout(lookupTimer);
  var text = input.value.trim();
  if (text.length < 2) { list.classList.add("hidden"); return; }
  lookupTimer = window.setTimeout(async function () {
    try {
      var data = await api("/players/search" + queryString({ q: text, limit: 8 }));
      list.innerHTML = data.results.length ? data.results.map(function (player) {
        return '<button type="button" data-act="lookupPick" data-input="' + esc(input.id) + '" data-id="' +
          esc(player.id) +
          '" data-label="' + esc(playerLabel(player)) + '"><strong>' + esc(playerLabel(player)) +
            '</strong><div class="cell-sub">@' +
          esc(player.username) + (player.guest ? " · guest" : "") + " · " + esc(shortId(player.id)) + "</div></button>";
      }).join("") : '<div class="state" style="padding:12px">No players found.</div>';
      list.classList.remove("hidden");
    } catch (error) { list.classList.add("hidden"); }
  }, 220);
});
actions.lookupPick = function (element) {
  var input = byId(element.dataset.input);
  input.value = element.dataset.label;
  input.dataset.userId = element.dataset.id;
  input.dataset.label = element.dataset.label;
  element.parentNode.classList.add("hidden");
};

// ── Lists: states, tabs, sorting, search, pager ─────────────────────
function statusDot(tone, text) { return '<span class="st ' + tone + '"><i></i>' + esc(text) + "</span>"; }
function chip(text, tone) { return '<span class="chip ' + (tone || "") + '">' + esc(text) + "</span>"; }
function loadingHtml(text) { return '<div class="state"><div class="spinner"></div>' + esc(text || "Loading...") +
  "</div>"; }
function emptyHtml(text) { return '<div class="state">' + esc(text) + "</div>"; }
function errorHtml(message) {
  return '<div class="state"><div style="color:var(--red);margin-bottom:12px">' + esc(message) +
    '</div><button class="btn" data-act="reload">Retry</button></div>';
}
function tabsHtml(items, active, act, scope) {
  return '<div class="tabs">' + items.map(function (item) {
    return '<button type="button" class="tab' + (item.id === active ? " active" : "") + '" data-act="' + act +
      '" data-tab="' + esc(item.id) + '"' + (scope ? ' data-scope="' + scope + '"' : "") + ">" + esc(item.label) +
      (item.count !== undefined && item.count !== null ? '<span class="badge">' + fmtNum(item.count) + "</span>" : "") +
      "</button>";
  }).join("") + "</div>";
}
function sortTh(label, key, list, scope, numeric) {
  var active = list.sort === key;
  return '<th class="sortable' + (numeric ? " num" : "") + '" data-act="sort" data-scope="' + scope + '" data-key="' +
    key +
    '">' + esc(label) + (active ? '<span class="arrow">' + icon(list.dir === "asc" ? "up" : "down", 13) + "</span>" :
      "") +
    "</th>";
}
function searchRow(scope, placeholder, value) {
  return '<div class="searchrow">' + icon("search", 18) + '<input type="search" data-search="' + scope +
    '" placeholder="' + esc(placeholder) + '" value="' + esc(value || "") + '" /></div>';
}
function pagerHtml(list, total, scope) {
  var from = total === 0 ? 0 : (list.page - 1) * list.pageSize + 1;
  var to = Math.min(total, list.page * list.pageSize);
  return '<div class="pager"><span>' + fmtNum(from) + "–" + fmtNum(to) + " of " + fmtNum(total) +
    '</span><span class="btns">' +
    '<select data-change="pageSize" data-scope="' + scope + '">' + [25, 50, 100, 200].map(function (size) {
      return '<option value="' + size + '"' + (size === list.pageSize ? " selected" : "") + ">" + size +
        " per page</option>";
    }).join("") + '</select><button class="btn small" data-act="page" data-scope="' + scope + '" data-step="-1"' +
    (list.page <= 1 ? " disabled" : "") + '>Previous</button><button class="btn small" data-act="page" data-scope="' +
    scope + '" data-step="1"' + (to >= total ? " disabled" : "") + ">Next</button></span></div>";
}
actions.sort = function (element) {
  var list = state[element.dataset.scope];
  var key = element.dataset.key;
  if (list.sort === key) list.dir = list.dir === "asc" ? "desc" : "asc";
  else { list.sort = key; list.dir = key === "name" ? "asc" : "desc"; }
  list.page = 1;
  loaders[element.dataset.scope]();
};
actions.page = function (element) {
  var list = state[element.dataset.scope];
  list.page = Math.max(1, list.page + Number(element.dataset.step));
  loaders[element.dataset.scope]();
};
actions.filterTab = function (element) {
  var list = state[element.dataset.scope];
  list.filter = element.dataset.tab;
  list.page = 1;
  loaders[element.dataset.scope]();
};
var searchTimer = 0;
document.addEventListener("input", function (event) {
  var element = event.target;
  if (!element || !element.hasAttribute || !element.hasAttribute("data-search")) return;
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(function () {
    var scope = element.getAttribute("data-search");
    if (!state[scope]) return;
    state[scope].q = element.value.trim();
    state[scope].page = 1;
    loaders[scope]();
  }, 300);
});
document.addEventListener("change", function (event) {
  var element = event.target;
  var kind = element && element.getAttribute ? element.getAttribute("data-change") : null;
  if (kind === "pageSize") {
    var list = state[element.dataset.scope];
    list.pageSize = Number(element.value);
    list.page = 1;
    loaders[element.dataset.scope]();
  } else if (kind && actions[kind]) {
    Promise.resolve(actions[kind](element, event)).catch(fail);
  }
});

// ── Charts ──────────────────────────────────────────────────────────
function niceMax(values) {
  var largest = Math.max.apply(null, values.concat([0]));
  if (largest <= 4) return 4;
  var magnitude = Math.pow(10, Math.floor(Math.log(largest / 4) / Math.LN10));
  var step = largest / 4 / magnitude;
  return (step <= 1 ? 1 : step <= 2 ? 2 : step <= 5 ? 5 : 10) * magnitude * 4;
}
function shortNum(value) {
  return value >= 1e6 ? (value / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
    : value >= 1e4 ? (value / 1e3).toFixed(1).replace(/\.0$/, "") + "k" : fmtNum(value);
}
// model: { labels: [], series: [{ name, color, values, area }] } on one shared axis.
function drawChart(element, model) {
  var width = Math.max(300, element.clientWidth - 24);
  var height = 240;
  var left = 44;
  var right = 12;
  var top = 12;
  var bottom = 26;
  var plotWidth = width - left - right;
  var plotHeight = height - top - bottom;
  var count = model.labels.length;
  var maximum = niceMax([].concat.apply([], model.series.map(function (series) { return series.values; })));
  function pointX(index) { return left + (count <= 1 ? plotWidth / 2 : (plotWidth * index) / (count - 1)); }
  function pointY(value) { return top + plotHeight - (plotHeight * value) / maximum; }
  function line(values) {
    return values.map(function (value, index) {
      return (index ? "L" : "M") + pointX(index).toFixed(1) + " " + pointY(value).toFixed(1);
    }).join(" ");
  }
  var svg = '<svg viewBox="0 0 ' + width + " " + height + '" width="' + width + '" height="' + height + '">';
  for (var gridLine = 0; gridLine <= 4; gridLine++) {
    var gridY = top + (plotHeight * gridLine) / 4;
    svg += '<line x1="' + left + '" x2="' + (width - right) + '" y1="' + gridY + '" y2="' + gridY +
      '" stroke="#ece6ff" />';
    svg += '<text x="' + (left - 8) + '" y="' + (gridY + 4) + '" text-anchor="end">' +
      shortNum(maximum - (maximum * gridLine) / 4) + "</text>";
  }
  var labelStep = Math.max(1, Math.ceil(count / 7));
  model.labels.forEach(function (label, index) {
    // The last label always shows, anchored at its end; a regular one too close to it is skipped.
    var last = index === count - 1;
    if (!last && (index % labelStep !== 0 || count - 1 - index < labelStep * 0.6)) return;
    svg += '<text x="' + pointX(index) + '" y="' + (height - 6) + '" text-anchor="' + (last && count > 1 ? "end" :
      "middle") +
      '">' + esc(label) + "</text>";
  });
  model.series.forEach(function (series) {
    if (series.area)
      svg += '<path d="' + line(series.values) + " L" + pointX(count - 1) + " " + (top + plotHeight) + " L" +
        pointX(0) +
        " " + (top + plotHeight) + ' Z" fill="' + series.color + '" fill-opacity="0.12" />';
    svg += '<path d="' + line(series.values) + '" fill="none" stroke="' + series.color +
      '" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" />';
  });
  svg += '<line class="hair" y1="' + top + '" y2="' + (top + plotHeight) + '" stroke="#a79ee0" stroke-dasharray="3 3"' +
    ' style="display:none" /></svg>';
  element.innerHTML = svg + '<div class="tooltip hidden"></div>';
  var tip = element.querySelector(".tooltip");
  var hair = element.querySelector(".hair");
  var box = element.querySelector("svg");
  box.onmousemove = function (event) {
    var rect = box.getBoundingClientRect();
    var cursor = ((event.clientX - rect.left) / rect.width) * width;
    var index = Math.max(0, Math.min(count - 1, Math.round(count <= 1 ? 0 :
      ((cursor - left) / plotWidth) * (count - 1))));
    hair.setAttribute("x1", pointX(index));
    hair.setAttribute("x2", pointX(index));
    hair.style.display = "";
    tip.innerHTML = "<b>" + esc(model.labels[index]) + "</b>" + model.series.map(function (series) {
      return '<span style="color:' + series.color + '">●</span> ' + esc(series.name) + ": " +
        fmtNum(series.values[index]);
    }).join("<br>");
    tip.classList.remove("hidden");
    var scale = rect.width / width;
    var tipLeft = pointX(index) * scale + 20;
    if (tipLeft + tip.offsetWidth > element.clientWidth - 8) tipLeft = pointX(index) * scale - tip.offsetWidth - 4;
    tip.style.left = Math.max(4, tipLeft) + "px";
    tip.style.top = "14px";
  };
  box.onmouseleave = function () { tip.classList.add("hidden"); hair.style.display = "none"; };
}
function legendHtml(series) {
  return '<div class="legend">' + series.map(function (item) {
    return '<span><i style="background:' + item.color + '"></i>' + esc(item.name) + "</span>";
  }).join("") + "</div>";
}

// ── Session, status, router ─────────────────────────────────────────
function renderSession() {
  var hasKey = !!getKey();
  var operator = getOperator() || "GM";
  byId("sessionName").textContent = hasKey ? operator : "No session";
  byId("sessionSub").textContent = hasKey
    ? (state.authorized ? "Key accepted" : keyRemembered() ? "Key kept on this device" :
      "Key kept until the tab closes")
    : "Set the admin key";
  byId("sessionAvatar").textContent = hasKey ? operator.charAt(0).toUpperCase() : "?";
}
function renderTopStatus() {
  var status = state.status;
  var pill = byId("topStatus");
  if (!status) { pill.className = "st"; byId("topStatusText").textContent = "Status unknown"; return; }
  var tone = status.draining ? "bad" : status.maintenance ? "warn" : status.admissionsOpen ? "ok" : "bad";
  pill.className = "st " + tone;
  byId("topStatusText").textContent = (status.draining ? "Draining" : status.maintenance ? "Maintenance"
    : status.admissionsOpen ? "Online" : "Unavailable") + " · " + plural(status.connectedClients, "player");
}
function setReportsBadge(open) {
  if (open === null || open === undefined) return;
  var count = Math.max(0, num(open));
  var badge = byId("navReportsBadge");
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.classList.toggle("hidden", count === 0);
  if (state.reportsOpen !== null && count > state.reportsOpen) {
    var added = count - state.reportsOpen;
    toast(added + (added === 1 ? " new player report." : " new player reports."), "warn");
  }
  state.reportsOpen = count;
}
async function refreshStatus() {
  if (!getKey()) return;
  try {
    var data = await api("/live/status");
    state.status = data.status;
    setReportsBadge(data.openReports);
  } catch (error) {
    state.status = null;
  }
  renderTopStatus();
  renderSession();
}
async function loadCatalog() {
  if (state.catalog || !getKey()) return state.catalog;
  try { state.catalog = await api("/catalog"); } catch (error) { state.catalog = null; }
  if (state.catalog && state.catalog.characters) {
    byId("dlCharacters").innerHTML = state.catalog.characters.map(function (character) {
      return '<option value="' + esc(character.id) + '">' + esc(character.name) + "</option>";
    }).join("");
  }
  return state.catalog;
}
function characterName(id) {
  var found = state.catalog && state.catalog.characters
    ? state.catalog.characters.filter(function (character) { return character.id === id; })[0] : null;
  return found ? found.name : id;
}
// A view may poll: every(ms, work) runs until the route changes.
function every(milliseconds, work) {
  stopTimers();
  state.timer = window.setInterval(function () {
    if (document.hidden) return;
    Promise.resolve(work()).catch(function () {});
  }, milliseconds);
}
function stopTimers() { window.clearInterval(state.timer); state.timer = 0; }
function parseRoute() {
  var parts = (window.location.hash || "#overview").slice(1).split("/").map(decodeURIComponent);
  return { view: parts[0] || "overview", id: parts[1] || null, tab: parts[2] || null };
}
function go(hash) { if (window.location.hash === hash) route(); else window.location.hash = hash; }
function content() { return byId("content"); }
function pageHead(title, sub, actionsHtml, crumb) {
  return '<div class="page-head"><div>' + (crumb || "") + "<h1>" + esc(title) + "</h1>" +
    (sub ? '<div class="sub">' + sub + "</div>" : "") + '</div><div class="page-actions">' + (actionsHtml || "") +
    "</div></div>";
}
function crumbHtml(label, hash) {
  return '<button type="button" class="crumb" data-act="go" data-to="' + esc(hash) + '">' + icon("back", 14) +
    esc(label) + "</button>";
}
function route() {
  var current = parseRoute();
  stopTimers();
  document.body.classList.remove("nav-open");
  var name = views[current.view] ? current.view : "overview";
  Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (item) {
    item.classList.toggle("active", item.getAttribute("data-view") === name);
  });
  if (!getKey()) {
    content().innerHTML = pageHead("Sign in", "") + '<div class="panel"><div class="state">' +
      "Enter the server's admin key (PARTY_ADMIN_KEY) to use the console.<br><br>" +
      '<button class="btn primary" data-act="session">Enter admin key</button></div></div>';
    return;
  }
  window.scrollTo(0, 0);
  Promise.resolve(views[name](current)).catch(function (error) { content().innerHTML = errorHtml(error.message); });
}
actions.session = async function () {
  var values = await dialog({
    title: "GM session",
    text: "The key stays in this browser and is sent only to this server. The operator name labels your actions " +
      "in the audit log.",
    fields: [
      { name: "operator", label: "Operator name", value: getOperator(), maxlength: 32, placeholder: "e.g. Ana" },
      { name: "key", label: "Admin key", type: "password", value: getKey() },
      { name: "remember", label: "Remember the key on this device", type: "checkbox", value: keyRemembered() }
    ],
    confirm: "Save"
  });
  if (values === null) return;
  setOperator(values.operator);
  setKey(values.key, values.remember);
  state.catalog = null;
  state.authorized = false;
  renderSession();
  await refreshStatus();
  loadCatalog();
  route();
};
actions.signOut = function () {
  setKey("", false);
  state.status = null;
  renderSession();
  renderTopStatus();
  route();
};
actions.nav = function (element) { go("#" + element.getAttribute("data-view")); };
actions.go = function (element) { go(element.getAttribute("data-to")); };
actions.reload = function () { route(); };
actions.menu = function () { document.body.classList.toggle("nav-open"); };
actions.copy = function (element) {
  var text = element.getAttribute("data-text") || "";
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast("Copied.", "ok"); });
  else toast(text);
};
document.addEventListener("click", function (event) {
  var element = event.target.closest ? event.target.closest("[data-act]") : null;
  if (!element) {
    Array.prototype.forEach.call(document.querySelectorAll(".lookup-list"),
      function (list) { list.classList.add("hidden"); });
    return;
  }
  var handler = actions[element.getAttribute("data-act")];
  if (!handler) return;
  event.preventDefault();
  Promise.resolve(handler(element, event)).catch(fail);
});
`;
