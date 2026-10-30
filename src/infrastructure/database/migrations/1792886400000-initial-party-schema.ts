import {
  Table,
  TableForeignKey,
  type MigrationInterface,
  type QueryRunner,
  type TableCheckOptions,
  type TableColumnOptions,
  type TableForeignKeyOptions,
  type TableUniqueOptions,
} from "typeorm";

// Release 1.0 schema. Keep these definitions frozen: later changes go in new migrations, so databases created by
// earlier builds upgrade in place. The entities in ../entities describe the same tables.
interface TableDefinition {
  name: string;
  columns: TableColumnOptions[];
  uniques: TableUniqueOptions[];
  checks: TableCheckOptions[];
  foreignKeys: TableForeignKeyOptions[];
}

export const initialTables: TableDefinition[] = [
  {
    name: "users",
    columns: [
      { name: "id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "username", type: "varchar", length: "191", isNullable: false },
      { name: "display_name", type: "varchar", length: "191", isNullable: false },
      { name: "salt", type: "varchar", length: "128", isNullable: false },
      { name: "password_hash", type: "varchar", length: "128", isNullable: false },
      { name: "xp", type: "int", isNullable: false, default: "0" },
      { name: "wins", type: "int", isNullable: false, default: "0" },
      { name: "matches", type: "int", isNullable: false, default: "0" },
      { name: "color", type: "int", isNullable: false, default: "0" },
    ],
    uniques: [{ columnNames: ["username"] }],
    checks: [],
    foreignKeys: [],
  },
  {
    name: "sessions",
    columns: [
      { name: "token_hash", type: "varchar", length: "128", isPrimary: true, isNullable: false },
      { name: "user_id", type: "varchar", length: "64", isNullable: true },
      { name: "expires", type: "bigint", isNullable: false },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [
      { columnNames: ["user_id"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "CASCADE" },
    ],
  },
  {
    name: "requests",
    columns: [
      { name: "sender", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "recipient", type: "varchar", length: "64", isPrimary: true, isNullable: false },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [
      { columnNames: ["sender"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
      { columnNames: ["recipient"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
    ],
  },
  {
    name: "friends",
    columns: [
      { name: "low", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "high", type: "varchar", length: "64", isPrimary: true, isNullable: false },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [
      { columnNames: ["low"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
      { columnNames: ["high"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
    ],
  },
  {
    name: "blocks",
    columns: [
      { name: "owner", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "target", type: "varchar", length: "64", isPrimary: true, isNullable: false },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [
      { columnNames: ["owner"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
      { columnNames: ["target"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
    ],
  },
  {
    name: "invites",
    columns: [
      { name: "id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "sender", type: "varchar", length: "64", isNullable: true },
      { name: "recipient", type: "varchar", length: "64", isNullable: true },
      { name: "room_id", type: "varchar", length: "191", isNullable: true },
      { name: "expires", type: "bigint", isNullable: true },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [
      { columnNames: ["sender"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
      { columnNames: ["recipient"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
    ],
  },
  {
    name: "results",
    columns: [
      { name: "match_id", type: "varchar", length: "191", isPrimary: true, isNullable: false },
      { name: "user_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "won", type: "int", isNullable: true },
      { name: "xp", type: "int", isNullable: true },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [
      { columnNames: ["user_id"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
    ],
  },
  {
    name: "times",
    columns: [
      { name: "user_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "course_id", type: "varchar", length: "191", isPrimary: true, isNullable: false },
      { name: "seconds", type: "double", isNullable: true },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [
      { columnNames: ["user_id"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
    ],
  },
  {
    name: "wallets",
    columns: [
      { name: "user_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "credits", type: "int", isNullable: false },
      { name: "shards", type: "int", isNullable: false },
      { name: "pity_epic", type: "int", isNullable: false },
      { name: "pity_legendary", type: "int", isNullable: false },
      { name: "equipped", type: "varchar", length: "191", isNullable: false },
    ],
    uniques: [],
    checks: [{ expression: "`credits` >= 0" }, { expression: "`shards` >= 0" }],
    foreignKeys: [
      { columnNames: ["user_id"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
    ],
  },
  {
    name: "characters",
    columns: [
      { name: "user_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "character_id", type: "varchar", length: "191", isPrimary: true, isNullable: false },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [
      { columnNames: ["user_id"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
    ],
  },
  {
    name: "gacha_receipts",
    columns: [
      { name: "user_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "request_id", type: "varchar", length: "191", isPrimary: true, isNullable: false },
      { name: "fingerprint", type: "varchar", length: "191", isNullable: true },
      { name: "response", type: "longtext", isNullable: true },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [
      { columnNames: ["user_id"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
    ],
  },
  {
    name: "credit_ledger",
    columns: [
      { name: "user_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "source", type: "varchar", length: "191", isPrimary: true, isNullable: false },
      { name: "amount", type: "int", isNullable: true },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [
      { columnNames: ["user_id"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
    ],
  },
  {
    name: "match_receipts",
    columns: [
      { name: "match_id", type: "varchar", length: "191", isPrimary: true, isNullable: false },
      { name: "user_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [
      { columnNames: ["user_id"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
    ],
  },
  {
    name: "rankings",
    columns: [
      { name: "user_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "mode", type: "varchar", length: "191", isPrimary: true, isNullable: false },
      { name: "season", type: "varchar", length: "191", isPrimary: true, isNullable: false },
      { name: "wins", type: "int", isNullable: true },
      { name: "matches", type: "int", isNullable: true },
      { name: "points", type: "double", isNullable: true },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [
      { columnNames: ["user_id"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
    ],
  },
  {
    name: "daily_progress",
    columns: [
      { name: "user_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "day", type: "varchar", length: "191", isPrimary: true, isNullable: false },
      { name: "matches", type: "int", isNullable: true },
      { name: "wins", type: "int", isNullable: true },
      { name: "teams", type: "int", isNullable: true },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [
      { columnNames: ["user_id"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
    ],
  },
  {
    name: "progression_receipts",
    columns: [
      { name: "user_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "match_id", type: "varchar", length: "191", isPrimary: true, isNullable: false },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [
      { columnNames: ["user_id"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
    ],
  },
  {
    name: "goal_claims",
    columns: [
      { name: "user_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "goal_id", type: "varchar", length: "191", isPrimary: true, isNullable: false },
      { name: "period", type: "varchar", length: "191", isPrimary: true, isNullable: false },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [
      { columnNames: ["user_id"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
    ],
  },
  {
    name: "season_definitions",
    columns: [
      { name: "id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "policy", type: "longtext", isNullable: false },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [],
  },
  {
    name: "season_progress",
    columns: [
      { name: "user_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "season", type: "varchar", length: "191", isPrimary: true, isNullable: false },
      { name: "xp", type: "int", isNullable: false },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [
      { columnNames: ["user_id"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
      {
        columnNames: ["season"],
        referencedTableName: "season_definitions",
        referencedColumnNames: ["id"],
        onDelete: "RESTRICT",
      },
    ],
  },
  {
    name: "season_daily",
    columns: [
      { name: "user_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "day", type: "varchar", length: "191", isPrimary: true, isNullable: false },
      { name: "matches", type: "int", isNullable: false },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [
      { columnNames: ["user_id"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
    ],
  },
  {
    name: "season_receipts",
    columns: [
      { name: "user_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "match_id", type: "varchar", length: "191", isPrimary: true, isNullable: false },
      { name: "season", type: "varchar", length: "191", isNullable: false },
      { name: "xp", type: "int", isNullable: false },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [
      { columnNames: ["user_id"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
    ],
  },
  {
    name: "season_claims",
    columns: [
      { name: "user_id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "season", type: "varchar", length: "191", isPrimary: true, isNullable: false },
      { name: "tier_id", type: "varchar", length: "191", isPrimary: true, isNullable: false },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [
      { columnNames: ["user_id"], referencedTableName: "users", referencedColumnNames: ["id"], onDelete: "RESTRICT" },
    ],
  },
  {
    name: "content_identities",
    columns: [
      { name: "kind", type: "varchar", length: "191", isPrimary: true, isNullable: false },
      { name: "id", type: "varchar", length: "64", isPrimary: true, isNullable: false },
      { name: "identity", type: "varchar", length: "191", isNullable: true },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [],
  },
];

export class InitialPartySchema1792886400000 implements MigrationInterface {
  name = "InitialPartySchema1792886400000";
  async up(runner: QueryRunner): Promise<void> {
    for (const table of initialTables) {
      await runner.createTable(
        new Table({
          name: table.name,
          columns: table.columns,
          uniques: table.uniques,
          checks: table.checks,
          engine: "InnoDB",
        }),
        true,
      );
    }
    for (const table of initialTables) {
      for (const foreignKey of table.foreignKeys)
        await runner.createForeignKey(table.name, new TableForeignKey(foreignKey));
    }
  }
  async down(): Promise<void> {
    throw new Error("Destructive rollback is disabled. Restore a verified MySQL backup deliberately.");
  }
}
