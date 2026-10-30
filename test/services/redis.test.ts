import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RedisCoordination } from "../../src/infrastructure/redis/coordination.js";

// Needs a real Redis 6.2+ (SET NX EX, EVAL): set PARTY_TEST_REDIS_URL, e.g. redis://127.0.0.1:6379.
describe("redis coordination", () => {
  it("keeps lease ownership, presence expiry and a shared request window across processes", async function () {
    if (!process.env.PARTY_TEST_REDIS_URL) this.skip();
    const prefix = "party:test:" + randomUUID().slice(0, 8);
    const first = new RedisCoordination(process.env.PARTY_TEST_REDIS_URL, prefix);
    const second = new RedisCoordination(process.env.PARTY_TEST_REDIS_URL, prefix);
    await first.connect();
    await second.connect();
    try {
      assert.equal(await first.acquire("account", "owner-A"), true);
      assert.equal(await second.acquire("account", "owner-B"), false);
      assert.equal(await second.renew("account", "owner-B"), false);
      await second.release("account", "owner-B");
      assert.equal(await first.renew("account", "owner-A"), true);
      await first.release("account", "owner-A");
      assert.equal(await second.acquire("account", "owner-B"), true);
      await second.release("account", "owner-B");
      await first.publishPresence("account", { seen: 123, roomId: "room" });
      assert.deepEqual(await second.presence(["account"]), [{ seen: 123, roomId: "room" }]);
      await second.clearPresence("account");
      assert.deepEqual(await first.presence(["account"]), [null]);
      assert.equal(await first.admit("test-ip", 1), true);
      assert.equal(await second.admit("test-ip", 1), false);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
