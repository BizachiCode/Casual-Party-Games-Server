import type {
  AccountRuleSettings,
  RegionRuleSettings,
  RuleSettings,
  SkillRuleSettings,
  Ticket,
} from "./matchmaking.types.js";

/**
 * A matchmaking rule. It may turn a ticket away when it enters the queue and decide which tickets may share a match.
 * To add one: write a class, give it a settings shape in RuleSettings and register it in RULE_FACTORIES.
 */
export interface MatchmakingRule {
  readonly name: string;
  /** Why the ticket may not search this queue, or "" to let it in. */
  admit?(ticket: Ticket): string;
  /** Whether two tickets may play together at this moment. Relaxing rules read how long the two have waited. */
  compatible?(first: Ticket, second: Ticket, now: number): boolean;
}

/** Seconds the longer-waiting of the two tickets has been in the queue. */
function waitedSeconds(first: Ticket, second: Ticket, now: number): number {
  return Math.max(0, now - Math.min(first.enqueuedAt, second.enqueuedAt)) / 1000;
}

/** Keeps players of similar skill together; the allowed gap grows while they wait. */
export class SkillRule implements MatchmakingRule {
  readonly name = "skill";
  constructor(readonly settings: SkillRuleSettings) {}

  compatible(first: Ticket, second: Ticket, now: number): boolean {
    const { range, widenPerSecond, maxRange } = this.settings;
    const allowed = Math.min(maxRange, range + widenPerSecond * waitedSeconds(first, second, now));
    return Math.abs(first.skill - second.skill) <= allowed;
  }
}

/** Keeps players of one region together until they have waited long enough. */
export class RegionRule implements MatchmakingRule {
  readonly name = "region";
  constructor(readonly settings: RegionRuleSettings) {}

  compatible(first: Ticket, second: Ticket, now: number): boolean {
    if (first.region === second.region) return true;
    return this.settings.relaxSeconds >= 0 && waitedSeconds(first, second, now) >= this.settings.relaxSeconds;
  }
}

/** Reserves a queue for signed-in players. */
export class AccountRule implements MatchmakingRule {
  readonly name = "account";
  constructor(readonly settings: AccountRuleSettings) {}

  admit(ticket: Ticket): string {
    return this.settings.required && !ticket.accountId ? "Sign in to play this mode." : "";
  }
}

const RULE_FACTORIES: { [Key in keyof RuleSettings]-?: (settings: NonNullable<RuleSettings[Key]>) => MatchmakingRule } =
  {
    skill: settings => new SkillRule(settings),
    region: settings => new RegionRule(settings),
    account: settings => new AccountRule(settings),
  };

export const RULE_NAMES = Object.keys(RULE_FACTORIES) as (keyof RuleSettings)[];

/** The settings of a rule that is switched on; a rule with `enabled: false` behaves exactly as if it were absent. */
export function activeRule<Settings extends { enabled?: boolean }>(
  settings: Settings | undefined,
): Settings | undefined {
  return settings && settings.enabled !== false ? settings : undefined;
}

/** The rules a queue lists in the catalog and has switched on, in catalog order. */
export function buildRules(settings: RuleSettings): MatchmakingRule[] {
  return (Object.keys(settings) as (keyof RuleSettings)[]).flatMap(name => {
    if (!activeRule(settings[name])) return [];
    const factory = RULE_FACTORIES[name] as (ruleSettings: unknown) => MatchmakingRule;
    return [factory(settings[name])];
  });
}

/** The skill value a player queues with, measured the way the queue's skill rule asks. */
export function skillOf(settings: RuleSettings, profile?: { level: number; wins: number }): number {
  if (activeRule(settings.skill)?.metric === "wins") return profile?.wins ?? 0;
  return profile?.level ?? 1;
}
