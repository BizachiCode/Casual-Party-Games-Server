import { Table, TableForeignKey, type MigrationInterface, type QueryRunner } from "typeorm";

// Guest accounts: a flag on the account, and the devices that sign in to them without a password. Every account that
// exists already chose a username and password, so the column default marks them as ordinary accounts.
export class GuestAccounts1792886400004 implements MigrationInterface {
  name = "GuestAccounts1792886400004";
  async up(runner: QueryRunner): Promise<void> {
    await runner.query("ALTER TABLE `users` ADD COLUMN `guest` tinyint(1) NOT NULL DEFAULT 0");
    await runner.createTable(
      new Table({
        name: "device_logins",
        columns: [
          { name: "device_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
          { name: "user_id", type: "varchar", length: "64", isNullable: false },
          { name: "secret_hash", type: "varchar", length: "128", isNullable: false },
          { name: "created_at", type: "bigint", isNullable: false },
        ],
        engine: "InnoDB",
      }),
      true,
    );
    await runner.createForeignKey(
      "device_logins",
      new TableForeignKey({
        columnNames: ["user_id"],
        referencedTableName: "users",
        referencedColumnNames: ["id"],
        onDelete: "RESTRICT",
      }),
    );
  }
  async down(): Promise<void> {
    throw new Error("Destructive rollback is disabled. Restore a verified MySQL backup deliberately.");
  }
}
