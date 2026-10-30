/**
 * npm run db -- backup FILE   consistent snapshot of DATABASE_URL
 * npm run db -- restore FILE  into an empty database at DATABASE_URL (migrated first)
 * npm run db -- verify FILE   format, schema and checksum, no database needed
 */
import { backupDatabase, restoreDatabase, verifyDatabase } from "./backup.js";
import { openDatabase, type Database } from "./database.js";

const [action, path] = process.argv.slice(2);
let db: Database;
try {
  if (action === "verify" && path) console.log(JSON.stringify(await verifyDatabase(path)));
  else if ((action === "backup" || action === "restore") && path) {
    db = await openDatabase(process.env.DATABASE_URL);
    console.log(JSON.stringify(action === "backup" ? await backupDatabase(db, path) : await restoreDatabase(db, path)));
  } else throw new Error("Usage: DATABASE_URL=... npm run db -- backup|restore FILE, or npm run db -- verify FILE");
} catch (error) {
  console.error(
    (error as Error).message.startsWith("Usage")
      ? (error as Error).message
      : "Database operation failed. Check connectivity, a compatible backup and an empty restore target.",
  );
  process.exitCode = 1;
} finally {
  await db?.close();
}
