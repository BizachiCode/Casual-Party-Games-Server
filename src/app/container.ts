import { join } from "node:path";
import type { ServerSettings } from "../config/env.js";
import { gameConfigDirectory } from "../config/paths.js";
import { createDatabase, type Database } from "../infrastructure/database/database.js";
import { RedisCoordination } from "../infrastructure/redis/coordination.js";
import { createAdminGuard, type AdminGuard } from "../shared/admin-guard.js";
import { AdminAuditRepository } from "../modules/admin/admin-audit.repository.js";
import { AdminAudit } from "../modules/admin/admin-audit.service.js";
import { AdminInsightsRepository } from "../modules/admin/admin-insights.repository.js";
import { AdminInsightsService } from "../modules/admin/admin-insights.service.js";
import { AdminLiveService } from "../modules/admin/admin-live.service.js";
import { AdminPlayersRepository } from "../modules/admin/admin-players.repository.js";
import { AdminPlayersService } from "../modules/admin/admin-players.service.js";
import { AccountRepository } from "../modules/account/account.repository.js";
import { AccountDeletionRepository } from "../modules/account/account-deletion.repository.js";
import { AccountDeletionService } from "../modules/account/account-deletion.service.js";
import { AccountService } from "../modules/account/account.service.js";
import { loadNameRules } from "../modules/account/name-rules.js";
import { ProfileService } from "../modules/account/profile.service.js";
import { CollectionRepository } from "../modules/collection/collection.repository.js";
import { CollectionService } from "../modules/collection/collection.service.js";
import { loadContent } from "../modules/content/active-content.js";
import { GameConfigService } from "../modules/content/game-config.service.js";
import { ContentGuard } from "../modules/content/content.guard.js";
import type { PartyContent } from "../modules/content/content.types.js";
import { loadEventCatalog, type EventCatalog } from "../modules/events/events.catalog.js";
import { EventRepository } from "../modules/events/events.repository.js";
import { EventService } from "../modules/events/events.service.js";
import { MatchRegistry } from "../modules/match/match-registry.js";
import {
  loadMatchmakingCatalog,
  matchmakingCatalogPath,
  validateMatchmakingCatalog,
} from "../modules/matchmaking/matchmaking.catalog.js";
import type { MatchmakingServices } from "../modules/matchmaking/matchmaking.room.js";
import { MatchmakingService } from "../modules/matchmaking/matchmaking.service.js";
import type { MatchmakingCatalog } from "../modules/matchmaking/matchmaking.types.js";
import { MatchRewardService } from "../modules/match/match-rewards.service.js";
import type { MatchServices } from "../modules/match/party.room.js";
import { ChatLog } from "../modules/moderation/chat-log.js";
import { ModerationRepository } from "../modules/moderation/moderation.repository.js";
import { ModerationService } from "../modules/moderation/moderation.service.js";
import { OperationsService } from "../modules/operations/operations.service.js";
import { PresenceService } from "../modules/presence/presence.service.js";
import { ProgressionRepository } from "../modules/progression/progression.repository.js";
import { ProgressionService } from "../modules/progression/progression.service.js";
import { RankingRepository } from "../modules/ranking/ranking.repository.js";
import { RankingService } from "../modules/ranking/ranking.service.js";
import { loadSeasonCatalog, type SeasonCatalog } from "../modules/season/season.catalog.js";
import { SeasonRepository } from "../modules/season/season.repository.js";
import { SeasonService } from "../modules/season/season.service.js";
import { SquadRegistry } from "../modules/squad/squad-registry.js";
import type { SquadServices } from "../modules/squad/squad.room.js";
import { SocialRepository } from "../modules/social/social.repository.js";
import { SocialService } from "../modules/social/social.service.js";
import type { IapStoreVerifier } from "../modules/store/iap/iap.ports.js";
import { StoreReceiptValidator } from "../modules/store/iap/iap-receipt-validator.js";
import { loadStoreCatalog, validateStoreCatalog, type StoreCatalog } from "../modules/store/store.catalog.js";
import { StoreRepository } from "../modules/store/store.repository.js";
import { StoreService } from "../modules/store/store.service.js";
import { createStoreVerifiers } from "../modules/store/store.verifiers.js";

