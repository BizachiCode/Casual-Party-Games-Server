// GM console page (GET /gm): one self-contained HTML document, no external requests, assembled from the parts in
// ./gm-panel: the stylesheet, the HTML shell and the client script (helpers, one part per group of views, boot).
import { renderGmShell } from "./gm-panel/markup.js";
import { SCRIPT_BOOT } from "./gm-panel/script-boot.js";
import { SCRIPT_CORE } from "./gm-panel/script-core.js";
import { SCRIPT_LIVE } from "./gm-panel/script-live.js";
import { SCRIPT_MODERATION } from "./gm-panel/script-moderation.js";
import { SCRIPT_OVERVIEW } from "./gm-panel/script-overview.js";
import { SCRIPT_PLAYERS } from "./gm-panel/script-players.js";
import { SCRIPT_STORE } from "./gm-panel/script-store.js";
import { SCRIPT_TOOLS } from "./gm-panel/script-tools.js";
import { GM_STYLES } from "./gm-panel/styles.js";

/** Views register themselves in `views` / `actions` before the boot part routes, so the order matters. */
export const GM_CLIENT_SCRIPT = [
  SCRIPT_CORE,
  SCRIPT_OVERVIEW,
  SCRIPT_LIVE,
  SCRIPT_PLAYERS,
  SCRIPT_MODERATION,
  SCRIPT_STORE,
  SCRIPT_TOOLS,
  SCRIPT_BOOT,
].join("\n");

/**
 * Content-Security-Policy of the console: scripts only with the per-response nonce (no inline handlers, no remote
 * code), requests only to this origin, no framing, forms or plugins. Inline styles cannot run code.
 */
export function gmPanelCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

/** The console page; `nonce` is the value of the response's CSP (tests render it without one). */
export function renderGmPanelPage(nonce?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>Casual Party GM Console</title>
  <style>${GM_STYLES}</style>
</head>
<body>
${renderGmShell()}
<script${nonce ? ` nonce="${nonce}"` : ""}>
(function () {
"use strict";
${GM_CLIENT_SCRIPT}
})();
</script>
</body>
</html>`;
}
