import { Table, TableForeignKey, type MigrationInterface, type QueryRunner } from "typeorm";

// The GM console: when each account was created and last seen, bans and chat mutes, player reports and the audit
// log of every GM action. Accounts that exist already get 0 for both times ("unknown").
export class GameMaster1792886400005 implements MigrationInterface {
  name = "GameMaster1792886400005";
  async up(runner: QueryRunner): Promise<void> {
    // One statement for the columns and their indexes: every ALTER rebuilds the table.
    await runner.query(
      "ALTER TABLE `users` ADD COLUMN `created_at` bigint NOT NULL DEFAULT 0," +
        " ADD COLUMN `last_seen` bigint NOT NULL DEFAULT 0," +
        " ADD INDEX `IDX_users_created_at` (`created_at`), ADD INDEX `IDX_users_last_seen` (`last_seen`)",
    );

    const restrictions = ["bans", "mutes"].map(
      name =>
        new Table({
          name,
          columns: [
            { name: "user_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
            { name: "reason", type: "varchar", length: "280", isNullable: false, default: "''" },
            // A ban without an end is permanent; a mute always ends.
            { name: "until", type: "bigint", isNullable: name === "bans" },
            { name: "created_at", type: "bigint", isNullable: false },
            { name: "created_by", type: "varchar", length: "64", isNullable: false, default: "''" },
          ],
          foreignKeys: [userKey("user_id")],
          engine: "InnoDB",
        }),
    );
    for (const table of restrictions) await runner.createTable(table, true);

    await runner.createTable(
      new Table({
        name: "reports",
        columns: [
          { name: "id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
          { name: "reporter_id", type: "varchar", length: "64", isNullable: false },
          { name: "target_id", type: "varchar", length: "64", isNullable: false },
          { name: "reason", type: "varchar", length: "32", isNullable: false },
          { name: "details", type: "varchar", length: "280", isNullable: false, default: "''" },
          { name: "room_id", type: "varchar", length: "191", isNullable: false, default: "''" },
          { name: "evidence", type: "longtext", isNullable: true },
          { name: "status", type: "varchar", length: "16", isNullable: false, default: "'open'" },
          { name: "resolution", type: "varchar", length: "32", isNullable: false, default: "''" },
          { name: "note", type: "varchar", length: "280", isNullable: false, default: "''" },
          { name: "handled_by", type: "varchar", length: "64", isNullable: false, default: "''" },
          { name: "created_at", type: "bigint", isNullable: false },
          { name: "handled_at", type: "bigint", isNullable: true },
        ],
        indices: [
          { name: "IDX_reports_status", columnNames: ["status", "created_at"] },
          { name: "IDX_reports_target", columnNames: ["target_id", "status"] },
          { name: "IDX_reports_reporter", columnNames: ["reporter_id", "created_at"] },
        ],
        foreignKeys: [userKey("reporter_id"), userKey("target_id")],
        engine: "InnoDB",
      }),
      true,
    );

    await runner.createTable(
      new Table({
        name: "gm_actions",
        columns: [
          {
            name: "id",
            type: "bigint",
            unsigned: true,
            isPrimary: true,
            isGenerated: true,
            generationStrategy: "increment",
          },
          { name: "at", type: "bigint", isNullable: false },
          { name: "operator", type: "varchar", length: "64", isNullable: false },
          { name: "address", type: "varchar", length: "64", isNullable: false, default: "''" },
          { name: "action", type: "varchar", length: "64", isNullable: false },
          { name: "target_id", type: "varchar", length: "64", isNullable: true },
          { name: "request_id", type: "varchar", length: "100", isNullable: true, isUnique: true },
          { name: "details", type: "longtext", isNullable: true },
        ],
        indices: [
          { name: "IDX_gm_actions_at", columnNames: ["at"] },
          { name: "IDX_gm_actions_target", columnNames: ["target_id", "at"] },
          { name: "IDX_gm_actions_action", columnNames: ["action", "at"] },
        ],
        engine: "InnoDB",
      }),
      true,
    );
  }
  async down(): Promise<void> {
    throw new Error("Destructive rollback is disabled. Restore a verified MySQL backup deliberately.");
  }
}

function userKey(column: string): TableForeignKey {
  return new TableForeignKey({
    columnNames: [column],
    referencedTableName: "users",
    referencedColumnNames: ["id"],
    onDelete: "RESTRICT",
  });
}
