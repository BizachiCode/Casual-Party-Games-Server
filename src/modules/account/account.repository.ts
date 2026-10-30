import { In, LessThan, MoreThan } from "typeorm";
import type { Database } from "../../infrastructure/database/database.js";
import { DeviceLogin, Session, TimeTrialRecord, User } from "../../infrastructure/database/entities/index.js";
import { nameKey } from "../../shared/text.js";

export interface ProfileRow {
  id: string;
  username: string;
  displayName: string;
  xp: number;
  wins: number;
  matches: number;
  color: number;
  guest: boolean;
  avatar: string;
  createdAt: number;
}

export interface NameState {
  displayName: string;
  nameChangedAt: number;
}

type NewUser = Pick<User, "id" | "username" | "displayName" | "salt" | "passwordHash" | "createdAt" | "lastSeen">;

/** Whether a write failed because another account already has the display name (see nameKey). */
export function nameTaken(error: unknown): boolean {
  const failure = error as { code?: string; sqlMessage?: string; message?: string };
  return failure.code === "ER_DUP_ENTRY" && /UQ_users_name_key/.test(failure.sqlMessage ?? failure.message ?? "");
}

/** Accounts and sign-in sessions (tables users, sessions). */
export class AccountRepository {
  constructor(private readonly db: Database) {}

  private get users() {
    return this.db.repository(User);
  }
  private get sessions() {
    return this.db.repository(Session);
  }

  profile(id: string): Promise<ProfileRow | null> {
    return this.users.findOne({
      where: { id },
      select: {
        id: true,
        username: true,
        displayName: true,
        xp: true,
        wins: true,
        matches: true,
        color: true,
        guest: true,
        avatar: true,
        createdAt: true,
      },
    });
  }
  byUsername(username: string): Promise<User | null> {
    return this.users.findOneBy({ username });
  }
  usernameTaken(username: string): Promise<boolean> {
    return this.users.existsBy({ username });
  }
  async create(user: NewUser): Promise<void> {
    await this.users.insert({ ...user, nameKey: nameKey(user.displayName) });
  }
  /** A guest account and the device that signs in to it, together or not at all. */
  async createGuest(user: NewUser, device: Pick<DeviceLogin, "deviceId" | "secretHash" | "createdAt">): Promise<void> {
    await this.db.transaction(async () => {
      await this.users.insert({ ...user, nameKey: nameKey(user.displayName), guest: true });
      await this.db.repository(DeviceLogin).insert({ ...device, userId: user.id });
    });
  }
  deviceLogin(deviceId: string): Promise<DeviceLogin | null> {
    return this.db.repository(DeviceLogin).findOneBy({ deviceId });
  }
  /** Gives a guest account its username and password; false when the account is not a guest (any more). */
  async upgradeGuest(id: string, username: string, salt: string, passwordHash: string): Promise<boolean> {
    const result = await this.users.update({ id, guest: true }, { username, salt, passwordHash, guest: false });
    return !!result.affected;
  }
  async setColor(id: string, color: number): Promise<void> {
    await this.users.update({ id }, { color });
  }
  /** The display name and when it last changed. */
  nameState(id: string): Promise<NameState | null> {
    return this.users.findOne({ where: { id }, select: { displayName: true, nameChangedAt: true } });
  }
  /** Fails with a duplicate entry (see nameTaken) when another account has the name. */
  async setName(id: string, displayName: string, changedAt: number): Promise<void> {
    await this.users.update({ id }, { displayName, nameKey: nameKey(displayName), nameChangedAt: changedAt });
  }
  async setAvatar(id: string, avatar: string): Promise<void> {
    await this.users.update({ id }, { avatar });
  }
  /** How many courses the account has a time trial record for. */
  timeTrialCount(id: string): Promise<number> {
    return this.db.repository(TimeTrialRecord).countBy({ userId: id });
  }
  async setLastSeen(id: string, lastSeen: number): Promise<void> {
    await this.users.update({ id }, { lastSeen });
  }

  async openSession(tokenHash: string, userId: string, expires: number): Promise<void> {
    await this.sessions.delete({ expires: LessThan(Date.now()) });
    await this.sessions.insert({ tokenHash, userId, expires });
  }
  async sessionUser(tokenHash: string): Promise<string | null> {
    return (await this.sessions.findOneBy({ tokenHash, expires: MoreThan(Date.now()) }))?.userId ?? null;
  }
  /** token hash -> account id, for every live session among these hashes. */
  async sessionUsers(tokenHashes: string[]): Promise<Map<string, string>> {
    const rows = await this.sessions.findBy({ tokenHash: In(tokenHashes), expires: MoreThan(Date.now()) });
    return new Map(rows.map(row => [row.tokenHash, row.userId]));
  }
  async closeSession(tokenHash: string): Promise<void> {
    await this.sessions.delete({ tokenHash });
  }
  /** Deletes every session of the account; returns how many. */
  async closeSessions(userId: string): Promise<number> {
    return (await this.sessions.delete({ userId })).affected ?? 0;
  }
}
