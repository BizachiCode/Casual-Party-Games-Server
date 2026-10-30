import type { Request, RequestHandler } from "express";
import { z } from "zod";
import { normalizeAddress } from "../../shared/admin-guard.js";
import { cleanText } from "../../shared/text.js";
import type { AuditActor } from "./admin-audit.service.js";

/** The console sends its operator name in this header; it labels the audit log and is not a credential. */
export const OPERATOR_HEADER = "x-gm-operator";

/** The operator name (1 to 32 characters, "gm" when absent) and address of an admin request. */
export function actorOf(req: Request): AuditActor {
  const name = cleanText(String(req.get(OPERATOR_HEADER) || ""))
    .trim()
    .slice(0, 32);
  return { operator: name || "gm", address: normalizeAddress(req.ip || req.socket.remoteAddress) };
}

/**
 * Wraps an admin handler: answers its result as JSON. A payload that fails its schema becomes a 400 with the schema's
 * messages; ApiErrors keep their status (the shared error handler).
 */
export function adminRoute(handler: (req: Request) => Promise<object>): RequestHandler {
  return async (req, res) => {
    try {
      res.json(await handler(req));
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues.map(issue => issue.message).join(" ") });
        return;
      }
      throw error;
    }
  };
}

/** A request id the console generates per action, so a retried grant is applied once. */
export const requestIdSchema = z
  .string({ error: "A request id is required." })
  .regex(/^[A-Za-z0-9_-]{8,64}$/, "The request id must have 8 to 64 letters, digits, '-' or '_'.");

/** Page and page size of a list (`page` from 1, `pageSize` 10 to 200, 50 by default). */
export function pageOf(query: Request["query"]): { page: number; pageSize: number } {
  const page = Number(query.page);
  const pageSize = Number(query.pageSize);
  return {
    page: Number.isInteger(page) && page >= 1 && page <= 100000 ? page : 1,
    pageSize: Number.isInteger(pageSize) && pageSize >= 10 && pageSize <= 200 ? pageSize : 50,
  };
}

/** A query-string value as text (the first one when repeated), or "". */
export function queryText(value: unknown, maxLength = 120): string {
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === "string" ? text.trim().slice(0, maxLength) : "";
}