export interface ContainerOptions {
  /** Content to run instead of loading it from the settings (tests). */
  content?: PartyContent;
  /** Matchmaking rules to run instead of loading them from the settings (tests). */
  matchmaking?: MatchmakingCatalog;
  seasonCatalog?: SeasonCatalog;
  /** Event catalog to run instead of loading it from the settings (tests). */
  events?: EventCatalog;
  /** Store catalog to run instead of loading it from the settings (tests). */
  store?: StoreCatalog;
  /** Store verifiers to use instead of the real Google Play and App Store ones (tests). */
  storeVerifiers?: IapStoreVerifier[];
  /** Where an uploaded export is written instead of game_config (tests). */
  gameConfigDirectory?: string;
  /** Seconds before a party's unfinished search is abandoned; 60 unless a test shortens it. */
  squadSearchSeconds?: number;
  clock?: () => Date;
}

/**
 * Composition root: builds every repository and service once and wires them together. Connections open in start()
 * (before the server listens) and close in stop() (after the last room is gone).
 */
export class PartyContainer {
  readonly content: PartyContent;
  readonly database: Database;
  readonly redis?: RedisCoordination;
  readonly matches = new MatchRegistry();
  readonly squads = new SquadRegistry();
  readonly presence: PresenceService;
  readonly accounts: AccountService;
  /** The player's own profile (nickname, icon, statistics) and in-app account deletion. */
  readonly profiles: ProfileService;
  readonly accountDeletion: AccountDeletionService;
  readonly social: SocialService;
  readonly collection: CollectionService;
  readonly rankings: RankingService;
  readonly progression: ProgressionService;
  readonly seasons: SeasonService;
  readonly events: EventService;
  readonly rewards: MatchRewardService;
  readonly operations: OperationsService;
  readonly contentGuard: ContentGuard;
  /** Exports uploaded from Unity, checked and written to game_config for the next start. */
  readonly gameConfig: GameConfigService;
  readonly matchmaking: MatchmakingService;
  readonly store: StoreService;
  /** The GM console: admin key gate, audit log, moderation, the chat of this process and the GM services. */
  readonly adminGuard: AdminGuard;
  readonly audit: AdminAudit;
  readonly moderation: ModerationService;
  readonly chatLog = new ChatLog();
  readonly adminPlayers: AdminPlayersService;
  readonly adminInsights: AdminInsightsService;
  readonly adminLive: AdminLiveService;

  private readonly squadSearchSeconds: number;

