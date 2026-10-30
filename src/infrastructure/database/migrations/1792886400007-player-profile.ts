import type { MigrationInterface, QueryRunner } from "typeorm";

// The player profile: the icon an account shows (a character id, empty for the equipped character) and when its
// display name last changed, which the rename cooldown counts from (0 = never renamed, so the first change is free).
export class PlayerProfile1792886400007 implements MigrationInterface {
  name = "PlayerProfile1792886400007";
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      "ALTER TABLE `users` ADD COLUMN `avatar` varchar(64) NOT NULL DEFAULT ''," +
        " ADD COLUMN `name_changed_at` bigint NOT NULL DEFAULT 0",
    );
  }
  async down(): Promise<void> {
    throw new Error("Destructive rollback is disabled. Restore a verified MySQL backup deliberately.");
  }
}
