import { Table, TableForeignKey, type MigrationInterface, type QueryRunner } from "typeorm";

// Battle pass: every season reward is claimed on a track ("free" or "premium"), and the premium track is bought once
// per season. Existing claims are free-track claims, which the column default records.
export class BattlePass1792886400003 implements MigrationInterface {
  name = "BattlePass1792886400003";
  async up(runner: QueryRunner): Promise<void> {
    // One statement, so the user_id foreign key always has an index that starts with it.
    await runner.query(
      "ALTER TABLE `season_claims` ADD COLUMN `track` varchar(8) NOT NULL DEFAULT 'free', " +
        "DROP PRIMARY KEY, ADD PRIMARY KEY (`user_id`, `season`, `tier_id`, `track`)",
    );
    await runner.createTable(
      new Table({
        name: "season_premium",
        columns: [
          { name: "user_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
          { name: "season", type: "varchar", length: "191", isPrimary: true, isNullable: false },
          { name: "purchased_at", type: "bigint", isNullable: false },
        ],
        engine: "InnoDB",
      }),
      true,
    );
    await runner.createForeignKey(
      "season_premium",
      new TableForeignKey({
        columnNames: ["user_id"],
        referencedTableName: "users",
        referencedColumnNames: ["id"],
        onDelete: "RESTRICT",
      }),
    );
    await runner.createForeignKey(
      "season_premium",
      new TableForeignKey({
        columnNames: ["season"],
        referencedTableName: "season_definitions",
        referencedColumnNames: ["id"],
        onDelete: "RESTRICT",
      }),
    );
  }
  async down(): Promise<void> {
    throw new Error("Destructive rollback is disabled. Restore a verified MySQL backup deliberately.");
  }
}
