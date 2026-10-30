import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startServer, startServices } from "../support/server.js";

/** A device id and secret shaped like the ones the Unity client keeps. */
function device(displayName = "Pat") {
  return {
    deviceId: randomUUID(),
    deviceSecret: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
    displayName,
  };
}

describe("guest accounts", () => {
  it("creates an account for a new device and signs the same device in again", async () => {
    const services = await startServices();
    const phone = device("  <b>Pat</b>  ");
    const first = await services.accounts.guest(phone);
    assert.match(first.profile.username, /^guest_[0-9a-f]{10}$/);
    assert.equal(first.profile.guest, true);
    assert.equal(first.profile.displayName, "bPat/b", "the display name is cleaned like any player text");
    assert.equal(first.profile.level, 1);
    assert.equal((await services.accounts.authenticate(first.token)).id, first.profile.id);

    const second = await services.accounts.guest({ ...phone, displayName: "Someone else" });
    assert.equal(second.profile.id, first.profile.id, "a known device gets its own account back");
    assert.equal(second.profile.displayName, "bPat/b", "and keeps its name");
    assert.notEqual(second.token, first.token);
    assert.equal((await services.accounts.authenticate(first.token)).id, first.profile.id, "both sessions work");

    const stored = await services.database.query("SELECT device_id, secret_hash FROM device_logins");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].device_id, phone.deviceId);
    assert.notEqual(stored[0].secret_hash, phone.deviceSecret, "only a hash of the secret is stored");
    assert.match(String(stored[0].secret_hash), /^[0-9a-f]{64}$/);
    const users = await services.database.query("SELECT guest FROM users WHERE id=?", [first.profile.id]);
    assert.equal(Number(users[0].guest), 1);
  });

  it("gives a guest without a usable name a guest name, and every guest its own username", async () => {
    const services = await startServices();
    const nameless = await services.accounts.guest({ ...device(), displayName: "" });
    const missing = await services.accounts.guest({ ...device(), displayName: undefined });
    const refused = await services.accounts.guest({ ...device(), displayName: "12345" });
    for (const signedIn of [nameless, missing, refused]) assert.match(signedIn.profile.displayName, /^Guest-\d{5}$/);
    assert.notEqual(nameless.profile.username, missing.profile.username);
    const long = await services.accounts.guest({ ...device(), displayName: "x".repeat(60) });
    assert.equal(long.profile.displayName.length, 20);
  });

  it("renames a guest still named Runner by an older client once, never a name the player chose", async () => {
    const services = await startServices();
    const legacy = device("Runner");
    const first = await services.accounts.guest(legacy);
    assert.equal(first.profile.displayName, "Runner");
    const renamed = await services.accounts.guest({ ...legacy, displayName: "Guest-48213" });
    assert.equal(renamed.profile.displayName, "Guest-48213", "the automatic name gives way to the device's name");
    const again = await services.accounts.guest({ ...legacy, displayName: "Guest-11111" });
    assert.equal(again.profile.displayName, "Guest-48213", "and is kept from then on");

    const chosen = device("Runner");
    const runner = await services.accounts.guest(chosen);
    await services.database.query("UPDATE users SET name_changed_at=? WHERE id=?", [Date.now(), runner.profile.id]);
    const kept = await services.accounts.guest({ ...chosen, displayName: "Guest-22222" });
    assert.equal(kept.profile.displayName, "Runner", "a player who picked Runner keeps it");
  });

  it("refuses a wrong secret for a known device, and malformed ids and secrets", async () => {
    const services = await startServices();
    const phone = device();
    await services.accounts.guest(phone);
    await assert.rejects(
      services.accounts.guest({ ...phone, deviceSecret: "A".repeat(40) }),
      (error: { status: number; message: string }) =>
        error.status === 401 && /Invalid device credentials/.test(error.message),
    );
    const refusals: [string, Record<string, unknown>][] = [
      ["short device id", { ...phone, deviceId: "short" }],
      ["device id with spaces", { ...phone, deviceId: "a".repeat(16) + " b" }],
      ["device id over 64 characters", { ...phone, deviceId: "a".repeat(65) }],
      ["numeric device id", { ...phone, deviceId: 1234567890123456 }],
      ["short secret", { ...phone, deviceSecret: "s".repeat(31) }],
      ["secret with symbols", { ...phone, deviceSecret: "s".repeat(31) + "!" }],
      ["secret over 128 characters", { ...phone, deviceSecret: "s".repeat(129) }],
      ["missing secret", { deviceId: phone.deviceId }],
    ];
    for (const [label, body] of refusals)
      await assert.rejects(services.accounts.guest(body), (error: { status: number }) => error.status === 400, label);
    assert.equal(Number((await services.database.query("SELECT COUNT(*) AS n FROM device_logins"))[0].n), 1);
  });

  it("gives two devices two accounts, and one account when the same new device asks twice at once", async () => {
    const services = await startServices();
    const [one, other] = [device(), device()];
    const [first, second] = [await services.accounts.guest(one), await services.accounts.guest(other)];
    assert.notEqual(first.profile.id, second.profile.id);
    const racing = device();
    const results = await Promise.all([services.accounts.guest(racing), services.accounts.guest(racing)]);
    assert.equal(results[0].profile.id, results[1].profile.id);
    const users = await services.database.query("SELECT COUNT(*) AS n FROM users");
    assert.equal(Number(users[0].n), 3, "the race did not leave a second account behind");
  });

  it("upgrades a guest to a normal account: password login works and the device keeps working", async () => {
    const services = await startServices();
    const phone = device();
    const guest = await services.accounts.guest(phone);
    await assert.rejects(
      services.accounts.login({ username: guest.profile.username, password: "any-password-at-all" }),
      /credentials/,
      "a guest has no password anyone could know",
    );
    const upgraded = await services.accounts.upgrade(guest.profile.id, {
      username: "Pat_Runner",
      password: "long-password-1",
    });
    assert.equal(upgraded.guest, false);
    assert.equal(upgraded.username, "pat_runner");
    assert.equal(upgraded.id, guest.profile.id);
    const login = await services.accounts.login({ username: "PAT_RUNNER", password: "long-password-1" });
    assert.equal(login.profile.id, guest.profile.id);
    assert.equal(login.profile.guest, false);
    const again = await services.accounts.guest(phone);
    assert.equal(again.profile.id, guest.profile.id, "the device still signs in to the upgraded account");
    assert.equal(again.profile.guest, false);
    assert.equal(again.profile.username, "pat_runner");
    await assert.rejects(
      services.accounts.upgrade(guest.profile.id, { username: "another_one", password: "long-password-2" }),
      (error: { status: number; message: string }) =>
        error.status === 409 && /already has a username/.test(error.message),
    );
  });

  it("refuses an upgrade to a taken or malformed username or a short password", async () => {
    const services = await startServices();
    await services.accounts.register({ username: "taken_name", password: "long-password-1" });
    const guest = await services.accounts.guest(device());
    const refusals: [number, RegExp, { username: unknown; password: unknown }][] = [
      [409, /unavailable/, { username: "TAKEN_NAME", password: "long-password-2" }],
      [400, /Username must/, { username: "no", password: "long-password-2" }],
      [400, /Username must/, { username: "bad name!", password: "long-password-2" }],
      [400, /Password must/, { username: "fresh_name", password: "short" }],
      [400, /Username must/, { username: 42, password: "long-password-2" }],
    ];
    for (const [status, pattern, body] of refusals)
      await assert.rejects(
        services.accounts.upgrade(guest.profile.id, body),
        (error: { status: number; message: string }) => error.status === status && pattern.test(error.message),
      );
    const unchanged = await services.accounts.profile(guest.profile.id);
    assert.equal(unchanged.guest, true);
    assert.equal(unchanged.username, guest.profile.username);
    // Chosen usernames stay unique when two guests race for the same one.
    const rival = await services.accounts.guest(device());
    const outcomes = await Promise.allSettled([
      services.accounts.upgrade(guest.profile.id, { username: "contested", password: "long-password-3" }),
      services.accounts.upgrade(rival.profile.id, { username: "contested", password: "long-password-4" }),
    ]);
    assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), ["fulfilled", "rejected"]);
  });

  it("is reachable over HTTP, shows the guest flag and upgrades only signed-in guests", async () => {
    const server = await startServer();
    const request = async (path: string, token = "", body?: unknown) => {
      const response = await fetch(server.url + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    };
    try {
      const phone = device("Pat");
      const created = await request("/api/account/guest", "", phone);
      assert.equal(created.status, 200);
      assert.deepEqual(Object.keys(created.data).sort(), ["profile", "token"]);
      assert.equal(created.data.profile.guest, true);
      assert.equal(created.data.profile.displayName, "Pat");
      assert.equal((await request("/api/social", created.data.token)).data.profile.guest, true);
      assert.equal((await request("/api/account/guest", "", { ...phone, deviceSecret: "B".repeat(40) })).status, 401);
      assert.equal((await request("/api/account/guest", "", { deviceId: "x" })).status, 400);

      assert.equal(
        (await request("/api/account/upgrade", "", { username: "pat_http", password: "long-password-1" })).status,
        401,
      );
      const upgraded = await request("/api/account/upgrade", created.data.token, {
        username: "pat_http",
        password: "long-password-1",
      });
      assert.equal(upgraded.status, 200);
      assert.equal(upgraded.data.token, created.data.token, "the session carries on");
      assert.equal(upgraded.data.profile.guest, false);
      assert.equal(upgraded.data.profile.username, "pat_http");
      assert.equal((await request("/api/social", created.data.token)).data.profile.guest, false);
      const twice = await request("/api/account/upgrade", created.data.token, {
        username: "pat_other",
        password: "long-password-1",
      });
      assert.equal(twice.status, 409);
      assert.match(twice.data.error, /already has a username/);
      const login = await request("/api/account/login", "", { username: "pat_http", password: "long-password-1" });
      assert.equal(login.data.profile.id, created.data.profile.id);
      const registered = await request("/api/account/register", "", {
        username: "regular",
        password: "long-password-2",
      });
      assert.equal(registered.data.profile.guest, false);
      assert.equal(
        (
          await request("/api/account/upgrade", registered.data.token, {
            username: "regular2",
            password: "long-password-2",
          })
        ).status,
        409,
      );
    } finally {
      await server.stop();
    }
  });
});
