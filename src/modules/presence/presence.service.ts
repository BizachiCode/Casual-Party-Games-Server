import type { PresenceRecord, RedisCoordination } from "../../infrastructure/redis/coordination.js";

const ONLINE_WINDOW_MS = 90000;
const PUBLISH_INTERVAL_MS = 15000;

/**
 * Who is online, in which lobby and in which party, for the friends list. Kept in memory and, with Redis, shared across
 * processes (published when the lobby or party changes or every 15 s, expiring after 90 s).
 */
export class PresenceService {
  private readonly records = new Map<string, PresenceRecord>();

  constructor(private readonly redis?: RedisCoordination) {}

  /** Marks the account as seen now; `roomId` updates the lobby it is in ("" for none, undefined to keep it). */
  touch(accountId: string, roomId?: string): void {
    const previous = this.records.get(accountId);
    const current: PresenceRecord = {
      seen: Date.now(),
      roomId: roomId === undefined ? previous?.roomId || "" : roomId,
      partyId: previous?.partyId || "",
    };
    this.records.set(accountId, current);
    if (
      this.redis &&
      (!previous ||
        current.roomId !== previous.roomId ||
        current.seen - (previous.published || 0) > PUBLISH_INTERVAL_MS)
    ) {
      current.published = current.seen;
      this.redis.publishPresence(accountId, current).catch(() => {});
    } else {
      current.published = previous?.published || 0;
    }
  }

  /** Sets the party (squad room id) the account sits in, "" when it left. */
  setParty(accountId: string, partyId: string): void {
    const previous = this.records.get(accountId);
    this.touch(accountId);
    const current = this.records.get(accountId);
    current.partyId = partyId;
    // A changed party is worth publishing at once; touch() only republishes on a changed room or after 15 s.
    if (this.redis && (previous?.partyId || "") !== partyId) {
      current.published = current.seen;
      this.redis.publishPresence(accountId, current).catch(() => {});
    }
  }

  async forget(accountId: string): Promise<void> {
    this.records.delete(accountId);
    await this.redis?.clearPresence(accountId);
  }

  /** Pulls the shared state of these accounts (other processes may host them). */
  async refresh(accountIds: string[]): Promise<void> {
    if (!this.redis) return;
    const states = await this.redis.presence(accountIds);
    accountIds.forEach((id, i) => {
      if (states[i]) this.records.set(id, states[i]);
      else this.records.delete(id);
    });
  }

  /** Every account this process knows to be online now (the GM console's online filter and counter). */
  onlineIds(): string[] {
    const threshold = Date.now() - ONLINE_WINDOW_MS;
    return [...this.records].filter(([, record]) => record.seen > threshold).map(([accountId]) => accountId);
  }

  status(accountId: string): { online: boolean; roomId: string; partyId: string } {
    const record = this.records.get(accountId);
    const online = (record?.seen || 0) > Date.now() - ONLINE_WINDOW_MS;
    return { online, roomId: online ? record?.roomId || "" : "", partyId: online ? record?.partyId || "" : "" };
  }
}
