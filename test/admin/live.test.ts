import assert from "node:assert/strict";
import { startFixture, waitFor, type Fixture } from "./moderation-fixture.js";

describe("GM live operations", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await startFixture();
  });
  afterEach(async () => {
    await fx.stop();
  });

  const auditFor = async (action: string) => (await fx.admin("GET", `/audit?action=${action}`)).data;

  it("keeps the live endpoints behind the admin key", async () => {
    for (const path of ["/live/status", "/live/rooms", "/live/chat"])
      assert.equal((await fetch(fx.server.url + "/api/admin" + path)).status, 401, path);
    const posted = await fetch(fx.server.url + "/api/admin/live/broadcast", { method: "POST" });
    assert.equal(posted.status, 401);
  });

  it("reports the service status with the open reports", async () => {
    const empty = (await fx.admin("GET", "/live/status")).data;
    assert.equal(empty.openReports, 0);
    assert.equal(empty.status.rooms, 0);
    assert.equal(empty.status.maintenance, false);
    assert.equal(empty.status.draining, false);
    assert.equal(typeof empty.status.uptimeSeconds, "number");
    const [reporter, target] = [await fx.account(), await fx.account()];
    await fx.api("POST", "/reports", reporter.token, { reason: "abuse", userId: target.id });
    assert.equal((await fx.admin("GET", "/live/status")).data.openReports, 1);
    const lobby = await fx.sit(reporter);
    const live = (await fx.admin("GET", "/live/status")).data;
    assert.equal(live.status.rooms, 1);
    assert.equal(live.status.connectedClients, 1);
    assert.ok(lobby.room.roomId);
  });

  it("lists the match and party rooms and describes each one", async () => {
    const [host, guest, leader] = [await fx.account("host"), await fx.account("guest"), await fx.account("leader")];
    const lobby = await fx.sit(host);
    await fx.sit(guest, lobby.room.roomId);
    const party = await fx.squad(leader);
    const { matches } = fx.server.container;
    await waitFor(() => matches.get(lobby.room.roomId).humanCount === 2, "both seated");

    const rooms = (await fx.admin("GET", "/live/rooms")).data;
    assert.equal(rooms.matches.length, 1);
    const [match] = rooms.matches;
    const room = matches.get(lobby.room.roomId);
    assert.deepEqual(match, {
      roomId: lobby.room.roomId,
      kind: "private",
      queue: "",
      eventId: "",
      mode: room.simulation.rules.mode,
      playlist: room.simulation.rules.playlist,
      phase: "lobby",
      round: 0,
      remaining: match.remaining,
      locked: false,
      humans: 2,
      bots: 0,
      maxClients: room.maxClients,
      hostName: (await fx.server.container.accounts.profile(host.id)).displayName,
      openedAt: match.openedAt,
    });
    assert.ok(Math.abs(match.openedAt - Date.now()) < 30000);
    assert.equal(typeof match.remaining, "number");
    assert.equal(rooms.squads.length, 1);
    const [squad] = rooms.squads;
    assert.deepEqual(squad, {
      roomId: party.room.roomId,
      status: "idle",
      size: 1,
      maxMembers: fx.server.container.matchmaking.maxPartyMembers,
      leaderName: (await fx.server.container.accounts.profile(leader.id)).displayName,
      members: [{ accountId: leader.id, name: squad.leaderName }],
    });
    assert.deepEqual(rooms.totals, { matches: 1, humans: 2, bots: 0, squads: 1, partyMembers: 1 });

    lobby.room.send("chat", "hello lobby");
    await waitFor(() => lobby.chats.length === 1, "chat");
    const detail = (await fx.admin("GET", `/live/rooms/${lobby.room.roomId}`)).data;
    assert.equal(detail.kind, "match");
    assert.deepEqual(detail.room, match);
    assert.equal(detail.players.length, 2);
    const hostRow = detail.players.find((player: { accountId: string }) => player.accountId === host.id);
    assert.equal(hostRow.sessionId, lobby.room.sessionId);
    assert.equal(hostRow.bot, false);
    assert.equal(hostRow.connected, true);
    assert.equal(hostRow.host, true);
    assert.equal(hostRow.ready, false);
    assert.equal(hostRow.characterId, "rookie");
    for (const key of ["status", "team", "score", "totalScore", "finishTime", "name"]) assert.ok(key in hostRow, key);
    assert.equal(detail.players.filter((player: { host: boolean }) => player.host).length, 1);
    assert.equal(detail.chat.length, 1);
    assert.equal(detail.chat[0].text, "hello lobby");
    assert.equal(detail.chat[0].accountId, host.id);

    const squadDetail = (await fx.admin("GET", `/live/rooms/${party.room.roomId}`)).data;
    assert.deepEqual(squadDetail, { kind: "squad", room: squad });
    const missing = await fx.admin("GET", "/live/rooms/unknown");
    assert.equal(missing.status, 404);
    assert.equal(missing.data.error, "Room not found.");
  });

  it("sends a notice to one room, and a broadcast to every match and party", async () => {
    const [first, second, leader] = [await fx.account(), await fx.account(), await fx.account()];
    const lobby = await fx.sit(first);
    const other = await fx.sit(second);
    const party = await fx.squad(leader);

    const sent = await fx.admin(
      "POST",
      `/live/rooms/${lobby.room.roomId}/notice`,
      { message: "<b>Match</b> soon" },
      "Ivy",
    );
    assert.deepEqual(sent.data, { ok: true, recipients: 1 });
    await waitFor(() => lobby.notices.length === 1, "room notice");
    assert.equal(lobby.notices[0], "bMatch/b soon");
    assert.deepEqual(other.notices, []);
    const squadNotice = await fx.admin("POST", `/live/rooms/${party.room.roomId}/notice`, { message: "Party news" });
    assert.equal(squadNotice.data.recipients, 1);
    await waitFor(() => party.notices.length === 1, "party notice");

    for (const message of ["", "   ", "x".repeat(181), undefined])
      assert.equal((await fx.admin("POST", `/live/rooms/${lobby.room.roomId}/notice`, { message })).status, 400);
    assert.equal((await fx.admin("POST", "/live/rooms/unknown/notice", { message: "Hi" })).status, 404);

    const broadcast = await fx.admin("POST", "/live/broadcast", { message: "Maintenance at noon" }, "Ivy");
    assert.deepEqual(broadcast.data, { ok: true, rooms: 3, recipients: 3 });
    await waitFor(
      () => [lobby, other, party].every(seat => seat.notices.at(-1) === "Maintenance at noon"),
      "broadcast",
    );
    assert.equal((await fx.admin("POST", "/live/broadcast", { message: "" })).status, 400);

    const notices = await auditFor("room.notice");
    assert.equal(notices.total, 2);
    assert.equal(notices.entries[1].operator, "Ivy");
    assert.equal(notices.entries[1].details.roomId, lobby.room.roomId);
    assert.equal((await auditFor("broadcast")).entries[0].details.recipients, 3);
  });

  it("kicks one seat of a room", async () => {
    const [host, guest, leader, member] = [
      await fx.account("host"),
      await fx.account("guest"),
      await fx.account("leader"),
      await fx.account("member"),
    ];
    const lobby = await fx.sit(host);
    const kicked = await fx.sit(guest, lobby.room.roomId);
    const path = `/live/rooms/${lobby.room.roomId}/kick`;
    assert.equal((await fx.admin("POST", path, {})).status, 400);
    const unknown = await fx.admin("POST", path, { sessionId: "nobody" });
    assert.equal(unknown.status, 404);
    const bots = await fx.admin("POST", "/live/rooms/unknown/kick", { sessionId: kicked.room.sessionId });
    assert.equal(bots.status, 404);

    const response = await fx.admin("POST", path, { sessionId: kicked.room.sessionId, message: "Out." }, "Ivy");
    assert.deepEqual(response.data, { ok: true });
    await waitFor(() => kicked.closed !== undefined, "kick");
    assert.equal(kicked.closed, 4003);
    assert.deepEqual(kicked.notices, ["Out."]);
    assert.equal(lobby.room.connection.isOpen, true);
    await assert.rejects(fx.sit(guest, lobby.room.roomId), /Removed from this lobby/);
    const entry = (await auditFor("room.kick")).entries[0];
    assert.equal(entry.targetId, guest.id);
    assert.equal(entry.operator, "Ivy");
    assert.equal(entry.details.sessionId, kicked.room.sessionId);

    const party = await fx.squad(leader);
    const seated = await fx.squad(member, party.room.roomId);
    const partyKick = await fx.admin("POST", `/live/rooms/${party.room.roomId}/kick`, {
      sessionId: seated.room.sessionId,
    });
    assert.equal(partyKick.status, 200);
    await waitFor(() => seated.closed !== undefined, "party kick");
    assert.equal(seated.closed, 4003);
    assert.deepEqual(seated.notices, ["Removed by a moderator."]);
  });

  it("holds a seat on hold apart from connected players and removes it on request", async () => {
    const [host, guest] = [await fx.account("host"), await fx.account("guest")];
    const lobby = await fx.sit(host);
    const dropped = await fx.sit(guest, lobby.room.roomId);
    const room = fx.server.container.matches.get(lobby.room.roomId);
    const sessionId = dropped.room.sessionId;
    await waitFor(() => room.clients.find(seat => seat.sessionId === sessionId)?.state === 1, "join acknowledged");
    (room.clients.find(seat => seat.sessionId === sessionId).ref as unknown as { terminate(): void }).terminate();
    await waitFor(() => room.suspended.has(sessionId), "seat on hold");

    const detail = (await fx.admin("GET", `/live/rooms/${room.roomId}`)).data;
    const held = detail.players.find((player: { sessionId: string }) => player.sessionId === sessionId);
    assert.equal(held.connected, false);
    assert.equal(held.accountId, guest.id);
    assert.equal(detail.room.humans, 2, "a seat on hold still counts");

    const kick = await fx.admin("POST", `/live/rooms/${room.roomId}/kick`, { sessionId });
    assert.equal(kick.status, 200);
    await waitFor(() => !room.suspended.has(sessionId), "seat released");
    await assert.rejects(fx.sit(guest, room.roomId), /Removed from this lobby/);
  });

  it("closes a match: everyone is told, disconnected, and the room is gone", async () => {
    const [first, second, leader] = [await fx.account(), await fx.account(), await fx.account()];
    const lobby = await fx.sit(first);
    const guest = await fx.sit(second, lobby.room.roomId);
    const party = await fx.squad(leader);
    const roomId = lobby.room.roomId;

    assert.equal((await fx.admin("POST", "/live/rooms/unknown/close", {})).status, 404);
    assert.equal((await fx.admin("POST", `/live/rooms/${party.room.roomId}/close`, {})).status, 404, "matches only");
    const closed = await fx.admin("POST", `/live/rooms/${roomId}/close`, undefined, "Ivy");
    assert.deepEqual(closed.data, { ok: true });
    await waitFor(() => lobby.closed !== undefined && guest.closed !== undefined, "players disconnected");
    assert.equal(lobby.closed, 4003);
    assert.equal(guest.closed, 4003);
    assert.deepEqual(lobby.notices, ["This match was closed by a moderator."]);
    assert.deepEqual(guest.notices, ["This match was closed by a moderator."]);
    await waitFor(() => !fx.server.container.matches.get(roomId), "room disposed");
    assert.equal((await fx.admin("GET", `/live/rooms/${roomId}`)).status, 404);
    assert.equal(party.room.connection.isOpen, true, "parties stay");

    const again = await fx.sit(first);
    const custom = await fx.admin("POST", `/live/rooms/${again.room.roomId}/close`, { message: "Closing for tests." });
    assert.equal(custom.status, 200);
    await waitFor(() => again.closed !== undefined, "second close");
    assert.deepEqual(again.notices, ["Closing for tests."]);
    const audit = await auditFor("room.close");
    assert.equal(audit.total, 2);
    assert.equal(audit.entries[1].operator, "Ivy");
    assert.equal(audit.entries[1].details.roomId, roomId);
  });

  it("searches the chat log by room, account and text, newest first", async () => {
    const [first, second] = [await fx.account("first"), await fx.account("second")];
    const lobby = await fx.sit(first);
    const guest = await fx.sit(second, lobby.room.roomId);
    lobby.room.send("chat", "alpha one");
    await waitFor(() => guest.chats.length === 1, "first line");
    guest.room.send("chat", "Bravo two");
    await waitFor(() => lobby.chats.length === 2, "second line");
    const roomId = lobby.room.roomId;

    const all = (await fx.admin("GET", `/live/chat?roomId=${roomId}`)).data.lines;
    assert.deepEqual(
      all.map((line: { text: string }) => line.text),
      ["Bravo two", "alpha one"],
    );
    assert.deepEqual(Object.keys(all[0]).sort(), ["accountId", "at", "name", "roomId", "sessionId", "text"]);
    const byAccount = (await fx.admin("GET", `/live/chat?account=${first.id}`)).data.lines;
    assert.deepEqual(
      byAccount.map((line: { text: string }) => line.text),
      ["alpha one"],
    );
    const byText = (await fx.admin("GET", "/live/chat?q=BRAVO")).data.lines;
    assert.equal(byText.length, 1);
    assert.equal(byText[0].accountId, second.id);
    assert.equal((await fx.admin("GET", "/live/chat?limit=1")).data.lines.length, 1);
    assert.equal((await fx.admin("GET", "/live/chat?roomId=elsewhere")).data.lines.length, 0);
  });

  it("switches maintenance on and off", async () => {
    const player = await fx.account();
    const on = await fx.admin("POST", "/live/maintenance", { enabled: true, message: "Back at noon" }, "Ivy");
    assert.equal(on.data.ok, true);
    assert.equal(on.data.status.maintenance, true);
    assert.equal(on.data.status.message, "Back at noon");
    assert.equal(on.data.status.admissionsOpen, false);
    assert.equal((await fx.api("GET", "/service/status")).data.maintenance, true);
    await assert.rejects(fx.sit(player), /Back at noon/);
    assert.equal((await fx.admin("GET", "/live/status")).data.status.maintenance, true);

    const off = await fx.admin("POST", "/live/maintenance", { enabled: false });
    assert.equal(off.data.status.maintenance, false);
    assert.equal(off.data.status.admissionsOpen, true);
    assert.ok(await fx.sit(player));
    assert.equal((await fx.admin("POST", "/live/maintenance", { message: "No flag" })).status, 400);
    assert.equal(
      (await fx.admin("POST", "/live/maintenance", { enabled: true, message: "x".repeat(181) })).status,
      400,
    );

    const audit = await auditFor("service.maintenance");
    assert.equal(audit.total, 2);
    assert.equal(audit.entries[1].operator, "Ivy");
    assert.deepEqual(audit.entries[1].details, { enabled: true, message: "Back at noon" });
  });

  it("starts a drain: no new matches are admitted", async () => {
    const player = await fx.account();
    const drained = await fx.admin("POST", "/live/drain", { message: "Restarting now" }, "Ivy");
    assert.equal(drained.data.ok, true);
    assert.equal(drained.data.status.draining, true);
    assert.equal(drained.data.status.message, "Restarting now");
    assert.equal(drained.data.status.admissionsOpen, false);
    await assert.rejects(fx.sit(player), /Restarting now/);
    assert.equal((await fx.admin("GET", "/live/status")).data.status.draining, true);
    assert.equal((await fx.admin("POST", "/live/drain", { message: "x".repeat(181) })).status, 400);
    const audit = await auditFor("service.drain");
    assert.equal(audit.total, 1);
    assert.equal(audit.entries[0].operator, "Ivy");
  });
});
