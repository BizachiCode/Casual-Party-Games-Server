import { Table, TableForeignKey, type MigrationInterface, type QueryRunner } from "typeorm";

// Timed events: progress per event occurrence, the matches already counted and the goals already claimed. The
// events themselves live in game_config/events.json, so there is nothing to freeze here.
export class Events1792886400002 implements MigrationInterface {
  name = "Events1792886400002";
  async up(runner: QueryRunner): Promise<void> {
    const tables = [
      new Table({
        name: "event_progress",
        columns: [
          { name: "user_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
          { name: "occurrence", type: "varchar", length: "191", isPrimary: true, isNullable: false },
          { name: "matches", type: "int", isNullable: false, default: "0" },
          { name: "wins", type: "int", isNullable: false, default: "0" },
        ],
        engine: "InnoDB",
      }),
      new Table({
        name: "event_receipts",
        columns: [
          { name: "user_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
          { name: "match_id", type: "varchar", length: "191", isPrimary: true, isNullable: false },
        ],
        engine: "InnoDB",
      }),
      new Table({
        name: "event_claims",
        columns: [
          { name: "user_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
          { name: "occurrence", type: "varchar", length: "191", isPrimary: true, isNullable: false },
          { name: "goal_id", type: "varchar", length: "191", isPrimary: true, isNullable: false },
        ],
        engine: "InnoDB",
      }),
    ];
    for (const table of tables) await runner.createTable(table, true);
    for (const table of tables) {
      await runner.createForeignKey(
        table.name,
        new TableForeignKey({
          columnNames: ["user_id"],
          referencedTableName: "users",
          referencedColumnNames: ["id"],
          onDelete: "RESTRICT",
        }),
      );
    }
  }
  async down(): Promise<void> {
    throw new Error("Destructive rollback is disabled. Restore a verified MySQL backup deliberately.");
  }
}
