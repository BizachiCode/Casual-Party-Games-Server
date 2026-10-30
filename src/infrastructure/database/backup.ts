import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { getMetadataArgsStorage } from "typeorm";
import type { Database } from "./database.js";
import { entities } from "./entities/index.js";
import { initialTables } from "./migrations/1792886400000-initial-party-schema.js";

// Consistent MySQL backups as JSON lines: a header with the schema hash, then up to 1000 rows per line for every
// table (in foreign-key order), then a SHA-256 checksum of everything before it.
// A restore only fills an empty database.

const PAGE = 1000;

interface TableSpec {
  name: string;
  columns: string[];
  primary: string;
}
interface BackupFormat {
  tables: TableSpec[];
  schemaHash: string;
}

/** Release 1.0 backups: the tables of the initial migration only. They stay restorable; new backups never use it. */
const legacyTables: TableSpec[] = initialTables.map(table => ({
  name: table.name,
  columns: table.columns.map(column => column.name),
  primary: table.columns
    .filter(column => column.isPrimary)
    .map(column => "`" + column.name + "`")
    .join(","),
}));

/** Every table of the entities list, in that order, with the columns the entities declare (later ones included). */
function entityTables(): TableSpec[] {
  const storage = getMetadataArgsStorage();
  return entities.map(entity => {
    const columns = storage.filterColumns(entity).map(column => ({
      name: column.options.name ?? column.propertyName,
      primary: !!column.options.primary,
    }));
    return {
      name: storage.tables.find(table => table.target === entity).name,
      columns: columns.map(column => column.name),
      primary: columns
        .filter(column => column.primary)
        .map(column => "`" + column.name + "`")
        .join(","),
    };
  });
}

const hashOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const currentTables = entityTables();
const FORMAT = "party-mysql-2";
const formats = new Map<string, BackupFormat>([
  ["party-mysql-1", { tables: legacyTables, schemaHash: hashOf(initialTables) }],
  [FORMAT, { tables: currentTables, schemaHash: hashOf(currentTables) }],
]);
const current = formats.get(FORMAT);

export async function backupDatabase(db: Database, destination: string) {
  const output = resolve(destination);
  const temp = output + "." + randomUUID() + ".tmp";
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const file = await open(temp, "wx", 0o600);
  const hash = createHash("sha256");
  const counts: Record<string, number> = {};
  const write = async (value: unknown) => {
    const line = JSON.stringify(value) + "\n";
    hash.update(line);
    await file.write(line);
  };
  try {
    await db.source.transaction("REPEATABLE READ", async manager => {
      await write({ format: FORMAT, schemaHash: current.schemaHash, createdAt: new Date().toISOString() });
      for (const table of current.tables) {
        counts[table.name] = 0;
        for (let offset = 0; ; offset += PAGE) {
          const rows = await manager.query(
            "SELECT * FROM `" + table.name + "` ORDER BY " + table.primary + " LIMIT " + PAGE + " OFFSET " + offset,
          );
          if (!rows.length) break;
          await write({ table: table.name, rows });
          counts[table.name] += rows.length;
        }
      }
    });
    const checksum = hash.digest("hex");
    await file.write(JSON.stringify({ checksum }) + "\n");
    await file.sync();
    await file.close();
    await link(temp, output); // Fails instead of overwriting an existing backup.
    return { ok: true, output, checksum, counts };
  } finally {
    await file.close().catch(() => {});
    await unlink(temp).catch(() => {});
  }
}

async function* lines(path: string) {
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity }))
    if (line) yield line;
}

/** Checks the format, schema, columns and checksum without touching any database. */
export async function verifyDatabase(path: string) {
  const hash = createHash("sha256");
  let format: BackupFormat | undefined;
  let formatName: string;
  let header = false;
  let footer = false;
  let rows = 0;
  let checksum: string;
  for await (const line of lines(path)) {
    if (footer) throw Error("Trailing backup data");
    const record = JSON.parse(line);
    if (record.checksum) {
      checksum = hash.digest("hex");
      if (checksum !== record.checksum) throw Error("Backup checksum mismatch");
      footer = true;
      continue;
    }
    hash.update(line + "\n");
    if (!header) {
      formatName = record.format;
      format = formats.get(formatName);
      if (!format || record.schemaHash !== format.schemaHash) throw Error("Incompatible backup schema");
      header = true;
      continue;
    }
    const table = format.tables.find(t => t.name === record.table);
    if (!table || !Array.isArray(record.rows) || record.rows.length > PAGE) throw Error("Invalid backup data");
    for (const row of record.rows) {
      const keys = Object.keys(row);
      if (keys.length !== table.columns.length || keys.some(key => !table.columns.includes(key)))
        throw Error("Invalid backup columns");
    }
    rows += record.rows.length;
  }
  if (!header || !footer) throw Error("Incomplete backup");
  return { ok: true, checksum, rows, format: formatName };
}

export async function restoreDatabase(db: Database, path: string) {
  const checked = await verifyDatabase(path);
  const { tables } = formats.get(checked.format); // A Release 1.0 backup restores its tables; the rest start empty.
  await db.source.transaction(async manager => {
    for (const table of tables) {
      if (Number((await manager.query("SELECT COUNT(*) AS n FROM `" + table.name + "`"))[0].n) !== 0)
        throw Error("Restore requires a new empty MySQL database.");
    }
    for await (const line of lines(path)) {
      const record = JSON.parse(line);
      if (!record.table) continue;
      const table = tables.find(t => t.name === record.table);
      const sql =
        "INSERT INTO `" +
        table.name +
        "` (" +
        table.columns.map(column => "`" + column + "`").join(",") +
        ") VALUES (" +
        table.columns.map(() => "?").join(",") +
        ")";
      for (const row of record.rows)
        await manager.query(
          sql,
          table.columns.map(column => row[column]),
        );
    }
  });
  return checked;
}
