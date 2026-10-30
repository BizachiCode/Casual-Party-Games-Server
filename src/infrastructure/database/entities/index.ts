// Every table, in the order the backup tool writes and restores them.
import { User, Session, DeviceLogin } from "./account.entities.js";
import { FriendRequest, Friendship, Block, LobbyInvite } from "./social.entities.js";
import { Wallet, OwnedCharacter, GachaReceipt, CreditLedgerEntry } from "./collection.entities.js";
import { MatchResult, MatchReceipt, Ranking, TimeTrialRecord } from "./match.entities.js";
import { DailyProgress, ProgressionReceipt, GoalClaim } from "./progression.entities.js";
import {
  SeasonDefinition,
  SeasonProgress,
  SeasonDaily,
  SeasonReceipt,
  SeasonClaim,
  SeasonPremium,
} from "./season.entities.js";
import { EventProgress, EventReceipt, EventClaim } from "./events.entities.js";
import { ContentIdentity } from "./content.entities.js";
import { Ban, Mute, PlayerReport, GmAction } from "./moderation.entities.js";
import { IapTransaction } from "./store.entities.js";

export * from "./account.entities.js";
export * from "./social.entities.js";
export * from "./collection.entities.js";
export * from "./match.entities.js";
export * from "./progression.entities.js";
export * from "./season.entities.js";
export * from "./events.entities.js";
export * from "./content.entities.js";
export * from "./moderation.entities.js";
export * from "./store.entities.js";

export const entities = [
  User,
  Session,
  DeviceLogin,
  FriendRequest,
  Friendship,
  Block,
  LobbyInvite,
  MatchResult,
  TimeTrialRecord,
  Wallet,
  OwnedCharacter,
  GachaReceipt,
  CreditLedgerEntry,
  MatchReceipt,
  Ranking,
  DailyProgress,
  ProgressionReceipt,
  GoalClaim,
  SeasonDefinition,
  SeasonProgress,
  SeasonDaily,
  SeasonReceipt,
  SeasonClaim,
  SeasonPremium,
  EventProgress,
  EventReceipt,
  EventClaim,
  ContentIdentity,
  Ban,
  Mute,
  PlayerReport,
  GmAction,
  IapTransaction,
];
