import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startFixture, waitFor, type Account, type Fixture, type Seat } from "./moderation-fixture.js";

const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const PASSWORD = "test-only-password";

describe("player reports", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await startFixture();
  });
  afterEach(async () => {
    await fx.stop();
  });

  /** A lobby of a reporter and a target, in which the target said something. */
  async function lobby(): Promise<{ reporter: Seat; target: Seat; reportBody: Record<string, unknown> }> {
    const reporter = await fx.sit(await fx.account("reporter"));
    const target = await fx.sit(await fx.account("target"), reporter.room.roomId);
    target.room.send("chat", "you are all terrible");
    await waitFor(() => reporter.chats.length === 1, "chat");
    const reportBody = { reason: "abuse", roomId: reporter.room.roomId, sessionId: target.room.sessionId };
    return { reporter, target, reportBody };
  }

  /** Reports `target` for one reason as a new player would, by account id. */
  async function reportBy(target: Account, reporter?: Account) {
    const player = reporter ?? (await fx.account("witness"));
    return fx.api("POST", "/reports", player.token, { reason: "cheating", userId: target.id });
  }

  it("files a report by match seat with the chat as evidence, and lists it for the console", async () => {
    const { reporter, target, reportBody } = await lobby();
    const filed = await fx.api("POST", "/reports", reporter.account.token, { ...reportBody, details: "<b>rude</b>" });
    assert.equal(filed.status, 201);
    assert.equal(filed.data.ok, true);

    const listed = (await fx.admin("GET", "/reports")).data;
    assert.equal(listed.total, 1);
    assert.equal(listed.open, 1);
    const [row] = listed.reports;
    assert.equal(row.id, filed.data.reportId);
    assert.equal(row.reporter.id, reporter.account.id);
    assert.equal(row.reporter.username, reporter.account.username);
    assert.equal(row.target.id, target.account.id);
    assert.equal(row.reason, "abuse");
    assert.equal(row.details, "brude/b", "details are cleaned like any player text");
    assert.equal(row.roomId, reporter.room.roomId);
    assert.equal(row.status, "open");
    assert.equal(row.resolution, "");
    assert.equal(row.handledAt, null);
    assert.equal(row.evidenceCount, 1);
    assert.equal(row.targetOpenReports, 1);
    assert.ok(Math.abs(row.createdAt - Date.now()) < 10000);

    const detail = (await fx.admin("GET", `/reports/${row.id}`)).data.report;
    assert.equal(detail.id, row.id);
    assert.equal(detail.evidence.length, 1);
    assert.equal(detail.evidence[0].text, "you are all terrible");
    assert.equal(detail.evidence[0].accountId, target.account.id);
    assert.equal(detail.evidence[0].roomId, reporter.room.roomId);
    assert.equal((await fx.admin("GET", "/reports/missing")).status, 404);
  });

  it("files a report by account id and refuses what it should", async () => {
    const [reporter, target] = [await fx.account("reporter"), await fx.account("target")];
    assert.equal((await fx.api("POST", "/reports", "", { reason: "abuse", userId: target.id })).status, 401);
    const bad = (body: object) => fx.api("POST", "/reports", reporter.token, body);
    assert.equal((await bad({ reason: "bad", userId: target.id })).status, 400);
    assert.equal((await bad({ reason: "abuse" })).status, 400, "somebody must be named");
    assert.equal((await bad({ reason: "abuse", userId: target.id, details: "x".repeat(281) })).status, 400);
    const self = await bad({ reason: "abuse", userId: reporter.id });
    assert.equal(self.status, 400);
    assert.equal(self.data.error, "You cannot report yourself.");
    assert.equal((await bad({ reason: "abuse", userId: randomUUID() })).status, 404);

    const filed = await bad({ reason: "cheating", userId: target.id });
    assert.equal(filed.status, 201);
    const row = (await fx.admin("GET", "/reports")).data.reports[0];
    assert.equal(row.reason, "cheating");
    assert.equal(row.roomId, "");
    assert.equal(row.evidenceCount, 0);
  });

  it("treats empty strings as absent fields, as the Unity client sends them", async () => {
    const { reporter, target, reportBody } = await lobby();
    const bySeat = await fx.api("POST", "/reports", reporter.account.token, {
      reason: "other",
      details: "",
      userId: "",
      roomId: reportBody.roomId,
      sessionId: reportBody.sessionId,
    });
    assert.equal(bySeat.status, 201);
    const row = (await fx.admin("GET", `/reports/${bySeat.data.reportId}`)).data.report;
    assert.equal(row.target.id, target.account.id);
    assert.equal(row.details, "");
    assert.equal(row.roomId, reporter.room.roomId);
    assert.equal(row.evidence.length, 1);

    const other = await fx.account("other");
    const byId = await fx.api("POST", "/reports", reporter.account.token, {
      reason: "name",
      details: "",
      userId: other.id,
      roomId: "",
      sessionId: "",
    });
    assert.equal(byId.status, 201);
    const stored = (await fx.admin("GET", `/reports/${byId.data.reportId}`)).data.report;
    assert.equal(stored.target.id, other.id);
    assert.equal(stored.roomId, "");

    const nobody = await fx.api("POST", "/reports", reporter.account.token, {
      reason: "other",
      details: "",
      userId: "",
      roomId: "",
      sessionId: "",
    });
    assert.equal(nobody.status, 400);
    assert.equal(nobody.data.error, "Choose a player to report.");
  });

  it("checks the match seat of a report: both players must sit in that room", async () => {
    const { reporter, target, reportBody } = await lobby();
    const outsider = await fx.account("outsider");
    const outside = await fx.api("POST", "/reports", outsider.token, reportBody);
    assert.equal(outside.status, 403, "a player that is not in the room cannot report its players");
    const bot = await fx.api("POST", "/reports", reporter.account.token, { ...reportBody, sessionId: "nobody" });
    assert.equal(bot.status, 404);
    assert.equal(bot.data.error, "Player unavailable.");
    const self = await fx.api("POST", "/reports", target.account.token, reportBody);
    assert.equal(self.status, 400, "the target of the seat is the reporter");
    assert.equal(self.data.error, "You cannot report yourself.");
    assert.equal((await fx.admin("GET", "/reports?status=all")).data.total, 0);
  });

  it("does not duplicate an open report of the same player about the same target", async () => {
    const { reporter, reportBody } = await lobby();
    const first = await fx.api("POST", "/reports", reporter.account.token, reportBody);
    const second = await fx.api("POST", "/reports", reporter.account.token, { ...reportBody, reason: "cheating" });
    assert.equal(second.status, 200);
    assert.deepEqual(second.data, { ok: true, reportId: first.data.reportId, duplicate: true });
    assert.equal((await fx.admin("GET", "/reports")).data.total, 1);

    // Once it was handled, or after a day, a new report is allowed.
    await fx.admin("POST", `/reports/${first.data.reportId}/dismiss`);
    const again = await fx.api("POST", "/reports", reporter.account.token, reportBody);
    assert.equal(again.status, 201);
    await fx.server.container.database.query("UPDATE reports SET created_at = ? WHERE id = ?", [
      Date.now() - 25 * 3600000,
      again.data.reportId,
    ]);
    const later = await fx.api("POST", "/reports", reporter.account.token, reportBody);
    assert.equal(later.status, 201);
    assert.notEqual(later.data.reportId, again.data.reportId);
  });

  it("allows ten reports an hour per player", async () => {
    const reporter = await fx.account("busy");
    for (let i = 0; i < 10; i++) assert.equal((await reportBy(await fx.account("target"), reporter)).status, 201);
    const target = await fx.account("target");
    const limited = await reportBy(target, reporter);
    assert.equal(limited.status, 429);
    assert.equal(limited.data.error, "Too many reports. Retry later.");
    assert.equal((await reportBy(target)).status, 201, "another player is not limited");
    await fx.server.container.database.query("UPDATE reports SET created_at = ? WHERE reporter_id = ?", [
      Date.now() - 2 * 3600000,
      reporter.id,
    ]);
    assert.equal((await reportBy(target, reporter)).status, 201, "the window moves on");
  });

  it("lists reports by status, target and reporter, newest first", async () => {
    const [first, second] = [await fx.account("first"), await fx.account("second")];
    const one = await reportBy(first);
    await pause(5);
    const two = await reportBy(second);
    await pause(5);
    const three = await reportBy(second);
    assert.equal(three.status, 201);
    const open = (await fx.admin("GET", "/reports")).data;
    assert.deepEqual(
      open.reports.map((row: { id: string }) => row.id),
      [three.data.reportId, two.data.reportId, one.data.reportId],
    );
    assert.equal(open.reports[0].targetOpenReports, 2);
    assert.equal(open.reports[2].targetOpenReports, 1);

    await fx.admin("POST", `/reports/${one.data.reportId}/dismiss`, { note: "Not a cheater" });
    assert.equal((await fx.admin("GET", "/reports")).data.open, 2);
    assert.equal((await fx.admin("GET", "/reports?status=dismissed")).data.total, 1);
    assert.equal((await fx.admin("GET", "/reports?status=resolved")).data.total, 0);
    assert.equal((await fx.admin("GET", "/reports?status=all")).data.total, 3);
    assert.equal((await fx.admin("GET", `/reports?status=all&target=${second.id}`)).data.total, 2);
    assert.equal((await fx.admin("GET", `/reports?status=all&target=${second.username.toUpperCase()}`)).data.total, 2);
    assert.equal((await fx.admin("GET", "/reports?status=all&target=nobody-at-all")).data.total, 0);
    const reporterName = open.reports[0].reporter.username;
    assert.equal((await fx.admin("GET", `/reports?status=all&reporter=${reporterName}`)).data.total, 1);
    assert.equal((await fx.admin("GET", "/reports?status=bogus")).status, 400);
    assert.equal((await fx.admin("GET", "/reports?status=all&pageSize=10&page=2")).data.reports.length, 0);
  });

  it("resolves with a warning: the target is told, the report is closed and cannot be handled again", async () => {
    const { reporter, target, reportBody } = await lobby();
    const filed = await fx.api("POST", "/reports", reporter.account.token, reportBody);
    const id = filed.data.reportId;
    const resolved = await fx.admin("POST", `/reports/${id}/resolve`, { action: "warn", note: "First warning" }, "Ivy");
    assert.deepEqual(resolved.data, { ok: true, resolved: 1 });
    await waitFor(() => target.notices.length === 1, "warning");
    assert.equal(target.notices[0], "A moderator reviewed a report about you. Please follow the rules.");
    assert.deepEqual(reporter.notices, []);

    const row = (await fx.admin("GET", "/reports?status=resolved")).data.reports[0];
    assert.equal(row.id, id);
    assert.equal(row.status, "resolved");
    assert.equal(row.resolution, "warn");
    assert.equal(row.note, "First warning");
    assert.equal(row.handledBy, "Ivy");
    assert.ok(Math.abs(row.handledAt - Date.now()) < 10000);
    assert.equal((await fx.admin("GET", "/reports")).data.open, 0);

    assert.equal((await fx.admin("POST", `/reports/${id}/resolve`, { action: "none" })).status, 409);
    assert.equal((await fx.admin("POST", `/reports/${id}/dismiss`)).status, 409);
    assert.equal((await fx.admin("POST", "/reports/missing/resolve", { action: "none" })).status, 404);
    assert.equal((await fx.admin("POST", `/reports/${id}/resolve`, { action: "explode" })).status, 400);

    const audit = (await fx.admin("GET", `/audit?action=report.resolve&target=${target.account.id}`)).data;
    assert.equal(audit.total, 1);
    assert.equal(audit.entries[0].operator, "Ivy");
    assert.deepEqual([audit.entries[0].details.action, audit.entries[0].details.count], ["warn", 1]);
  });

  it("resolves with a mute, which needs minutes", async () => {
    const { reporter, target, reportBody } = await lobby();
    const id = (await fx.api("POST", "/reports", reporter.account.token, reportBody)).data.reportId;
    const missing = await fx.admin("POST", `/reports/${id}/resolve`, { action: "mute" });
    assert.equal(missing.status, 400);
    assert.equal((await fx.admin("GET", "/reports")).data.open, 1, "a refused resolution leaves the report open");

    const muted = await fx.admin("POST", `/reports/${id}/resolve`, { action: "mute", minutes: 20, note: "Abusive" });
    assert.deepEqual(muted.data, { ok: true, resolved: 1 });
    const mutes = (await fx.admin("GET", "/moderation/mutes")).data;
    assert.equal(mutes.entries[0].player.id, target.account.id);
    assert.equal(mutes.entries[0].reason, "Abusive");
    await waitFor(() => target.notices.length === 1, "mute notice");
    assert.match(target.notices[0], /^Your chat is muted until /);
    await pause(1100);
    target.room.send("chat", "still talking");
    await waitFor(() => target.notices.length === 2, "muted chat");
    assert.equal(reporter.chats.length, 1, "only the first message was delivered");
  });

  it("resolves with a kick, and with a ban for every open report about the target", async () => {
    const { reporter, target, reportBody } = await lobby();
    const id = (await fx.api("POST", "/reports", reporter.account.token, reportBody)).data.reportId;
    const kicked = await fx.admin("POST", `/reports/${id}/resolve`, { action: "kick" });
    assert.equal(kicked.data.resolved, 1);
    await waitFor(() => target.closed !== undefined, "kick");
    assert.equal(target.closed, 4003);
    assert.deepEqual(target.notices, ["Removed by a moderator."]);
    assert.equal((await fx.api("GET", "/social", target.account.token)).status, 200, "kicked, not banned");

    const victim = await fx.account("cheater");
    const reports = [] as string[];
    for (let i = 0; i < 3; i++) reports.push((await reportBy(victim)).data.reportId);
    const bystander = await fx.account("bystander");
    const unrelated = (await reportBy(bystander)).data.reportId;
    const banned = await fx.admin(
      "POST",
      `/reports/${reports[0]}/resolve`,
      { action: "ban", note: "Aimbot", allForTarget: true },
      "Ivy",
    );
    assert.deepEqual(banned.data, { ok: true, resolved: 3 });
    const resolved = (await fx.admin("GET", `/reports?status=resolved&target=${victim.id}`)).data;
    assert.equal(resolved.total, 3);
    for (const row of resolved.reports) {
      assert.equal(row.resolution, "ban");
      assert.equal(row.handledBy, "Ivy");
    }
    const open = (await fx.admin("GET", "/reports")).data;
    assert.deepEqual(
      open.reports.map((row: { id: string }) => row.id),
      [unrelated],
    );
    const login = await fx.api("POST", "/account/login", "", { username: victim.username, password: PASSWORD });
    assert.equal(login.status, 403);
    assert.equal(login.data.error, "Account suspended permanently. Reason: Aimbot");
    const bans = (await fx.admin("GET", "/moderation/bans")).data;
    assert.equal(bans.total, 1);
    assert.equal(bans.entries[0].createdBy, "Ivy");
    const audit = (await fx.admin("GET", `/audit?action=report.resolve&target=${victim.id}`)).data;
    assert.equal(audit.entries[0].details.count, 3);
  });

  it("dismisses a report with a note", async () => {
    const target = await fx.account("target");
    const id = (await reportBy(target)).data.reportId;
    const dismissed = await fx.admin("POST", `/reports/${id}/dismiss`, { note: "No evidence" }, "Ivy");
    assert.deepEqual(dismissed.data, { ok: true });
    const row = (await fx.admin("GET", `/reports/${id}`)).data.report;
    assert.equal(row.status, "dismissed");
    assert.equal(row.note, "No evidence");
    assert.equal(row.handledBy, "Ivy");
    assert.equal(row.resolution, "");
    assert.equal((await fx.admin("POST", `/reports/${id}/dismiss`)).status, 409);
    assert.equal((await fx.admin("POST", `/reports/${id}/resolve`, { action: "none" })).status, 409);
    assert.equal((await fx.admin("POST", "/reports/missing/dismiss")).status, 404);
    const audit = (await fx.admin("GET", `/audit?action=report.dismiss&target=${target.id}`)).data;
    assert.equal(audit.total, 1);
    assert.equal(audit.entries[0].operator, "Ivy");
  });
});
