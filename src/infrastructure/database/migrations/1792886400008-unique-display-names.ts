import { randomInt } from "node:crypto";
import type { MigrationInterface, QueryRunner } from "typeorm";
import { nameKey } from "../../../shared/text.js";

// Display names are unique, ignoring case: `name_key` holds the normalised name (see nameKey) under a unique index.
// Accounts that already share a name keep it in creation order: the oldest keeps it, every later one becomes a
// guest name (Guest- and 5 digits) no account uses.
export class UniqueDisplayNames1792886400008 implements MigrationInterface {
  name = "UniqueDisplayNames1792886400008";
  async up(runner: QueryRunner): Promise<void> {
    await runner.query("ALTER TABLE `users` ADD COLUMN `name_key` varchar(191) NULL");
    const rows: { id: string; display_name: string }[] = await runner.query(
      "SELECT `id`, `display_name` FROM `users` ORDER BY `created_at`, `id`",
    );
    const existing = new Set(rows.map(row => nameKey(row.display_name)));
    const taken = new Set<string>();
    for (const row of rows) {
      let displayName = row.display_name;
      let key = nameKey(displayName);
      if (taken.has(key)) {
        // A later account with a name already kept: a guest name that no account has, before or after the change.
        do {
          displayName = "Guest-" + String(randomInt(0, 100000)).padStart(5, "0");
          key = nameKey(displayName);
        } while (existing.has(key) || taken.has(key));
      }
      taken.add(key);
      await runner.query("UPDATE `users` SET `display_name` = ?, `name_key` = ? WHERE `id` = ?", [
        displayName,
        key,
        row.id,
      ]);
    }
    await runner.query(
      "ALTER TABLE `users` MODIFY `name_key` varchar(191) NOT NULL, ADD UNIQUE INDEX `UQ_users_name_key` (`name_key`)",
    );
  }
  async down(): Promise<void> {
    throw new Error("Destructive rollback is disabled. Restore a verified MySQL backup deliberately.");
  }
}
