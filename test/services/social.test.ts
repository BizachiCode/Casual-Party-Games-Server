import assert from "node:assert/strict";
import { startServices, testDatabaseUrl } from "../support/server.js";

describe("accounts and friends", () => {
  it("keeps accounts, hashed secrets, sessions and friendships across a database restart", async () => {
    const url = await testDatabaseUrl();
    let services = await startServices({}, url);
    const alice = await services.accounts.register({
      username: "alice",
      displayName: "Alice",
      password: "test-password-1",
    });
    const bobby = await services.accounts.register({ username: "bobby", password: "test-password-2" });
    assert.notEqual(
      (await services.database.query("SELECT token_hash FROM sessions LIMIT 1"))[0].token_hash,
      alice.token,
    );
    assert.notEqual(
      (await services.database.query("SELECT password_hash FROM users LIMIT 1"))[0].password_hash,
      "test-password-1",
    );
    await services.social.request(alice.profile.id, "bobby");
    assert.equal((await services.social.state(bobby.profile.id)).friends.length, 0);
    await assert.rejects(services.social.respond(alice.profile.id, bobby.profile.id, true), /not found/);
    await services.social.respond(bobby.profile.id, alice.profile.id, true);
    assert.equal((await services.social.state(alice.profile.id)).friends.length, 1);
    await assert.rejects(services.accounts.login({ username: "alice", password: "wrong-password" }), /credentials/);
    await assert.rejects(services.accounts.register({ username: "ALICE", password: "test-password-3" }), /unavailable/);
    await services.stop();

    services = await startServices({}, url);
    assert.equal((await services.accounts.authenticate(alice.token)).id, alice.profile.id);
    assert.equal((await services.social.state(bobby.profile.id)).friends.length, 1);
    await services.social.block(bobby.profile.id, alice.profile.id);
    assert.equal((await services.social.state(alice.profile.id)).friends.length, 0);
    await assert.rejects(services.social.request(alice.profile.id, "bobby"), /unavailable/);
    await services.accounts.logout(alice.token);
    assert.equal(await services.accounts.authenticate(alice.token), null);
  });
});
