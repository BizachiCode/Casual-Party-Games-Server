import type { Database } from "../../infrastructure/database/database.js";
import { ApiError } from "../../shared/errors.js";
import { nameTaken } from "../account/account.repository.js";
import { type AccountService, nameTakenError } from "../account/account.service.js";
import type { CollectionRepository, WalletRow } from "../collection/collection.repository.js";
import type { CollectionService } from "../collection/collection.service.js";
import type { MatchRegistry } from "../match/match-registry.js";
import type { PresenceService } from "../presence/presence.service.js";
import { seasonWindow } from "../season/season.catalog.js";
import type { SeasonService } from "../season/season.service.js";
import type { SquadRegistry } from "../squad/squad-registry.js";
import type { AdminAudit, AuditActor, AuditEntry } from "./admin-audit.service.js";
import type {
  AdminPlayersRepository,
  DeviceRow,
  LedgerRow,
  PlayerFilter,
  PlayerRef,
  PlayerSort,
  RankingRow,
  RestrictionRow,
  SocialCounts,
  TimeRow,
} from "./admin-players.repository.js";

export type { PlayerFilter, PlayerRef, PlayerSort, RestrictionRow } from "./admin-players.repository.js";

export interface AdminPlayersDependencies {
  db: Database;
  records: AdminPlayersRepository;
  accounts: AccountService;
  collection: CollectionService;
  collectionRecords: CollectionRepository;
  seasons: SeasonService;
  presence: PresenceService;
  matches: MatchRegistry;
  squads: SquadRegistry;
  audit: AdminAudit;
  clock: () => Date;
}

const DAY_MS = 86400000;
/** Wallet columns are 32-bit integers. */
const MAX_BALANCE = 2147483647;

/** One line of GET /players. */
export interface PlayerRow extends PlayerRef {
  level: number;
  xp: number;
  wins: number;
  matches: number;
  stars: number;
  shards: number;
  createdAt: number;
  lastSeen: number;
  banned: { reason: string; until: number | null } | null;
  muted: { reason: string; until: number | null } | null;
  online: boolean;
  roomId: string;
  partyId: string;
}

/** GET /players. */
export interface PlayerList {
  total: number;
  page: number;
  pageSize: number;
  players: PlayerRow[];
}

export interface PlayerListRequest {
  q: string;
  filter: PlayerFilter;
  sort: PlayerSort;
  descending: boolean;
  page: number;
  pageSize: number;
}

/** GET /players/:id. */
export interface PlayerDetail {
  player: PlayerRef & {
    color: number;
    xp: number;
    level: number;
    wins: number;
    matches: number;
    createdAt: number;
    lastSeen: number;
    /** Sessions that have not expired. */
    sessions: number;
    devices: DeviceRow[];
  };
  presence: { online: boolean; roomId: string; partyId: string };
  wallet: { stars: number; shards: number; pityEpic: number; pityLegendary: number; equipped: string } | null;
  characters: { id: string; name: string; rarity: string; owned: boolean; equipped: boolean; starter: boolean }[];
  season: { id: string; xp: number; tier: number; tiers: number; premium: boolean } | null;
  rankings: RankingRow[];
  times: TimeRow[];
  social: SocialCounts;
  moderation: {
    ban: RestrictionRow | null;
    mute: RestrictionRow | null;
    reportsAgainst: { open: number; total: number };
    reportsFiled: number;
  };
  ledger: { entries: number; gm: LedgerRow[] };
  history: AuditEntry[];
}

export interface AdjustRequest {
  delta: number;
  requestId: string;
  note?: string;
}

export interface GrantRequest {
  targets: string[];
  stars?: number;
  shards?: number;
  characterId?: string;
  passXp?: number;
  note?: string;
  requestId: string;
}

export interface GrantResult {
  target: string;
  id: string | null;
  name: string | null;
  ok: boolean;
  duplicate?: boolean;
  error?: string;
}

/** GM view and edits of player accounts: lists, details, economy edits and grants. */
export class AdminPlayersService {
  constructor(private readonly deps: AdminPlayersDependencies) {}

  private async requirePlayer(id: string) {
    const account = await this.deps.records.account(id);
    if (!account) throw new ApiError(404, "Player not found.");
    return account;
  }

