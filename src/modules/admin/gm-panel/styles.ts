// GM console stylesheet: the hub's sunset violets (navy chrome, violet actions, gold accents) on a light lavender page.
export const GM_STYLES = String.raw`
:root {
  --navy: #24124f; --band: #1a0e4a; --ink: #4d2c9e; --violet: #6b55f0; --violet-dark: #5b36e0; --sky: #7a63ff;
  --gold: #ffc83d; --gold-soft: #fff4c7; --pink: #f0559e; --red: #f04a68; --red-soft: #fde7ec;
  --green: #2fa84a; --green-soft: #e3f7e7; --orange: #f07a2a; --orange-soft: #fff0e3; --cyan: #1aa6d6;
  --page: #f4f1ff; --card: #ffffff; --line: #e4ddfb; --line-strong: #cfc4f6; --text: #1f1640; --muted: #6f6894;
  --soft: #f8f6ff; --shadow: 0 1px 2px rgba(36, 18, 79, .06), 0 6px 18px rgba(36, 18, 79, .07);
  --radius: 12px; --side: 232px; --top: 60px;
  color-scheme: light;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--text); background: var(--page); -webkit-font-smoothing: antialiased;
}
button, input, select, textarea { font: inherit; color: inherit; }
a { color: var(--violet); }
.hidden { display: none !important; }

/* Top bar */
.topbar {
  position: fixed; inset: 0 0 auto 0; height: var(--top); z-index: 20; display: flex; align-items: center;
  justify-content: space-between; gap: 12px; padding: 0 16px 0 18px; color: #fff;
  background: linear-gradient(90deg, var(--band), var(--navy) 45%, var(--ink));
  box-shadow: 0 2px 10px rgba(26, 14, 74, .35);
}
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; white-space: nowrap; }
.brand b { font-size: 17px; font-weight: 800; letter-spacing: .2px; font-style: italic; }
.logo {
  width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; color: var(--navy);
  background: linear-gradient(180deg, #ffe46b, #ffad1f); transform: skewX(-8deg);
  box-shadow: inset 0 -3px 0 rgba(0, 0, 0, .15);
}
.logo svg { transform: skewX(8deg); }
.tag {
  font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; padding: 3px 8px;
  border-radius: 999px; background: rgba(255, 255, 255, .14); color: #ffe36b;
}
.top-right { display: flex; align-items: center; gap: 10px; min-width: 0; }
.env { font-size: 12px; opacity: .75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px;
  }
.session {
  display: flex; align-items: center; gap: 9px; border: 0; cursor: pointer; padding: 5px 10px 5px 5px;
  border-radius: 999px; background: rgba(255, 255, 255, .12); color: #fff; text-align: left;
}
.session:hover { background: rgba(255, 255, 255, .2); }
.session strong { display: block; font-size: 13px; line-height: 1.2; }
.session small { display: block; font-size: 11px; opacity: .75; line-height: 1.2; }
.avatar {
  width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font-weight: 800;
  background: var(--gold); color: var(--navy); flex: none;
}
.menu-toggle { display: none; border: 0; background: none; color: #fff; cursor: pointer; padding: 6px; }

/* Status pill */
.st { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.st i { width: 8px; height: 8px; border-radius: 50%; background: #b9b3d6; flex: none; }
.st.ok i { background: #45d36a; box-shadow: 0 0 0 3px rgba(69, 211, 106, .22); }
.st.warn i { background: var(--gold); box-shadow: 0 0 0 3px rgba(255, 200, 61, .25); }
.st.bad i { background: var(--red); box-shadow: 0 0 0 3px rgba(240, 74, 104, .2); }
.topbar .st { padding: 6px 10px; border-radius: 999px; background: rgba(0, 0, 0, .18); }

/* Sidebar */
.sidebar {
  position: fixed; top: var(--top); bottom: 0; left: 0; width: var(--side); overflow-y: auto; padding: 14px 10px 24px;
  background: #fff; border-right: 1px solid var(--line); z-index: 10;
}
.nav-group { padding: 6px 0; border-bottom: 1px solid var(--line); }
.nav-group:last-child { border-bottom: 0; }
.nav-title {
  font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--muted);
  padding: 6px 12px 4px;
}
.nav-item {
  width: 100%; display: flex; align-items: center; gap: 10px; padding: 9px 12px; border: 0; border-radius: 10px;
  background: none; cursor: pointer; text-align: left; color: var(--text); font-weight: 600;
}
.nav-item:hover { background: var(--soft); }
.nav-item.active { background: linear-gradient(90deg, #ece7ff, #f6f3ff); color: var(--violet-dark); }
.nav-item.active .ico { color: var(--violet); }
.nav-item .ico { color: var(--muted); display: inline-flex; }
.nav-badge {
  margin-left: auto; min-width: 20px; padding: 1px 6px; border-radius: 999px; background: var(--red); color: #fff;
  font-size: 11px; font-weight: 700; text-align: center;
}

/* Main */
.main { margin-left: var(--side); padding: calc(var(--top) + 22px) 26px 40px; min-height: 100vh; }
.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.page-head h1 { margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -.01em; }
.page-head .sub { color: var(--muted); margin-top: 3px; }
.page-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.crumb {
  display: inline-flex; align-items: center; gap: 4px; border: 0; background: none; color: var(--muted);
    cursor: pointer;
  padding: 0; margin-bottom: 4px; font-weight: 600;
}
.crumb:hover { color: var(--violet); }

/* Cards and grids */
.panel { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius);
  box-shadow: var(--shadow); }
.panel + .panel { margin-top: 16px; }
.panel-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 16px;
  border-bottom: 1px solid var(--line);
}
.panel-head h2 { margin: 0; font-size: 15px; font-weight: 800; }
.panel-head .hint { color: var(--muted); font-size: 12px; }
.panel-body { padding: 16px; }
.grid2, .grid3 { display: grid; gap: 16px; }
.grid2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid2.top { align-items: start; }
.grid3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.grid2 > .panel + .panel, .grid3 > .panel + .panel, .kpis > .panel + .panel { margin-top: 0; }
.stack > * + * { margin-top: 16px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; margin-bottom: 16px; }
.kpi { padding: 14px 16px; position: relative; overflow: hidden; }
.kpi::before {
  content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; background: var(--accent, var(--violet));
}
.kpi .label { color: var(--muted); font-size: 12px; font-weight: 600; }
.kpi .value { font-size: 26px; font-weight: 800; line-height: 1.15; margin-top: 2px; }
.kpi .foot { color: var(--muted); font-size: 12px; margin-top: 2px; }
.kv { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 8px 14px; margin: 0; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }

/* Buttons */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 14px; border-radius: 10px;
  border: 1px solid var(--line-strong); background: #fff; color: var(--text); cursor: pointer; font-weight: 700;
  white-space: nowrap; transition: background .12s, border-color .12s, transform .06s;
}
.btn:hover { background: var(--soft); border-color: var(--violet); }
.btn:active { transform: translateY(1px); }
.btn[disabled] { opacity: .5; cursor: default; pointer-events: none; }
.btn.primary {
  border-color: transparent; color: #fff; background: linear-gradient(180deg, #8c6eff, var(--violet-dark));
  box-shadow: inset 0 -2px 0 rgba(0, 0, 0, .15);
}
.btn.primary:hover { filter: brightness(1.06); }
.btn.gold {
  border-color: transparent; color: var(--navy); background: linear-gradient(180deg, #ffe46b, #ffad1f);
  box-shadow: inset 0 -2px 0 rgba(0, 0, 0, .12);
}
.btn.danger { border-color: transparent; color: #fff; background: linear-gradient(180deg, #ff6f8a, var(--red)); }
.btn.danger:hover { filter: brightness(1.05); }
.btn.ghost { border-color: transparent; background: none; }
.btn.ghost:hover { background: var(--soft); }
.btn.small { padding: 5px 10px; font-size: 12px; border-radius: 8px; }
.btn-row { display: flex; gap: 8px; flex-wrap: wrap; }

/* Tables */
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: middle; }
th {
  font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
  background: var(--soft); white-space: nowrap;
}
th.sortable { cursor: pointer; user-select: none; }
th.sortable:hover { color: var(--violet); }
th .arrow { display: inline-flex; vertical-align: middle; margin-left: 2px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tbody tr:last-child td { border-bottom: 0; }
tr.click { cursor: pointer; }
tr.click:hover td { background: #faf8ff; }
.cell-main { font-weight: 700; }
.cell-sub { color: var(--muted); font-size: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
.chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 11px;
  font-weight: 700; background: var(--soft); color: var(--muted); border: 1px solid var(--line); white-space: nowrap;
}
.chip.violet { background: #efeaff; color: var(--violet-dark); border-color: #ddd3ff; }
.chip.gold { background: var(--gold-soft); color: #8a5a00; border-color: #ffe39a; }
.chip.red { background: var(--red-soft); color: #b3203d; border-color: #f9c4cf; }
.chip.green { background: var(--green-soft); color: #1d7a33; border-color: #bfe9c8; }
.chip.orange { background: var(--orange-soft); color: #a44d0e; border-color: #ffd2ad; }
.chips { display: flex; gap: 4px; flex-wrap: wrap; }

/* Toolbars, tabs, search, pager */
.toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 16px; }
.toolbar + .table-wrap { border-top: 1px solid var(--line); }
.searchrow {
  display: flex; align-items: center; gap: 8px; flex: 1 1 260px; min-width: 200px; padding: 0 12px; height: 40px;
  border: 1px solid var(--line-strong); border-radius: 10px; background: #fff; color: var(--muted);
}
.searchrow:focus-within { border-color: var(--violet); box-shadow: 0 0 0 3px rgba(107, 85, 240, .15); }
.searchrow input { flex: 1; border: 0; outline: 0; background: none; min-width: 0; height: 100%; color: var(--text); }
.tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.tab {
  border: 0; background: none; padding: 7px 12px; border-radius: 999px; cursor: pointer; font-weight: 700;
  color: var(--muted);
}
.tab:hover { background: var(--soft); color: var(--text); }
.tab.active { background: var(--navy); color: #fff; }
.tab .badge {
  margin-left: 6px; padding: 0 6px; border-radius: 999px; background: rgba(0, 0, 0, .08); font-size: 11px;
}
.tab.active .badge { background: rgba(255, 255, 255, .2); }
.pager {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 16px;
  border-top: 1px solid var(--line); color: var(--muted); flex-wrap: wrap;
}
.pager .btns { display: flex; gap: 6px; align-items: center; }
select, input[type="text"], input[type="number"], input[type="password"], input[type="search"], textarea {
  border: 1px solid var(--line-strong); border-radius: 10px; background: #fff; padding: 8px 10px; outline: 0;
}
select:focus, input:focus, textarea:focus { border-color: var(--violet); box-shadow: 0 0 0 3px rgba(107, 85, 240, .15);
  }
.searchrow input[type="search"], .searchrow input[type="search"]:focus { border: 0; padding: 0; box-shadow: none; }
textarea { width: 100%; min-height: 90px; resize: vertical; }

/* Forms */
.form { display: grid; gap: 12px; }
.form.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.field { display: grid; gap: 5px; }
.field > span { font-size: 12px; font-weight: 700; color: var(--muted); }
.field input, .field select, .field textarea { width: 100%; }
.field small { color: var(--muted); font-size: 12px; }
.check { display: flex; align-items: center; gap: 8px; font-weight: 600; cursor: pointer; }
.check input { width: 16px; height: 16px; accent-color: var(--violet); }

/* States */
.state { padding: 34px 16px; text-align: center; color: var(--muted); }
.spinner {
  width: 26px; height: 26px; margin: 0 auto 10px; border-radius: 50%; border: 3px solid var(--line);
  border-top-color: var(--violet); animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.notice {
  display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: 10px; margin-bottom: 16px;
  background: var(--gold-soft); border: 1px solid #ffe39a; color: #6b4700;
}
.notice.red { background: var(--red-soft); border-color: #f9c4cf; color: #8f1730; }
.notice.green { background: var(--green-soft); border-color: #bfe9c8; color: #1d6a2e; }

/* Player header */
.hero { display: flex; align-items: center; gap: 16px; padding: 18px; }
.hero .big-avatar {
  width: 64px; height: 64px; border-radius: 18px; display: grid; place-items: center; font-size: 26px; font-weight: 800;
  color: #fff; background: linear-gradient(180deg, #8c6eff, var(--violet-dark)); transform: skewX(-6deg); flex: none;
}
.hero h2 { margin: 0; font-size: 20px; font-weight: 800; }
.hero .meta { color: var(--muted); margin-top: 2px; }
.hero .chips { margin-top: 8px; }
.hero .actions { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }

/* Character grid */
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; }
.card-item { border: 1px solid var(--line); border-radius: 12px; padding: 12px; background: #fff; }
.card-item.owned { border-color: #cfc4f6; background: linear-gradient(180deg, #fff, #f8f6ff); }
.card-item.equipped { box-shadow: 0 0 0 2px var(--gold) inset; }
.card-item .name { font-weight: 800; }
.card-item .actions { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
.rarity-common { --accent: #8f8ab0; }
.rarity-rare { --accent: #2f9bff; }
.rarity-epic { --accent: #a64dff; }
.rarity-legendary { --accent: #ff9f1a; }
.rarity-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--accent);
  margin-right: 5px; }

/* Chat */
.chat-line { display: grid; grid-template-columns: 64px minmax(0, 1fr) auto; gap: 10px; padding: 8px 16px; }
.chat-line + .chat-line { border-top: 1px solid var(--line); }
.chat-line time { color: var(--muted); font-size: 12px; padding-top: 1px; }
.chat-line .who { font-weight: 800; margin-right: 6px; }
.chat-line .text { overflow-wrap: anywhere; }
.chat-line .acts { display: flex; gap: 4px; opacity: 0; transition: opacity .12s; }
.chat-line:hover .acts { opacity: 1; }
.evidence { max-height: 280px; overflow-y: auto; border: 1px solid var(--line); border-radius: 10px;
  background: var(--soft); }

/* Chart */
.chart { position: relative; padding: 8px 12px 4px; }
.chart svg { display: block; width: 100%; height: auto; }
.chart text { font-size: 11px; fill: var(--muted); }
.legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--muted); padding: 0 16px 12px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px;
  vertical-align: -1px; }
.tooltip {
  position: absolute; pointer-events: none; padding: 8px 10px; border-radius: 8px; background: var(--navy); color: #fff;
  font-size: 12px; white-space: nowrap; box-shadow: 0 6px 18px rgba(26, 14, 74, .3);
}
.tooltip b { display: block; margin-bottom: 2px; }

/* Modal and toasts */
.backdrop {
  position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 16px;
  background: rgba(26, 14, 74, .45); backdrop-filter: blur(2px);
}
.modal {
  width: min(480px, 100%); max-height: calc(100vh - 32px); overflow-y: auto; background: #fff; border-radius: 16px;
  box-shadow: 0 20px 60px rgba(26, 14, 74, .35);
}
.modal.wide { width: min(760px, 100%); }
.modal h3 {
  margin: 0; padding: 16px 18px; font-size: 17px; font-weight: 800; color: #fff; border-radius: 16px 16px 0 0;
  background: linear-gradient(90deg, var(--navy), var(--ink));
}
.modal .body { padding: 18px; }
.modal .foot {
  display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--line);
  background: var(--soft); border-radius: 0 0 16px 16px;
}
.toasts { position: fixed; right: 16px; bottom: 16px; z-index: 60; display: grid; gap: 8px; max-width: 380px; }
.toast {
  padding: 11px 14px; border-radius: 10px; background: var(--navy); color: #fff; font-weight: 600;
  box-shadow: 0 10px 30px rgba(26, 14, 74, .3); animation: pop .18s ease-out;
}
.toast.ok { background: #1f7a36; }
.toast.bad { background: #b3203d; }
.toast.warn { background: #9a5a00; }
@keyframes pop { from { transform: translateY(8px); opacity: 0; } }

/* Lookup (player autocomplete) */
.lookup { position: relative; }
.lookup-list {
  position: absolute; left: 0; right: 0; top: 100%; z-index: 5; margin-top: 4px; background: #fff;
  border: 1px solid var(--line-strong); border-radius: 10px; box-shadow: var(--shadow); max-height: 260px;
    overflow-y: auto;
}
.lookup-list button {
  display: block; width: 100%; text-align: left; border: 0; background: none; padding: 8px 12px; cursor: pointer;
}
.lookup-list button:hover { background: var(--soft); }

@media (max-width: 1100px) {
  .grid3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 860px) {
  :root { --side: 0px; }
  .menu-toggle { display: inline-flex; }
  .sidebar { width: 250px; transform: translateX(-100%); transition: transform .18s; box-shadow: var(--shadow); }
  body.nav-open .sidebar { transform: none; }
  .main { padding: calc(var(--top) + 16px) 16px 32px; }
  .grid2, .grid3, .form.two { grid-template-columns: minmax(0, 1fr); }
  .env, .session small, .tag { display: none; }
  .page-head { flex-direction: column; align-items: stretch; }
  .page-actions { justify-content: flex-start; }
  .hero { flex-wrap: wrap; }
  .hero .actions { margin-left: 0; justify-content: flex-start; }
  .kv { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .kv dd { margin-bottom: 8px; }
}
@media (max-width: 520px) {
  .topbar .st span { display: none; }
  .brand b { font-size: 15px; }
}
`;
