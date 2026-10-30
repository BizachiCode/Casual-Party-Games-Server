// GM console HTML shell: top bar, sidebar navigation and the containers the client script renders into.

/** `badge`: id of a count pill the client fills (Reports shows the open reports). */
interface NavItem {
  view: string;
  label: string;
  badge?: string;
}
interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: "Live",
    items: [
      { view: "overview", label: "Overview" },
      { view: "rooms", label: "Rooms" },
      { view: "chat", label: "Chat" },
    ],
  },
  {
    title: "Players",
    items: [
      { view: "players", label: "Players" },
      { view: "reports", label: "Reports", badge: "navReportsBadge" },
      { view: "sanctions", label: "Bans & mutes" },
    ],
  },
  {
    title: "Economy",
    items: [
      { view: "purchases", label: "Purchases" },
      { view: "grants", label: "Grants" },
      { view: "rankings", label: "Leaderboards" },
    ],
  },
  {
    title: "Records",
    items: [
      { view: "audit", label: "Audit log" },
      { view: "content", label: "Content" },
    ],
  },
];

const LOGO =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M12 2.5l2.7 6 6.5.6-4.9 4.3 1.5 6.4L12 16.5l-5.8 3.3 1.5-6.4L2.8 9.1l6.5-.6z"/></svg>';

export function renderGmShell(): string {
  const nav = NAV_GROUPS.map(
    group =>
      `<div class="nav-group"><div class="nav-title">${group.title}</div>` +
      group.items
        .map(
          item =>
            `<button type="button" class="nav-item" data-act="nav" data-view="${item.view}">` +
            `<span class="ico" data-icon="${item.view}"></span><span>${item.label}</span>` +
            (item.badge ? `<span class="nav-badge hidden" id="${item.badge}"></span>` : "") +
            "</button>",
        )
        .join("") +
      "</div>",
  ).join("");

  return `<header class="topbar">
    <div class="brand">
      <button type="button" class="menu-toggle" data-act="menu" aria-label="Menu">
        <span data-icon="menu"></span>
      </button>
      <span class="logo">${LOGO}</span><b>Casual Party</b><span class="tag">GM Console</span>
    </div>
    <div class="top-right">
      <span class="env" id="envLabel"></span>
      <span class="st" id="topStatus"><i></i><span id="topStatusText">Status unknown</span></span>
      <button type="button" class="session" data-act="session">
        <span class="avatar" id="sessionAvatar">?</span>
        <span><strong id="sessionName">No session</strong><small id="sessionSub">Set the admin key</small></span>
      </button>
    </div>
  </header>
  <nav class="sidebar" aria-label="Sections">${nav}</nav>
  <main class="main" id="content"></main>
  <div id="modalRoot"></div>
  <div class="toasts" id="toasts" aria-live="polite"></div>
  <datalist id="dlCharacters"></datalist>`;
}
