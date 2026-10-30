import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDatabase, restoreDatabase, verifyDatabase } from "../../src/infrastructure/database/backup.js";
import { startServices, testDatabase, testDatabaseUrl } from "../support/server.js";

describe("database backup", () => {
  it("restores a backup into an empty schema with wallets and sign-ins intact, never a full one", async function () {
    // Two migrated schemas, a dump and a restore: about 16 s alone, longer when the whole suite runs.
    this.timeout(90000);
    const dir = mkdtempSync(join(tmpdir(), "party-mysql-backup-"));
    try {
      // The target is only migrated: a running server would already have seeded it (season, content identities).
      const source = await startServices();
      const targetUrl = await testDatabaseUrl();
      const target = await testDatabase(targetUrl);
      const account = await source.accounts.register({ username: "backup_mysql", password: "test-only-password" });
      await source.collection.reward(account.profile.id, "backup", 123);
      const before = await source.collection.state(account.profile.id);
      // Tables added by later migrations travel with the backup too.
      const id = account.profile.id;
      await source.database.query("INSERT INTO event_progress VALUES(?,?,?,?)", [id, "slime-weekend@2026-10-30", 3, 1]);
      await source.database.query("INSERT INTO event_receipts VALUES(?,?)", [id, "match-1"]);
      await source.database.query("INSERT INTO event_claims VALUES(?,?,?)", [id, "slime-weekend@2026-10-30", "play"]);
      // The battle pass keeps claims per track and its premium purchases per season.
      await source.seasons.ensure("s1");
      await source.database.query("INSERT INTO season_claims VALUES(?,?,?,?)", [id, "s1", "tier-01", "premium"]);
      await source.database.query("INSERT INTO season_premium VALUES(?,?,?)", [id, "s1", 1793000000000]);
      const output = join(dir, "backup.jsonl");
      const report = await backupDatabase(source.database, output);
      assert.equal(report.ok, true);
      // Windows has no POSIX permission bits; elsewhere the backup is readable by its owner only.
      if (process.platform !== "win32") assert.equal(statSync(output).mode & 0o777, 0o600);
      assert.equal((await verifyDatabase(output)).ok, true);
      await restoreDatabase(target, output);
      const restored = await startServices({}, targetUrl);
      assert.equal((await restored.accounts.authenticate(account.token)).id, account.profile.id);
      assert.deepEqual(await restored.collection.state(account.profile.id), before);
      assert.deepEqual(
        await restored.database.query("SELECT occurrence, matches, wins FROM event_progress WHERE user_id=?", [id]),
        [{ occurrence: "slime-weekend@2026-10-30", matches: 3, wins: 1 }],
      );
      assert.equal(Number((await restored.database.query("SELECT COUNT(*) AS n FROM event_claims"))[0].n), 1);
      assert.equal(Number((await restored.database.query("SELECT COUNT(*) AS n FROM event_receipts"))[0].n), 1);
      assert.deepEqual(
        await restored.database.query("SELECT tier_id, track FROM season_claims WHERE user_id=?", [id]),
        [{ tier_id: "tier-01", track: "premium" }],
      );
      const purchase = await restored.database.query("SELECT purchased_at FROM season_premium WHERE user_id=?", [id]);
      assert.equal(Number(purchase[0].purchased_at), 1793000000000);
      await assert.rejects(restoreDatabase(target, output), /empty/);
      await assert.rejects(
        backupDatabase(source.database, output),
        undefined,
        "an existing backup is never overwritten",
      );
      const corrupt = join(dir, "bad");
      writeFileSync(corrupt, "broken");
      await assert.rejects(verifyDatabase(corrupt));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
