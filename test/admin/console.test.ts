import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Script } from "node:vm";
import { GM_CLIENT_SCRIPT, renderGmPanelPage } from "../../src/modules/admin/gm-panel.page.js";
import { AddressAllowList, AdminFailureTracker, createAdminGuard } from "../../src/shared/admin-guard.js";
import { startServer } from "../support/server.js";

describe("GM console", () => {
  it("builds one self-contained page whose script parses", () => {
    const page = renderGmPanelPage("abc");
    assert.match(page, /<script nonce="abc">/);
    // Nothing is loaded from elsewhere: no remote URLs and no stylesheet or script references.
    assert.doesNotMatch(page, /https?:\/\//);
    assert.doesNotMatch(page, /url\(/);
    assert.doesNotMatch(page, /<(link|script)[^>]+src=/);
    // String.raw parts must not leave template syntax behind.
    assert.doesNotMatch(GM_CLIENT_SCRIPT, /\$\{/);
    assert.doesNotThrow(() => new Script("(function () {\n" + GM_CLIENT_SCRIPT + "\n})"));
  });

  it("registers a view for every navigation item", () => {
    const page = renderGmPanelPage();
    const navigation = [...page.matchAll(/data-view="([a-z]+)"/g)].map(match => match[1]);
    assert.ok(navigation.length >= 10);
    for (const view of navigation) assert.match(GM_CLIENT_SCRIPT, new RegExp("views\\." + view + " = "), view);
    // Every data-act the page can render has a handler.
    const acts = new Set([...page.matchAll(/data-act="([A-Za-z]+)"/g)].map(match => match[1]));
    for (const act of acts) assert.match(GM_CLIENT_SCRIPT, new RegExp("actions\\." + act + " = "), act);
  });

  it("serves the page only with an admin key, with a strict content policy", async () => {
    const closed = await startServer();
    try {
      assert.equal((await fetch(closed.url + "/gm")).status, 404);
      assert.equal((await fetch(closed.url + "/api/admin/audit")).status, 404);
    } finally {
      await closed.stop();
    }
    const key = randomUUID();
    const server = await startServer({ adminKey: key, adminMaxFailures: 3, adminLockoutSeconds: 60 });
    try {
      const page = await fetch(server.url + "/gm");
      assert.equal(page.status, 200);
      const policy = page.headers.get("content-security-policy");
      const nonce = /'nonce-([^']+)'/.exec(policy)[1];
      assert.match(await page.text(), new RegExp('<script nonce="' + nonce.replace(/[+/=]/g, "\\$&") + '">'));
      assert.match(policy, /frame-ancestors 'none'/);
      assert.equal(page.headers.get("cache-control"), "no-store");

      const audit = (secret: string) =>
        fetch(server.url + "/api/admin/audit", { headers: { Authorization: "Bearer " + secret } });
      assert.equal((await audit(key)).status, 200);
      assert.equal((await audit("wrong-1")).status, 401);
      assert.equal((await audit("wrong-2")).status, 401);
      assert.equal((await audit("wrong-3")).status, 401);
      // Locked out: even the right key is refused until the window ends.
      const locked = await audit(key);
      assert.equal(locked.status, 429);
      assert.ok(Number(locked.headers.get("retry-after")) > 0);
    } finally {
      await server.stop();
    }
  });

  it("records who did what in the audit log", async () => {
    const key = randomUUID();
    const server = await startServer({ adminKey: key });
    try {
      const headers = { Authorization: "Bearer " + key, "X-GM-Operator": "Ana <script>" };
      await server.container.audit.record({ operator: "Ana", address: "127.0.0.1" }, "test.action", null, {
        amount: 5,
      });
      const claimed = await server.container.audit.claim(
        { operator: "Ana", address: "127.0.0.1" },
        "test.grant",
        null,
        "request-0001",
      );
      const repeated = await server.container.audit.claim(
        { operator: "Ana", address: "127.0.0.1" },
        "test.grant",
        null,
        "request-0001",
      );
      assert.equal(claimed, true);
      assert.equal(repeated, false);
      const listed = await (await fetch(server.url + "/api/admin/audit?action=test.action", { headers })).json();
      assert.equal(listed.total, 1);
      assert.deepEqual(listed.entries[0].details, { amount: 5 });
      const filters = await (await fetch(server.url + "/api/admin/audit/filters", { headers })).json();
      assert.deepEqual(filters.actions, ["test.action", "test.grant"]);
      assert.equal((await fetch(server.url + "/api/admin/nothing-here", { headers })).status, 404);
    } finally {
      await server.stop();
    }
  });
});

describe("admin guard", () => {
  it("matches addresses and ranges, including mapped IPv4", () => {
    const list = new AddressAllowList(["localhost", "10.1.0.0/16", "2001:db8::/32"]);
    assert.ok(list.allows("127.0.0.1"));
    assert.ok(list.allows("::ffff:127.0.0.1"));
    assert.ok(list.allows("10.1.200.3"));
    assert.ok(list.allows("2001:db8::7"));
    assert.ok(!list.allows("10.2.0.1"));
    assert.ok(!list.allows(undefined));
    assert.throws(() => new AddressAllowList(["not-an-address"]), /not an IP address/);
    assert.throws(() => new AddressAllowList(["10.0.0.0/40"]), /prefix length/);
  });

  it("locks an address out after repeated wrong keys and counts an IPv6 /64 together", () => {
    let now = 1000;
    const tracker = new AdminFailureTracker(2, 60, () => now);
    assert.equal(tracker.fail("2001:db8:1:2::1"), false);
    assert.equal(tracker.fail("2001:db8:1:2::9"), true);
    assert.ok(tracker.lockedFor("2001:db8:1:2:ffff::1") > 0);
    assert.equal(tracker.lockedFor("2001:db8:1:3::1"), 0);
    now += 61_000;
    assert.equal(tracker.lockedFor("2001:db8:1:2::1"), 0);
  });

  it("answers 404 for addresses outside the allowlist", async () => {
    const key = randomUUID();
    const server = await startServer({ adminKey: key, adminAllowedIps: ["192.0.2.1"] });
    try {
      assert.equal((await fetch(server.url + "/gm")).status, 404);
      const refused = await fetch(server.url + "/api/admin/audit", { headers: { Authorization: "Bearer " + key } });
      assert.equal(refused.status, 404);
    } finally {
      await server.stop();
    }
    assert.equal(createAdminGuard({}).enabled, false);
  });
});