  private requireCharacter(characterId: string) {
    const character = this.deps.collection.catalog.characters.find(candidate => candidate.id === characterId);
    if (!character) throw new ApiError(400, "Unknown character.");
    return character;
  }

  async search(text: string, limit: number): Promise<{ results: PlayerRef[] }> {
    return { results: text ? await this.deps.records.search(text, limit) : [] };
  }

  async list(request: PlayerListRequest): Promise<PlayerList> {
    const now = +this.deps.clock();
    const { total, rows } = await this.deps.records.list({
      text: request.q,
      filter: request.filter,
      sort: request.sort,
      descending: request.descending,
      onlineIds: request.filter === "online" ? this.deps.presence.onlineIds() : [],
      now,
      newSince: now - DAY_MS,
      offset: (request.page - 1) * request.pageSize,
      limit: request.pageSize,
    });
    await this.deps.presence.refresh(rows.map(row => row.id));
    const players = rows.map(({ ban, mute, ...row }) => ({
      ...row,
      level: 1 + Math.floor(row.xp / 250),
      banned: ban,
      muted: mute,
      ...this.deps.presence.status(row.id),
    }));
    return { total, page: request.page, pageSize: request.pageSize, players };
  }

  async detail(id: string): Promise<PlayerDetail> {
    const { records, collectionRecords, collection, seasons, presence, audit } = this.deps;
    const account = await this.requirePlayer(id);
    const now = +this.deps.clock();
    await presence.refresh([id]);
    // Viewing never creates a wallet: a player who has not opened the collection yet simply has none.
    const wallet: WalletRow | null = await collectionRecords.wallet(id);
    const owned = new Set(await collectionRecords.owned(id));
    const { starterId } = collection.catalog;
    const running = seasons.current();
    const progress = running ? await records.seasonProgress(id, running.id) : null;
    const { guest, color, xp, wins, matches, createdAt, lastSeen, ...ref } = account;
    return {
      player: {
        ...ref,
        guest,
        color,
        xp,
        level: 1 + Math.floor(xp / 250),
        wins,
        matches,
        createdAt,
        lastSeen,
        sessions: await records.liveSessions(id, now),
        devices: await records.devices(id),
      },
      presence: presence.status(id),
      wallet: wallet && {
        stars: wallet.credits,
        shards: wallet.shards,
        pityEpic: wallet.pityEpic,
        pityLegendary: wallet.pityLegendary,
        equipped: wallet.equipped,
      },
      characters: collection.catalog.characters.map(character => ({
        id: character.id,
        name: character.name,
        rarity: character.rarity,
        owned: owned.has(character.id),
        equipped: wallet?.equipped === character.id,
        starter: character.id === starterId,
      })),
      season:
        running && progress
          ? {
              id: running.id,
              xp: progress.xp,
              tier: running.tiers.filter(tier => progress.xp >= tier.xp).length,
              tiers: running.tiers.length,
              premium: progress.premium,
            }
          : null,
      rankings: await records.rankings(id),
      times: await records.times(id),
      social: await records.social(id),
      moderation: await records.moderation(id, now),
      ledger: await records.ledger(id),
      history: (await audit.list({ targetId: id, page: 1, pageSize: 50 })).entries,
    };
  }

  async rename(actor: AuditActor, id: string, displayName: string): Promise<{ ok: true; displayName: string }> {
    const account = await this.requirePlayer(id);
    // The same rules as the players' own rename (length, letters, blocklist), without its cooldown.
    const name = this.deps.accounts.names.check(displayName);
    try {
      await this.deps.records.rename(id, name);
    } catch (error) {
      if (nameTaken(error)) throw nameTakenError();
      throw error;
    }
    await this.deps.audit.record(actor, "player.rename", id, { from: account.displayName, to: name });
    return { ok: true, displayName: name };
  }