  constructor(
    readonly settings: ServerSettings,
    options: ContainerOptions = {},
  ) {
    this.squadSearchSeconds = options.squadSearchSeconds ?? 60;
    const clock = options.clock ?? (() => new Date());
    this.content = options.content ?? loadContent(settings.contentBundlePath);
    const { config, characterCatalog, goalCatalog } = this.content;
    const db = (this.database = createDatabase(settings.databaseUrl));
    this.redis = settings.redisUrl ? new RedisCoordination(settings.redisUrl, settings.redisPrefix) : undefined;

    const collectionRecords = new CollectionRepository(db);
    const seasonRecords = new SeasonRepository(db);
    this.presence = new PresenceService(this.redis);
    this.moderation = new ModerationService(db, new ModerationRepository(db), clock);
    const accountRecords = new AccountRepository(db);
    this.accounts = new AccountService(
      accountRecords,
      this.presence,
      this.moderation,
      loadNameRules(settings.nameBlocklistPath, join(gameConfigDirectory, "name-blocklist.txt")),
    );
    this.social = new SocialService(db, new SocialRepository(db), this.accounts, this.presence);
    this.collection = new CollectionService(db, collectionRecords, characterCatalog);
    this.collection.clock = clock;
    this.profiles = new ProfileService({
      db,
      accounts: this.accounts,
      records: accountRecords,
      collection: this.collection,
      cooldownHours: settings.renameCooldownHours ?? 24,
      clock,
    });
    this.rankings = new RankingService(db, new RankingRepository(db), config, clock);
    this.seasons = new SeasonService(
      db,
      seasonRecords,
      this.collection,
      collectionRecords,
      options.seasonCatalog ?? loadSeasonCatalog(settings.seasonCatalogPath),
      clock,
    );
    this.progression = new ProgressionService(
      db,
      new ProgressionRepository(db),
      goalCatalog,
      this.accounts,
      this.collection,
      clock,
      this.seasons,
    );
    const matchmakingCatalog = options.matchmaking
      ? validateMatchmakingCatalog(options.matchmaking, config)
      : loadMatchmakingCatalog(
          matchmakingCatalogPath(settings.matchmakingCatalogPath, settings.contentBundlePath),
          config,
        );
    this.matchmaking = new MatchmakingService(matchmakingCatalog, config);
    this.events = new EventService(
      db,
      new EventRepository(db),
      this.collection,
      collectionRecords,
      this.matchmaking,
      config,
      options.events ?? loadEventCatalog(settings.eventsCatalogPath),
      this.seasons,
      clock,
    );
    this.rewards = new MatchRewardService(
      db,
      this.rankings,
      this.collection,
      this.progression,
      this.seasons,
      this.events,
    );
    this.operations = new OperationsService(
      db,
      this.matches,
      config,
      settings.maintenance,
      settings.maintenanceMessage,
      this.redis,
    );
    const storeCatalog = options.store ?? loadStoreCatalog(settings.storeCatalogPath);
    validateStoreCatalog(storeCatalog);
    this.store = new StoreService(
      db,
      new StoreRepository(db),
      this.collection,
      collectionRecords,
      new StoreReceiptValidator(
        options.storeVerifiers ?? createStoreVerifiers(settings),
        settings.iapDemoPurchases ?? false,
      ),
      storeCatalog,
      clock,
    );
    this.accountDeletion = new AccountDeletionService(
      db,
      new AccountDeletionRepository(db),
      this.matches,
      this.squads,
      this.presence,
    );
    this.contentGuard = new ContentGuard(db, collectionRecords, this.seasons, this.events);
    this.gameConfig = new GameConfigService({
      directory: options.gameConfigDirectory ?? gameConfigDirectory,
      guard: this.contentGuard,
      seasons: this.seasons,
      bundleInUse: !!settings.contentBundlePath,
    });

    this.adminGuard = createAdminGuard({
      key: settings.adminKey,
      allowedIps: settings.adminAllowedIps,
      maxFailures: settings.adminMaxFailures,
      lockoutSeconds: settings.adminLockoutSeconds,
    });
    this.audit = new AdminAudit(new AdminAuditRepository(db), clock);
    this.adminPlayers = new AdminPlayersService({
      db,
      records: new AdminPlayersRepository(db),
      accounts: this.accounts,
      collection: this.collection,
      collectionRecords,
      seasons: this.seasons,
      presence: this.presence,
      matches: this.matches,
      squads: this.squads,
      audit: this.audit,
      clock,
    });
    this.adminInsights = new AdminInsightsService({
      db,
      records: new AdminInsightsRepository(db),
      content: this.content,
      matchmaking: this.matchmaking,
      seasons: this.seasons,
      events: this.events,
      rankings: this.rankings,
      operations: this.operations,
      matches: this.matches,
      squads: this.squads,
      presence: this.presence,
      clock,
    });
    this.adminLive = new AdminLiveService({
      operations: this.operations,
      matches: this.matches,
      squads: this.squads,
      matchmaking: this.matchmaking,
      chatLog: this.chatLog,
      moderation: this.moderation,
      audit: this.audit,
    });
  }

  /** What every match room uses. */
  matchServices(): MatchServices {
    return {
      config: this.content.config,
      accounts: this.accounts,
      social: this.social,
      presence: this.presence,
      collection: this.collection,
      rewards: this.rewards,
      operations: this.operations,
      registry: this.matches,
      matchmaking: this.matchmaking,
      events: this.events,
      redis: this.redis,
      moderation: this.moderation,
      chatLog: this.chatLog,
    };
  }

  /** What every matchmaking queue room uses. */
  matchmakingServices(): MatchmakingServices {
    return {
      config: this.content.config,
      accounts: this.accounts,
      operations: this.operations,
      registry: this.matches,
      matchmaking: this.matchmaking,
      events: this.events,
      squads: this.squads,
    };
  }

  /** What every squad (party) room uses. */
  squadServices(): SquadServices {
    return {
      config: this.content.config,
      accounts: this.accounts,
      social: this.social,
      presence: this.presence,
      collection: this.collection,
      operations: this.operations,
      matches: this.matches,
      squads: this.squads,
      matchmaking: this.matchmaking,
      events: this.events,
      searchSeconds: this.squadSearchSeconds,
    };
  }

  /**
   * Opens MySQL (applying migrations) and Redis, freezes the running season's policy and checks the content against
   * what players already own. Any failure closes what was opened and aborts the start.
   */
  async start(): Promise<void> {
    await this.database.open();
    try {
      await this.redis?.connect();
      if (this.store.demo)
        console.warn("[store] Demo purchases are ON: packs are granted without payment. Turn them off for release.");
      await this.seasons.ensureCurrent();
      await this.contentGuard.validateInventory(this.content.characterCatalog);
      await this.contentGuard.checkIdentities(this.content.characterCatalog, this.content.goalCatalog, true);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.redis?.close().catch(() => {});
    await this.database.close();
  }
}
