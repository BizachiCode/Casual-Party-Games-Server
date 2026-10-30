import type { Database } from "../../infrastructure/database/database.js";
import { ensure } from "../../shared/errors.js";
import type { MatchRegistry } from "../match/match-registry.js";
import type { PresenceService } from "../presence/presence.service.js";
import type { SquadRegistry } from "../squad/squad-registry.js";
import type { AccountDeletionRepository } from "./account-deletion.repository.js";

/** What the player has to send to delete the account. */
export const DELETE_CONFIRMATION = "DELETE";

/**
 * In-app account deletion (stores require it). One transaction removes the account and every row that names it;
 * purchase receipts and the audit log stay (see KEPT_TABLES). Seats in matches and parties end with it.
 */
export class AccountDeletionService {
  constructor(
    private readonly db: Database,
    private readonly records: AccountDeletionRepository,
    private readonly matches: MatchRegistry,
    private readonly squads: SquadRegistry,
    private readonly presence: PresenceService,
  ) {}

  async delete(id: string, confirm: unknown): Promise<void> {
    ensure(confirm === DELETE_CONFIRMATION, 400, `Send "${DELETE_CONFIRMATION}" to confirm.`);
    // Seats go first so a match that finishes now does not settle for an account that is about to disappear.
    this.matches.revokeAccount(id);
    this.squads.revokeAccount(id);
    await this.db.transaction(async () => {
      await this.db.lockUsers([id]);
      await this.records.deleteAccount(id);
    });
    this.matches.revokeAccount(id);
    this.squads.revokeAccount(id);
    await this.presence.forget(id);
  }
}
