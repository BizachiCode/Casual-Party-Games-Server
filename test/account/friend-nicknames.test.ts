import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startServer, type TestServer } from "../support/server.js";

const PASSWORD = "test-only-password";

describe("friend requests by nickname", () => {
  let server: TestServer;
  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.stop();
  });

  const call = async (path: string, token: string, body: unknown) => {
    const response = await fetch(server.url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const request = (token: string, typed: string) => call("/api/social/request", token, { username: typed });
  const guest = (displayName: string) =>
    server.container.accounts.guest({
      deviceId: randomUUID(),
      deviceSecret: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
      displayName,
    });

  it("finds a player by the nickname they show, ignoring case and spacing, and by username", async () => {
    const { accounts } = server.container;
    const asker = await accounts.register({ username: "nick_asker", password: PASSWORD, displayName: "Asker One" });
    const target = await guest("Sunny Panda");
    const named = await accounts.register({ username: "nick_named", password: PASSWORD, displayName: "Moonlit Fox" });

    const byNickname = await request(asker.token, "  sunny   PANDA ");
    assert.equal(byNickname.status, 200);
    assert.deepEqual(
      byNickname.data.outgoing.map((player: { id: string }) => player.id),
      [target.profile.id],
    );
    const byUsername = await request(asker.token, "@Nick_Named");
    assert.equal(byUsername.status, 200);
    assert.deepEqual(
      byUsername.data.outgoing.map((player: { id: string }) => player.id).sort(),
      [named.profile.id, target.profile.id].sort(),
    );
    assert.equal((await request(asker.token, "nobody here")).status, 404);
  });

  it("finds a renamed player by the new nickname and no longer by the old one", async () => {
    const { accounts } = server.container;
    const asker = await accounts.register({
      username: "rename_asker",
      password: PASSWORD,
      displayName: "Rename Asker",
    });
    const target = await guest("Old Nick");
    const renamed = await call("/api/account/name", target.token, { displayName: "Fresh Nick" });
    assert.equal(renamed.status, 200);

    assert.equal((await request(asker.token, "Old Nick")).status, 404);
    assert.equal((await request(asker.token, "fresh nick")).status, 200);
  });

  it("answers 404 for yourself and for a player who blocked you", async () => {
    const { accounts } = server.container;
    const asker = await accounts.register({ username: "block_asker", password: PASSWORD, displayName: "Block Asker" });
    const blocker = await accounts.register({ username: "blocker_x", password: PASSWORD, displayName: "Blocker Nick" });

    assert.equal((await request(asker.token, "block asker")).status, 404, "yourself");
    assert.equal((await call("/api/social/block", blocker.token, { userId: asker.profile.id })).status, 200);
    assert.equal((await request(asker.token, "Blocker Nick")).status, 404, "blocked, by nickname");
    assert.equal((await request(asker.token, "blocker_x")).status, 404, "blocked, by username");
    assert.equal((await request(asker.token, 7 as never)).status, 400);
  });
});
