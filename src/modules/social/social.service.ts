import type { Database } from "../../infrastructure/database/database.js";
import { ensure } from "../../shared/errors.js";
import { nameKey } from "../../shared/text.js";
import type { AccountService } from "../account/account.service.js";
import type { PresenceService } from "../presence/presence.service.js";
import type { SocialRepository } from "./social.repository.js";

const INVITE_MS = 120000;
const MAX_PENDING_REQUESTS = 50;

/**
 * Friends and private-lobby invitations. A block works both ways: it removes the friendship, pending requests and
 * invites, hides chat in shared matches and refuses joining the same lobby.
 */
export class SocialService {
  constructor(
    private readonly db: Database,
    private readonly social: SocialRepository,
    private readonly accounts: AccountService,
    private readonly presence: PresenceService,
  ) {}

  blocked(accountId: string, otherId: string): Promise<boolean> {
    return this.social.blocked(accountId, otherId);
  }

  /**
   * The account a player typed: the one whose current nickname (display name) it is, else the one with that username
   * (a leading "@" is ignored). A renamed player is found by the new nickname only.
   */
  private async findPlayer(typed: string): Promise<string | null> {
    const key = nameKey(typed);
    const byNickname = key ? await this.social.userIdByNameKey(key) : null;
    if (byNickname) return byNickname;
    const username = typed.trim().replace(/^@/, "").toLowerCase();
    return username ? this.social.userIdByUsername(username) : null;
  }

  async request(id: string, nickname: unknown): Promise<void> {
    ensure(typeof nickname === "string", 400, "Nickname required.");
    const target = await this.findPlayer(nickname);
    ensure(target && target !== id && !(await this.social.blocked(id, target)), 404, "Player unavailable.");
    ensure(!(await this.social.friends(id, target)), 409, "Already friends.");
    ensure(!(await this.social.requestExists(target, id)), 409, "Accept the existing incoming request.");
    ensure((await this.social.pendingRequests(id)) < MAX_PENDING_REQUESTS, 429, "Too many pending requests.");
    await this.social.addRequest(id, target);
  }

  async respond(id: string, sender: string, accept: boolean): Promise<void> {
    ensure(
      !(await this.social.blocked(id, sender)) && (await this.social.requestExists(sender, id)),
      404,
      "Request not found.",
    );
    await this.db.transaction(async () => {
      await this.social.removeRequest(sender, id);
      if (accept) await this.social.addFriendship(id, sender);
    });
  }

  async remove(id: string, other: string): Promise<void> {
    await this.social.removeFriendship(id, other);
    await this.social.removeInvitesBetween(id, other);
  }

  async block(id: string, other: string): Promise<void> {
    ensure(other !== id && (await this.accounts.profile(other)), 404, "Player unavailable.");
    await this.social.addBlock(id, other);
    await this.remove(id, other);
    await this.social.removeRequestsBetween(id, other);
  }

  async unblock(id: string, other: string): Promise<void> {
    await this.social.removeBlock(id, other);
  }

  async invite(id: string, other: string, roomId: string): Promise<void> {
    ensure(
      (await this.social.friends(id, other)) && !(await this.social.blocked(id, other)),
      403,
      "Invite accepted friends only.",
    );
    await this.social.removeInvitesBetween(id, other);
    await this.social.addInvite(id, other, roomId, Date.now() + INVITE_MS);
  }

  /** Uses up an invitation addressed to `id` and returns the lobby it points to. */
  async consumeInvite(id: string, inviteId: string): Promise<{ roomId: string }> {
    const invite = await this.social.liveInvite(inviteId, id);
    ensure(
      invite && (await this.social.friends(id, invite.sender)) && !(await this.social.blocked(id, invite.sender)),
      404,
      "Invite expired or unavailable.",
    );
    await this.social.removeInvite(inviteId);
    return { roomId: invite.roomId };
  }

  /** Everything the friends panel shows. */
  async state(id: string) {
    await this.social.removeExpiredInvites();
    const friends = await this.social.friendList(id);
    await this.presence.refresh(friends.map(friend => friend.id));
    return {
      profile: await this.accounts.profile(id),
      friends: friends.map(friend => ({ ...friend, ...this.presence.status(friend.id) })),
      incoming: await this.social.incomingRequests(id),
      outgoing: await this.social.outgoingRequests(id),
      invites: await this.social.invitesFor(id),
      blocked: await this.social.blockedList(id),
    };
  }
}
