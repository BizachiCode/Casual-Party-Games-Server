import "reflect-metadata";
import { AsyncLocalStorage } from "node:async_hooks";
import { DataSource, type EntityManager, type EntityTarget, type ObjectLiteral, type Repository } from "typeorm";
import { entities } from "./entities/index.js";
import { migrations } from "./migrations/index.js";

/**
 * MySQL access for every module. Repositories call `db.manager` (or `db.repository(Entity)`), which is the current
 * transaction when one is open and the pool otherwise, so services compose transactions without passing managers.
 */
export class Database {
  private readonly context = new AsyncLocalStorage<EntityManager>();
  private readonly lockedUsers = new WeakMap<EntityManager, Set<string>>();

  constructor(readonly source: DataSource) {}

  get healthy(): boolean {
    return this.source.isInitialized;
  }

  get manager(): EntityManager {
    return this.context.getStore() ?? this.source.manager;
  }

  repository<Entity extends ObjectLiteral>(target: EntityTarget<Entity>): Repository<Entity> {
    return this.manager.getRepository(target);
  }

  /** Parameterized SQL for statements the query builder cannot express (upserts with arithmetic, aggregates). */
  query<Row = Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<Row[]> {
    return this.manager.query(sql, parameters);
  }

  /** Runs `work` in one READ COMMITTED transaction. A nested call joins the outer transaction. */
  transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return work();
    return this.source.transaction("READ COMMITTED", manager => this.context.run(manager, work));
  }

  /**
   * Locks the account rows for the rest of the current transaction, always in id order so two settlements that touch
   * the same players cannot deadlock. Outside a transaction it does nothing.
   */
  async lockUsers(ids: Iterable<string>): Promise<void> {
    const manager = this.context.getStore();
    if (!manager) return;
    let held = this.lockedUsers.get(manager);
    if (!held) {
      held = new Set();
      this.lockedUsers.set(manager, held);
    }
    for (const id of [...new Set(ids)].sort()) {
      if (held.has(id)) continue;
      await manager.query("SELECT id FROM users WHERE id=? FOR UPDATE", [id]);
      held.add(id);
    }
  }

  /** Connects and applies pending migrations under a database-wide lock (several processes may start together). */
  async open(): Promise<void> {
    await this.source.initialize();
    const runner = this.source.createQueryRunner();
    try {
      await runner.connect();
      const [{ name }] = await runner.query("SELECT DATABASE() AS name");
      const lock = "party_migrations_" + name;
      const [{ acquired }] = await runner.query("SELECT GET_LOCK(?,30) AS acquired", [lock]);
      if (Number(acquired) !== 1) throw new Error("Migration lock unavailable.");
      try {
        await this.source.runMigrations();
      } finally {
        await runner.query("SELECT RELEASE_LOCK(?)", [lock]);
      }
    } catch (error) {
      await this.source.destroy();
      throw error;
    } finally {
      await runner.release();
    }
  }

  async close(): Promise<void> {
    if (this.source.isInitialized) await this.source.destroy();
  }
}

/** A Database for this URL; connect it with `open()`. */
export function createDatabase(url: string): Database {
  if (!url || !/^mysql:\/\//.test(url)) throw new Error("DATABASE_URL with a MySQL database is required.");
  return new Database(
    new DataSource({
      type: "mysql",
      url,
      entities,
      migrations,
      migrationsRun: false,
      synchronize: false,
      logging: false,
      charset: "utf8mb4_bin",
      poolSize: 16,
      extra: {
        connectTimeout: 8000,
        queueLimit: 128,
        decimalNumbers: true,
        supportBigNumbers: true,
        bigNumberStrings: false,
      },
    }),
  );
}

/** Connects and applies pending migrations (for the command-line tools). */
export async function openDatabase(url: string): Promise<Database> {
  const database = createDatabase(url);
  await database.open();
  return database;
}
