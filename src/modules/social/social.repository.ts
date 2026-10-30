import { randomUUID } from "node:crypto";
import { LessThan, MoreThan } from "typeorm";
import type { Database } from "../../infrastructure/database/database.js";
import { Block, FriendRequest, Friendship, LobbyInvite, User } from "../../infrastructure/database/entities/index.js";

export interface PlayerRow {
  id: string;
  username: string;
  displayName: string;
  /** The player's icon (a character id), empty for the equipped character. */
  avatar: string;
}
export interface InviteRow {
  id: string;
  senderName: string;
  roomId: string;
  expires: number;
}

/** A friendship is stored once per pair, with the lower id first. */
const pair = (accountId: string, otherId: string) => {
  const [low, high] = [accountId, otherId].sort();
  return { low, high };
};

/** Friends, friend requests, blocks and lobby invitations (tables friends, requests, blocks, invites). */
export class SocialRepository {
  constructor(private readonly db: Database) {}

  async userIdByUsername(username: string): Promise<string | null> {
    return (await this.db.repository(User).findOne({ where: { username }, select: { id: true } }))?.id ?? null;
  }

  /** The account whose current display name has this name key (see nameKey; names are unique). */
  async userIdByNameKey(key: string): Promise<string | null> {
    return (await this.db.repository(User).findOne({ where: { nameKey: key }, select: { id: true } }))?.id ?? null;
  }

  async blocked(accountId: string, otherId: string): Promise<boolean> {
    return this.db.repository(Block).exists({
      where: [
        { owner: accountId, target: otherId },
        { owner: otherId, target: accountId },
      ],
    });
  }
  async friends(accountId: string, otherId: string): Promise<boolean> {
    return this.db.repository(Friendship).existsBy(pair(accountId, otherId));
  }
  async requestExists(sender: string, recipient: string): Promise<boolean> {
    return this.db.repository(FriendRequest).existsBy({ sender, recipient });
  }
  async pendingRequests(sender: string): Promise<number> {
    return this.db.repository(FriendRequest).countBy({ sender });
  }

  async addRequest(sender: string, recipient: string): Promise<void> {
    await this.db.manager
      .createQueryBuilder()
      .insert()
      .into(FriendRequest)
      .values({ sender, recipient })
      .orIgnore()
      .execute();
  }
  async removeRequest(sender: string, recipient: string): Promise<void> {
    await this.db.repository(FriendRequest).delete({ sender, recipient });
  }
  async removeRequestsBetween(accountId: string, otherId: string): Promise<void> {
    await this.db.repository(FriendRequest).delete({ sender: accountId, recipient: otherId });
    await this.db.repository(FriendRequest).delete({ sender: otherId, recipient: accountId });
  }

  async addFriendship(accountId: string, otherId: string): Promise<void> {
    await this.db.manager
      .createQueryBuilder()
      .insert()
      .into(Friendship)
      .values(pair(accountId, otherId))
      .orIgnore()
      .execute();
  }
  async removeFriendship(accountId: string, otherId: string): Promise<void> {
    await this.db.repository(Friendship).delete(pair(accountId, otherId));
  }

  async addBlock(owner: string, target: string): Promise<void> {
    await this.db.manager.createQueryBuilder().insert().into(Block).values({ owner, target }).orIgnore().execute();
  }
  async removeBlock(owner: string, target: string): Promise<void> {
    await this.db.repository(Block).delete({ owner, target });
  }

  async addInvite(sender: string, recipient: string, roomId: string, expires: number): Promise<void> {
    await this.db.repository(LobbyInvite).insert({ id: randomUUID(), sender, recipient, roomId, expires });
  }
  liveInvite(id: string, recipient: string): Promise<LobbyInvite | null> {
    return this.db.repository(LobbyInvite).findOneBy({ id, recipient, expires: MoreThan(Date.now()) });
  }
  async removeInvite(id: string): Promise<void> {
    await this.db.repository(LobbyInvite).delete({ id });
  }
  async removeInvitesBetween(accountId: string, otherId: string): Promise<void> {
    await this.db.repository(LobbyInvite).delete({ sender: accountId, recipient: otherId });
    await this.db.repository(LobbyInvite).delete({ sender: otherId, recipient: accountId });
  }
  async removeExpiredInvites(): Promise<void> {
    await this.db.repository(LobbyInvite).delete({ expires: LessThan(Date.now()) });
  }

  friendList(id: string): Promise<PlayerRow[]> {
    return this.db.query(
      `SELECT id,username,display_name AS displayName,avatar FROM users WHERE id IN
      (SELECT CASE WHEN low=? THEN high ELSE low END FROM friends WHERE low=? OR high=?) ORDER BY username`,
      [id, id, id],
    );
  }
  incomingRequests(id: string): Promise<PlayerRow[]> {
    return this.db.query(
      `SELECT id, username, display_name AS displayName, avatar
       FROM users JOIN requests ON users.id = requests.sender
       WHERE requests.recipient = ? ORDER BY username`,
      [id],
    );
  }
  outgoingRequests(id: string): Promise<PlayerRow[]> {
    return this.db.query(
      `SELECT id, username, display_name AS displayName, avatar
       FROM users JOIN requests ON users.id = requests.recipient
       WHERE requests.sender = ? ORDER BY username`,
      [id],
    );
  }
  invitesFor(id: string): Promise<InviteRow[]> {
    return this.db.query(
      `SELECT invites.id, users.display_name AS senderName, room_id AS roomId, expires
       FROM invites JOIN users ON users.id = invites.sender
       WHERE recipient = ?`,
      [id],
    );
  }
  blockedList(id: string): Promise<PlayerRow[]> {
    return this.db.query(
      `SELECT id,username,display_name AS displayName,avatar
       FROM users JOIN blocks ON users.id=blocks.target WHERE owner=?`,
      [id],
    );
  }
}
