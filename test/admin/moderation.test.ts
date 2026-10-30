import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AccountRepository } from "../../src/modules/account/account.repository.js";
import { AccountService } from "../../src/modules/account/account.service.js";
import { PresenceService } from "../../src/modules/presence/presence.service.js";
import { startFixture, waitFor, type Fixture } from "./moderation-fixture.js";

const stamp = (time: number) => new Date(time).toISOString().slice(0, 16).replace("T", " ");
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const PASSWORD = "test-only-password";

function device() {
  return {
    deviceId: randomUUID(),
    deviceSecret: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
    displayName: "Guest",
  };
}

describe("GM moderation", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await startFixture();
  });
  afterEach(async () => {
    await fx.stop();
  });

  it("keeps the endpoints behind the admin key and answers unknown players with 404", async () => {
    const player = await fx.account();
    const anonymous = await fetch(fx.server.url + `/api/admin/players/${player.id}/ban`, { method: "POST" });
    assert.equal(anonymous.status, 401);
    const missing = await fx.admin("POST", "/players/nobody/ban", { reason: "x" });
    assert.equal(missing.status, 404);
    assert.equal(missing.data.error, "Player not found.");
    for (const action of ["kick", "unban", "mute", "unmute", "sessions/revoke"])
      assert.equal((await fx.admin("POST", `/players/nobody/${action}`, { minutes: 5 })).status, 404, action);
  });

  it("bans an account: its seat and sessions end and it cannot sign in again", async () => {
    const player = await fx.account("banned");
    const seat = await fx.sit(player);
    const response = await fx.admin("POST", `/players/${player.id}/ban`, { reason: "Cheating", minutes: 60 }, "Rita");
    assert.equal(response.status, 200);
    assert.equal(response.data.ok, true);
    const { ban } = response.data;
    assert.equal(ban.reason, "Cheating");
    assert.equal(ban.createdBy, "Rita");
    assert.ok(Math.abs(ban.until - (Date.now() + 3600000)) < 10000);

    await waitFor(() => seat.closed !== undefined, "seat removed");
    assert.equal(seat.closed, 4003);
    assert.deepEqual(seat.notices, ["Your account was suspended."]);
    assert.equal((await fx.api("GET", "/social", player.token)).status, 401, "the session was revoked");

    const login = await fx.api("POST", "/account/login", "", { username: player.username, password: PASSWORD });
    assert.equal(login.status, 403);
    assert.equal(login.data.error, `Account suspended until ${stamp(ban.until)} UTC. Reason: Cheating`);
    const wrong = await fx.api("POST", "/account/login", "", { username: player.username, password: "wrong-password" });
    assert.equal(wrong.status, 401, "the ban is only revealed after the password check");

    const listed = (await fx.admin("GET", "/moderation/bans")).data;
    assert.equal(listed.total, 1);
    assert.equal(listed.entries[0].player.id, player.id);
    assert.equal(listed.entries[0].player.username, player.username);
    assert.equal(listed.entries[0].reason, "Cheating");

    const audit = (await fx.admin("GET", `/audit?action=player.ban&target=${player.id}`)).data;
    assert.equal(audit.total, 1);
    assert.equal(audit.entries[0].operator, "Rita");
    assert.equal(audit.entries[0].details.minutes, 60);
    assert.equal(audit.entries[0].details.until, ban.until);
  });

  it("refuses a banned guest device at sign-in", async () => {
    const phone = device();
    const guest = await fx.api("POST", "/account/guest", "", phone);
    assert.equal(guest.status, 200);
    const id = guest.data.profile.id;
    assert.equal((await fx.admin("POST", `/players/${id}/ban`, { reason: "Abuse" })).status, 200);
    assert.equal((await fx.api("GET", "/social", guest.data.token)).status, 401);
    const again = await fx.api("POST", "/account/guest", "", phone);
    assert.equal(again.status, 403);
    assert.equal(again.data.error, "Account suspended permanently. Reason: Abuse");
    await assert.rejects(fx.server.container.accounts.guest(phone), /suspended permanently/);
    const forged = await fx.api("POST", "/account/guest", "", { ...phone, deviceSecret: "x".repeat(40) });
    assert.equal(forged.status, 401, "a wrong secret is refused as such");
  });

  it("ends a temporary ban by itself, says so for a permanent one and lifts bans on request", async () => {
    const player = await fx.account("temp");
    const credentials = { username: player.username, password: PASSWORD };
    const quiet = await fx.admin("POST", `/players/${player.id}/ban`, { minutes: 5 });
    const expected = `Account suspended until ${stamp(quiet.data.ban.until)} UTC.`;
    assert.equal((await fx.api("POST", "/account/login", "", credentials)).data.error, expected, "no empty reason");

    const { database } = fx.server.container;
    await database.query("UPDATE bans SET until = ? WHERE user_id = ?", [Date.now() - 1000, player.id]);
    assert.equal((await fx.admin("GET", "/moderation/bans")).data.total, 0, "an expired ban is not listed");
    assert.equal((await fx.api("POST", "/account/login", "", credentials)).status, 200);

    for (const minutes of [null, 0, undefined]) {
      const permanent = await fx.admin("POST", `/players/${player.id}/ban`, { reason: "Chargeback", minutes });
      assert.equal(permanent.data.ban.until, null);
    }
    const refused = await fx.api("POST", "/account/login", "", credentials);
    assert.equal(refused.data.error, "Account suspended permanently. Reason: Chargeback");
    assert.equal((await fx.admin("GET", "/moderation/bans")).data.total, 1, "a second ban replaces the first");

    assert.deepEqual((await fx.admin("POST", `/players/${player.id}/unban`)).data, { ok: true, removed: true });
    assert.equal((await fx.api("POST", "/account/login", "", credentials)).status, 200);
    assert.equal((await fx.admin("POST", `/players/${player.id}/unban`)).data.removed, false);
    assert.equal((await fx.admin("GET", "/audit?action=player.unban")).data.total, 2);
  });

  it("validates ban and mute payloads", async () => {
    const player = await fx.account();
    const path = `/players/${player.id}`;
    assert.equal((await fx.admin("POST", path + "/ban", { minutes: -1 })).status, 400);
    assert.equal((await fx.admin("POST", path + "/ban", { minutes: 5256001 })).status, 400);
    assert.equal((await fx.admin("POST", path + "/ban", { minutes: 1.5 })).status, 400);
    assert.equal((await fx.admin("POST", path + "/ban", { reason: "x".repeat(281) })).status, 400);
    const noMinutes = await fx.admin("POST", path + "/mute", { reason: "No minutes" });
    assert.equal(noMinutes.data.error, "Choose how many minutes to mute.");
    assert.equal((await fx.admin("POST", path + "/mute", { minutes: 0 })).status, 400);
    assert.equal((await fx.admin("POST", path + "/mute", { minutes: 525601 })).status, 400);
    assert.equal((await fx.admin("POST", path + "/kick", { message: "x".repeat(181) })).status, 400);
    assert.equal((await fx.admin("GET", "/moderation/bans")).data.total, 0, "nothing was stored");
    assert.equal((await fx.admin("GET", "/moderation/mutes")).data.total, 0);
  });

  it("mutes match chat: the muted player is told, others are not, and unmuting restores chat", async () => {
    const [talker, listener] = [await fx.account("talker"), await fx.account("listener")];
    const first = await fx.sit(talker);
    const second = await fx.sit(listener, first.room.roomId);
    const mute = await fx.admin("POST", `/players/${talker.id}/mute`, { reason: "Spam", minutes: 30 }, "Rita");
    assert.equal(mute.status, 200);
    assert.equal(mute.data.mute.reason, "Spam");
    assert.ok(Math.abs(mute.data.mute.until - (Date.now() + 1800000)) < 10000);
    const notice = /^Your chat is muted until (\d{4}-\d{2}-\d{2} )?\d{2}:\d{2} UTC\.$/;
    await waitFor(() => first.notices.length === 1, "mute notice");
    assert.match(first.notices[0], notice);
    assert.deepEqual(second.notices, [], "other players are not told");

    first.room.send("chat", "muted words");
    await waitFor(() => first.notices.length === 2, "chat notice");
    assert.match(first.notices[1], notice);
    second.room.send("chat", "hello there");
    await waitFor(() => first.chats.length === 1 && second.chats.length === 1, "listener chat");
    assert.equal(first.chats[0].text, "hello there");
    assert.equal(second.chats.length, 1, "the muted message reached nobody");
    const logged = fx.server.container.chatLog.recent({ roomId: first.room.roomId });
    assert.deepEqual(
      logged.map(line => [line.accountId, line.text]),
      [[listener.id, "hello there"]],
    );

    const listed = (await fx.admin("GET", "/moderation/mutes")).data;
    assert.equal(listed.total, 1);
    assert.equal(listed.entries[0].player.id, talker.id);
    assert.equal(listed.entries[0].until, mute.data.mute.until);

    assert.deepEqual((await fx.admin("POST", `/players/${talker.id}/unmute`)).data, { ok: true, removed: true });
    await pause(1200); // chat is limited to one message per second
    first.room.send("chat", "free again");
    await waitFor(() => second.chats.length === 2, "unmuted chat");
    assert.equal(second.chats[1].text, "free again");
    const lines = fx.server.container.chatLog.recent({ roomId: first.room.roomId });
    assert.equal(lines[0].text, "free again");
    assert.equal(lines[0].accountId, talker.id);
    assert.equal(lines[0].sessionId, first.room.sessionId);
    assert.ok(lines[0].name.length > 0);
    assert.ok(Math.abs(lines[0].at - Date.now()) < 10000);
    assert.equal((await fx.admin("POST", `/players/${talker.id}/unmute`)).data.removed, false);
    assert.equal((await fx.admin("GET", "/moderation/mutes")).data.total, 0);
    assert.equal((await fx.admin("GET", "/audit?action=player.mute")).data.entries[0].details.minutes, 30);
  });

  it("does not count an expired mute", async () => {
    const player = await fx.account();
    const other = await fx.account();
    const seat = await fx.sit(player);
    const listener = await fx.sit(other, seat.room.roomId);
    await fx.server.container.database.query(
      "INSERT INTO mutes (user_id, reason, until, created_at, created_by) VALUES (?, 'old', ?, ?, 'Rita')",
      [player.id, Date.now() - 1000, Date.now() - 60000],
    );
    assert.equal((await fx.admin("GET", "/moderation/mutes")).data.total, 0);
    assert.equal(await fx.server.container.moderation.activeMute(player.id), null);
    seat.room.send("chat", "back");
    await waitFor(() => listener.chats.length === 1, "chat delivered");
    assert.deepEqual(seat.notices, []);
  });

  it("kicks an account from its match and party and keeps it out of those rooms", async () => {
    const [host, guest, member] = [await fx.account("host"), await fx.account("guest"), await fx.account("member")];
    const lobby = await fx.sit(host);
    const kicked = await fx.sit(guest, lobby.room.roomId);
    const party = await fx.squad(member);

    const kick = await fx.admin("POST", `/players/${guest.id}/kick`, { message: "Behave, please." });
    assert.deepEqual(kick.data, { ok: true, removed: 1 });
    await waitFor(() => kicked.closed !== undefined, "kick");
    assert.equal(kicked.closed, 4003);
    assert.deepEqual(kicked.notices, ["Behave, please."]);
    assert.equal(lobby.room.connection.isOpen, true, "the others stay");
    await assert.rejects(fx.sit(guest, lobby.room.roomId), /Removed from this lobby/);
    assert.equal((await fx.api("GET", "/social", guest.token)).status, 200, "a kick does not end the session");

    const partyKick = await fx.admin("POST", `/players/${member.id}/kick`);
    assert.equal(partyKick.data.removed, 1);
    await waitFor(() => party.closed !== undefined, "party kick");
    assert.equal(party.closed, 4003);
    assert.deepEqual(party.notices, ["Removed by a moderator."]);

    assert.equal((await fx.admin("POST", `/players/${guest.id}/kick`)).data.removed, 0, "nothing left to remove");
    const audit = (await fx.admin("GET", `/audit?action=player.kick&target=${guest.id}`)).data;
    assert.equal(audit.total, 2);
  });

  it("revokes sessions: the token stops working and the seat ends, but the account can sign in again", async () => {
    const player = await fx.account("revoked");
    const second = await fx.server.container.accounts.login({ username: player.username, password: PASSWORD });
    const seat = await fx.sit(player);
    const revoke = await fx.admin("POST", `/players/${player.id}/sessions/revoke`, undefined, "Ivy");
    assert.deepEqual(revoke.data, { ok: true, sessions: 2 });
    await waitFor(() => seat.closed !== undefined, "seat ended");
    assert.equal(seat.closed, 4001);
    assert.equal((await fx.api("GET", "/social", player.token)).status, 401);
    assert.equal((await fx.api("GET", "/social", second.token)).status, 401);
    const login = await fx.api("POST", "/account/login", "", { username: player.username, password: PASSWORD });
    assert.equal(login.status, 200);
    const audit = (await fx.admin("GET", "/audit?action=player.sessions.revoke")).data;
    assert.equal(audit.entries[0].operator, "Ivy");
    assert.equal(audit.entries[0].targetId, player.id);
  });

  it("records when an account was created and last seen, writing the last-seen time rarely", async () => {
    const { database, accounts } = fx.server.container;
    const before = Date.now();
    const player = await fx.account("seen");
    await accounts.guest(device());
    for (const row of await database.query("SELECT created_at, last_seen FROM users")) {
      assert.ok(Number(row.created_at) >= before, "created_at is set");
      assert.ok(Number(row.last_seen) >= before, "last_seen is set when the session opens");
    }

    // A request right after signing in does not write again; one from a process that has not seen the account does.
    const lastSeen = async () =>
      Number((await database.query("SELECT last_seen FROM users WHERE id = ?", [player.id]))[0].last_seen);
    await database.query("UPDATE users SET last_seen = 1 WHERE id = ?", [player.id]);
    await accounts.authenticate(player.token);
    await pause(100);
    assert.equal(await lastSeen(), 1);
    const fresh = new AccountService(new AccountRepository(database), new PresenceService());
    await fresh.authenticate(player.token);
    await waitFor(async () => (await lastSeen()) > before, "last seen written");
  });
});