  /** Adds or removes Stars once per request id; the ledger keeps the change as `gm:<request id>`. */
  adjustStars(
    actor: AuditActor,
    id: string,
    request: AdjustRequest,
  ): Promise<{ ok: true; stars: number; duplicate?: true }> {
    return this.deps.db.transaction(async () => {
      const { db, audit, collection, collectionRecords } = this.deps;
      await this.requirePlayer(id);
      await db.lockUsers([id]);
      await collection.init(id);
      const details = { delta: request.delta, note: request.note };
      if (!(await audit.claim(actor, "player.stars", id, request.requestId, details)))
        return { ok: true, duplicate: true, stars: (await collectionRecords.wallet(id)).credits };
      const { credits } = await collectionRecords.wallet(id);
      if (request.delta < 0 && credits < -request.delta)
        throw new ApiError(409, `The player has only ${credits} Stars.`);
      if (credits + request.delta > MAX_BALANCE) throw new ApiError(409, "The Star balance would be too large.");
      if (await collectionRecords.recordCredit(id, "gm:" + request.requestId, request.delta)) {
        if (request.delta > 0) await collectionRecords.addCredits(id, request.delta);
        else await collectionRecords.spendCredits(id, -request.delta);
      }
      return { ok: true, stars: (await collectionRecords.wallet(id)).credits };
    });
  }

  /** Adds or removes shards once per request id (the audit row is the receipt). */
  adjustShards(
    actor: AuditActor,
    id: string,
    request: AdjustRequest,
  ): Promise<{ ok: true; shards: number; duplicate?: true }> {
    return this.deps.db.transaction(async () => {
      const { db, audit, collection, collectionRecords } = this.deps;
      await this.requirePlayer(id);
      await db.lockUsers([id]);
      await collection.init(id);
      const details = { delta: request.delta, note: request.note };
      if (!(await audit.claim(actor, "player.shards", id, request.requestId, details)))
        return { ok: true, duplicate: true, shards: (await collectionRecords.wallet(id)).shards };
      const { shards } = await collectionRecords.wallet(id);
      if (request.delta < 0 && shards < -request.delta)
        throw new ApiError(409, `The player has only ${shards} shards.`);
      if (shards + request.delta > MAX_BALANCE) throw new ApiError(409, "The shard balance would be too large.");
      if (request.delta > 0) await collectionRecords.addShards(id, request.delta);
      else await collectionRecords.spendShards(id, -request.delta);
      return { ok: true, shards: shards + request.delta };
    });
  }

  async setXp(actor: AuditActor, id: string, xp: number): Promise<{ ok: true; xp: number; level: number }> {
    const account = await this.requirePlayer(id);
    await this.deps.records.setXp(id, xp);
    await this.deps.audit.record(actor, "player.xp", id, { from: account.xp, to: xp });
    return { ok: true, xp, level: 1 + Math.floor(xp / 250) };
  }

  async grantCharacter(actor: AuditActor, id: string, characterId: string): Promise<{ ok: true; added: boolean }> {
    this.requireCharacter(characterId);
    await this.requirePlayer(id);
    const added = await this.deps.db.transaction(async () => {
      await this.deps.db.lockUsers([id]);
      await this.deps.collection.init(id);
      return this.deps.collectionRecords.grantCharacter(id, characterId);
    });
    await this.deps.audit.record(actor, "player.character.grant", id, { characterId, added });
    return { ok: true, added };
  }

  async revokeCharacter(actor: AuditActor, id: string, characterId: string): Promise<{ ok: true; removed: boolean }> {
    this.requireCharacter(characterId);
    if (characterId === this.deps.collection.catalog.starterId)
      throw new ApiError(409, "The starter character cannot be removed.");
    await this.requirePlayer(id);
    const removed = await this.deps.db.transaction(async () => {
      const { db, collection, collectionRecords } = this.deps;
      await db.lockUsers([id]);
      await collection.init(id);
      const took = await collectionRecords.removeCharacter(id, characterId);
      // A runner cannot stay dressed as a character it no longer owns.
      if ((await collectionRecords.wallet(id)).equipped === characterId)
        await collectionRecords.setEquipped(id, collection.catalog.starterId);
      return took;
    });
    await this.deps.audit.record(actor, "player.character.revoke", id, { characterId, removed });
    return { ok: true, removed };
  }

  async equip(actor: AuditActor, id: string, characterId: string): Promise<{ ok: true }> {
    this.requireCharacter(characterId);
    await this.requirePlayer(id);
    await this.deps.db.transaction(async () => {
      const { db, collection, collectionRecords } = this.deps;
      await db.lockUsers([id]);
      await collection.init(id);
      if (!(await collectionRecords.owns(id, characterId)))
        throw new ApiError(409, "The player does not own this character.");
      await collectionRecords.setEquipped(id, characterId);
    });
    await this.deps.audit.record(actor, "player.equip", id, { characterId });
    return { ok: true };
  }

