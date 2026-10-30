/** One match chat message as the room delivered it. `accountId` is empty for players without an account. */
export interface ChatLine {
  at: number;
  roomId: string;
  sessionId: string;
  accountId: string;
  name: string;
  text: string;
}

export interface ChatFilter {
  roomId?: string;
  accountId?: string;
  /** Case-insensitive text the message or the sender's name contains. */
  contains?: string;
  limit?: number;
}

/**
 * The latest match chat of this process, kept in memory for the GM console and as evidence for player reports (a
 * report copies the lines it needs into MySQL). Nothing here survives a restart, and chat is never written to disk
 * otherwise.
 */
export class ChatLog {
  private readonly lines: ChatLine[] = [];
  private next = 0;

  constructor(readonly capacity = 2000) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Chat log capacity must be a positive integer.");
  }

  add(line: ChatLine): void {
    if (this.lines.length < this.capacity) this.lines.push(line);
    else this.lines[this.next] = line;
    this.next = (this.next + 1) % this.capacity;
  }

  /** Matching lines, newest first, at most `limit` (100 by default, 500 at most). */
  recent(filter: ChatFilter = {}): ChatLine[] {
    const limit = Math.max(1, Math.min(500, filter.limit ?? 100));
    const contains = filter.contains?.toLowerCase();
    const found: ChatLine[] = [];
    for (let i = 1; i <= this.lines.length && found.length < limit; i++) {
      const line = this.lines[(this.next - i + this.lines.length) % this.lines.length];
      if (filter.roomId && line.roomId !== filter.roomId) continue;
      if (filter.accountId && line.accountId !== filter.accountId) continue;
      if (contains && !line.text.toLowerCase().includes(contains) && !line.name.toLowerCase().includes(contains))
        continue;
      found.push(line);
    }
    return found;
  }

  get size(): number {
    return this.lines.length;
  }
}
