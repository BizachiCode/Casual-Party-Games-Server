import { createHash } from "node:crypto";
import { createClient } from "redis";

export interface PresenceRecord {
  seen: number;
  roomId: string;
  /** The squad room (party) the account sits in, "" for none. */
  partyId?: string;
  published?: number;
}

const RENEW = "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('EXPIRE',KEYS[1],90) else return 0 end";
const RELEASE = "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
const COUNT = "local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],60) end;return n";

/**
 * Optional cross-process coordination. Redis only holds short-lived state (seat leases, presence, rate windows);
 * accounts and economy always live in MySQL. Without REDIS_URL the server runs as a single process.
 */
export class RedisCoordination {
  private readonly client: ReturnType<typeof createClient>;

  constructor(
    url: string,
    private readonly prefix: string,
  ) {
    if (!/^[a-zA-Z0-9:_-]{1,64}$/.test(prefix)) throw new Error("Invalid Redis namespace.");
    this.client = createClient({
      url,
      socket: { connectTimeout: 5000, reconnectStrategy: attempt => Math.min(2000, 100 + attempt * 100) },
      disableOfflineQueue: true,
    });
    this.client.on("error", () => {});
  }

  async connect(): Promise<void> {
    let timer: NodeJS.Timeout;
    try {
      await Promise.race([
        (async () => {
          await this.client.connect();
          await this.client.ping();
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Redis startup timeout")), 6000);
        }),
      ]);
    } catch {
      this.client.destroy();
      throw new Error("Redis connection unavailable.");
    } finally {
      clearTimeout(timer);
    }
  }

  get healthy(): boolean {
    return this.client.isReady;
  }

  private key(kind: string, id: string) {
    return this.prefix + ":" + kind + ":" + id;
  }

  /** Claims the account's single match seat for 90 s; renewed every second by the room. */
  async acquire(accountId: string, owner: string): Promise<boolean> {
    return (await this.client.set(this.key("seat", accountId), owner, { NX: true, EX: 90 })) === "OK";
  }
  async renew(accountId: string, owner: string): Promise<boolean> {
    return !!(await this.client.eval(RENEW, { keys: [this.key("seat", accountId)], arguments: [owner] }));
  }
  async release(accountId: string, owner: string): Promise<void> {
    await this.client.eval(RELEASE, { keys: [this.key("seat", accountId)], arguments: [owner] });
  }

  async publishPresence(accountId: string, record: PresenceRecord): Promise<void> {
    await this.client.set(this.key("presence", accountId), JSON.stringify(record), { EX: 90 });
  }
  async presence(accountIds: string[]): Promise<(PresenceRecord | null)[]> {
    if (!accountIds.length) return [];
    const values = await this.client.mGet(accountIds.map(id => this.key("presence", id)));
    return values.map(value => (value ? JSON.parse(String(value)) : null));
  }
  async clearPresence(accountId: string): Promise<void> {
    await this.client.del(this.key("presence", accountId));
  }

  /** Shared per-minute request window for an address (stored hashed). */
  async admit(address: string, maximum: number): Promise<boolean> {
    const id = createHash("sha256").update(address).digest("hex");
    return Number(await this.client.eval(COUNT, { keys: [this.key("rate", id)], arguments: [] })) <= maximum;
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}
