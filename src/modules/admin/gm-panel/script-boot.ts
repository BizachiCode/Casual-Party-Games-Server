// GM console client, last part: icons, session, status polling and the first route (after every view registered).
export const SCRIPT_BOOT = String.raw`
Array.prototype.forEach.call(document.querySelectorAll("[data-icon]"), function (element) {
  element.innerHTML = icon(element.getAttribute("data-icon"), 18);
});
byId("envLabel").textContent = window.location.host;
renderSession();
window.addEventListener("hashchange", route);
window.setInterval(function () { if (!document.hidden) refreshStatus(); }, 15000);
if (getKey()) {
  refreshStatus();
  loadCatalog();
}
route();
if (!getKey()) actions.session();
`;
