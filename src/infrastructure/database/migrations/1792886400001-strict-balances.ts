import type { MigrationInterface, QueryRunner } from "typeorm";
import { initialTables } from "./1792886400000-initial-party-schema.js";

// MySQL enforces the balance checks (no negative Stars or shards) as named constraints.
export class StrictBalances1792886400001 implements MigrationInterface {
  name = "StrictBalances1792886400001";
  async up(runner: QueryRunner): Promise<void> {
    for (const table of initialTables) {
      for (const [index, check] of table.checks.entries()) {
        await runner.query(
          "ALTER TABLE `" +
            table.name +
            "` ADD CONSTRAINT `ck_" +
            table.name +
            "_" +
            index +
            "` CHECK (" +
            check.expression +
            ")",
        );
      }
    }
  }
  async down(): Promise<void> {
    throw new Error("Balance constraints must not be removed automatically.");
  }
}
