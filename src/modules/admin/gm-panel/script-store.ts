// GM console client, part 7: real-money purchases (Stars packs) with the revenue of the last 14 days.
export const SCRIPT_STORE = String.raw`
state.purchases = { page: 1, pageSize: 50 };
function money(value) { return "$" + num(value).toFixed(2); }
function purchaseRows(entries, withPlayer) {
  return '<div class="table-wrap"><table><thead><tr><th>When</th>' + (withPlayer ? "<th>Player</th>" : "") +
    '<th>Pack</th><th class="num">Stars</th><th class="num">Gems</th><th class="num">Price</th><th>Store</th></tr>' +
    "</thead><tbody>" + entries.map(function (entry) {
      var demo = entry.environment === "Demo";
      var test = entry.environment === "Sandbox" || entry.environment === "Test";
      return "<tr><td>" + fmtDate(entry.createdAt) + "</td>" + (withPlayer ? '<td><a href="#players/' +
        encodeURIComponent(entry.userId) + '/economy">' + esc(entry.playerName || shortId(entry.userId)) +
          "</a></td>" : "") +
        '<td><div class="cell-main">' + esc(entry.catalogId) + '</div><div class="cell-sub mono">' +
          esc(entry.productId) +
        '</div></td><td class="num">' + fmtNum(entry.stars) + '</td><td class="num">' + fmtNum(entry.shards) +
        '</td><td class="num">' + (demo ? '<span class="cell-sub">' + money(entry.priceUsd) + "</span>" :
          money(entry.priceUsd)) +
        "</td><td>" + (entry.store === entry.environment ? "" : chip(entry.store, "violet") + " ") + (demo ?
          chip("Demo", "orange") : test ?
          chip(entry.environment, "gold")
        : chip(entry.environment, "green")) + "</td></tr>";
    }).join("") + "</tbody></table></div>";
}

views.purchases = async function () {
  content().innerHTML = pageHead("Purchases", "Stars packs bought with real money (and demo purchases)") +
    loadingHtml();
  var revenue = await api("/purchases/revenue");
  var series = [
    { name: "US dollars", color: "#2fa84a", values: revenue.usd || [], area: true },
    { name: "Purchases", color: "#6b55f0", values: revenue.purchases || [] }
  ];
  var total = (revenue.usd || []).reduce(function (sum, value) { return sum + num(value); }, 0);
  var count = (revenue.purchases || []).reduce(function (sum, value) { return sum + num(value); }, 0);
  content().innerHTML = pageHead("Purchases", "Stars packs bought with real money (and demo purchases)") +
    '<div class="kpis">' + kpi("Revenue, 14 days", money(total), "store prices in US dollars, demo excluded",
      "var(--green)") +
    kpi("Purchases, 14 days", fmtNum(count), "demo excluded") + '<div id="demoKpi"></div></div>' +
    '<div class="panel"><div class="panel-head"><h2>Last 14 days</h2><span class="hint">UTC days</span></div>' +
    '<div class="chart" id="revenueChart"></div>' + legendHtml(series) + "</div>" +
    '<div class="panel"><div class="panel-head"><h2>Every purchase</h2><span class="hint" id="purchasesHint"></span>' +
      '</div>' +
    '<div id="purchasesTable">' + loadingHtml() + "</div></div>";
  drawChart(byId("revenueChart"), { labels: (revenue.days || []).map(fmtDay), series: series });
  await loaders.purchases();
};
loaders.purchases = async function () {
  var list = state.purchases;
  var target = byId("purchasesTable");
  if (!target) return;
  try {
    var data = await api("/purchases" + queryString({ page: list.page, pageSize: list.pageSize }));
    if (byId("demoKpi") && data.demo)
      byId("demoKpi").outerHTML = kpi("Demo purchases", "ON", "packs are granted without payment", "var(--orange)");
    byId("purchasesHint").textContent = plural(data.total, "purchase");
    target.innerHTML = (data.entries || []).length ? purchaseRows(data.entries, true) + pagerHtml(list, data.total,
      "purchases")
      : emptyHtml("Nobody has bought a pack yet.");
  } catch (error) {
    target.innerHTML = errorHtml(error.message);
  }
};
async function fillPlayerPurchases(id) {
  var target = byId("playerPurchases");
  if (!target) return;
  try {
    var data = await api("/purchases" + queryString({ player: id, pageSize: 50 }));
    target.innerHTML = (data.entries || []).length ? purchaseRows(data.entries, false)
      : emptyHtml("This player has not bought a pack.");
  } catch (error) {
    target.innerHTML = errorHtml(error.message);
  }
}
`;
