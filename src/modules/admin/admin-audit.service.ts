import type { AdminAuditRepository, AuditRow } from "./admin-audit.repository.js";

/** Who ran a GM action: the operator name the console sends (X-GM-Operator) and the request's address. */
export interface AuditActor {
  operator: string;
  address: string;
}

export interface AuditEntry extends Omit<AuditRow, "details"> {
  details: Record<string, unknown> | null;
}

export interface AuditListQuery {
  action?: string;
  targetId?: string;
  operator?: string;
  page: number;
  pageSize: number;
}

/**
 * The record of every GM action. Ordinary actions are written after they succeed (record). Grants are written first,
 * keyed by the console's request id, inside the grant's transaction (claim): a retried request finds the row and pays
 * nothing, and a failed grant rolls the row back with it.
 */
export class AdminAudit {
  constructor(
    private readonly records: AdminAuditRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private row(
    actor: AuditActor,
    action: string,
    targetId: string | null,
    details: object | undefined,
    requestId: string | null,
  ) {
    return {
      at: +this.clock(),
      operator: actor.operator.slice(0, 64),
      address: actor.address.slice(0, 64),
      action: action.slice(0, 64),
      targetId,
      requestId,
      details: details === undefined ? null : JSON.stringify(details),
    };
  }

  async record(actor: AuditActor, action: string, targetId: string | null, details?: object): Promise<void> {
    await this.records.insert(this.row(actor, action, targetId, details, null));
  }

  /** Writes the action under `requestId` once. False means the request already ran: do not apply it again. */
  claim(
    actor: AuditActor,
    action: string,
    targetId: string | null,
    requestId: string,
    details?: object,
  ): Promise<boolean> {
    if (!requestId || requestId.length > 100) throw new Error("A GM request id has 1 to 100 characters.");
    return this.records.insertOnce(this.row(actor, action, targetId, details, requestId));
  }

  async list(query: AuditListQuery): Promise<{ total: number; entries: AuditEntry[] }> {
    const { total, rows } = await this.records.list({
      action: query.action,
      targetId: query.targetId,
      operator: query.operator,
      offset: (query.page - 1) * query.pageSize,
      limit: query.pageSize,
    });
    return { total, entries: rows.map(row => ({ ...row, details: parseDetails(row.details) })) };
  }

  async filters(): Promise<{ actions: string[]; operators: string[] }> {
    return { actions: await this.records.actions(), operators: await this.records.operators() };
  }
}

function parseDetails(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : { value };
  } catch {
    return { text };
  }
}