  /** Adds battle pass XP to the running season once per request id. */
  async grantPassXp(
    actor: AuditActor,
    id: string,
    request: { xp: number; requestId: string },
  ): Promise<{ ok: true; granted: number }> {
    await this.requirePlayer(id);
    if (!this.deps.seasons.current()) throw new ApiError(409, "No season is running.");
    const granted = await this.deps.seasons.grantXp(id, "gm:" + request.requestId, request.xp);
    await this.deps.audit.record(actor, "player.passXp", id, { xp: request.xp, granted });
    return { ok: true, granted };
  }

  async setPremium(
    actor: AuditActor,
    id: string,
    seasonId: string,
    owned: boolean,
  ): Promise<{ ok: true; changed: boolean }> {
    await this.requirePlayer(id);
    const season = (await this.deps.seasons.seasonSchedule()).find(candidate => candidate.id === seasonId);
    if (!season) throw new ApiError(404, "Season not found.");
    // The premium table points at the frozen season policy, which exists once the season has started.
    if (seasonWindow(season).start > +this.deps.clock()) throw new ApiError(409, "That season has not started yet.");
    await this.deps.seasons.ensure(season.id);
    const changed = await this.deps.records.setPremium(id, season.id, owned, +this.deps.clock());
    await this.deps.audit.record(actor, "player.premium", id, { seasonId: season.id, owned });
    return { ok: true, changed };
  }

  async resetRankings(
    actor: AuditActor,
    id: string,
    scope: "boards" | "times" | "all",
  ): Promise<{ ok: true; removed: number }> {
    await this.requirePlayer(id);
    const removed = await this.deps.records.resetRankings(id, scope !== "times", scope !== "boards");
    await this.deps.audit.record(actor, "player.rankings.reset", id, { scope, removed });
    return { ok: true, removed };
  }

  /**
   * Gives the same reward to many accounts. Each target is its own transaction keyed by `<request id>:<account id>`,
   * so a retried request pays the targets that were not paid yet and nobody twice; one failure stops no one else.
   */
  async grant(actor: AuditActor, request: GrantRequest): Promise<{ results: GrantResult[] }> {
    if (request.characterId) this.requireCharacter(request.characterId);
    if (request.passXp && !this.deps.seasons.current()) throw new ApiError(409, "No season is running.");
    const results: GrantResult[] = [];
    for (const target of request.targets) results.push(await this.grantTo(actor, target, request));
    return { results };
  }

  private async grantTo(actor: AuditActor, target: string, request: GrantRequest): Promise<GrantResult> {
    const player = await this.deps.records.resolveTarget(target);
    if (!player) return { target, id: null, name: null, ok: false, error: "Player not found." };
    const key = request.requestId + ":" + player.id;
    const { stars, shards, characterId, passXp, note } = request;
    try {
      const applied = await this.deps.db.transaction(async () => {
        const { db, audit, collection, collectionRecords, seasons } = this.deps;
        await db.lockUsers([player.id]);
        await collection.init(player.id);
        if (!(await audit.claim(actor, "grant", player.id, key, { stars, shards, characterId, passXp, note })))
          return false;
        const wallet = await collectionRecords.wallet(player.id);
        if (wallet.credits + (stars ?? 0) > MAX_BALANCE || wallet.shards + (shards ?? 0) > MAX_BALANCE)
          throw new ApiError(409, "The balance would be too large.");
        if (stars && (await collectionRecords.recordCredit(player.id, "gm:" + key, stars)))
          await collectionRecords.addCredits(player.id, stars);
        if (shards) await collectionRecords.addShards(player.id, shards);
        if (characterId) await collectionRecords.grantCharacter(player.id, characterId);
        if (passXp) await seasons.grantXp(player.id, "gm:" + key, passXp);
        return true;
      });
      return { target, id: player.id, name: player.displayName, ok: true, ...(applied ? {} : { duplicate: true }) };
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "The grant failed.";
      return { target, id: player.id, name: player.displayName, ok: false, error: message };
    }
  }
}
