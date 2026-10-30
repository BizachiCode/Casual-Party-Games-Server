import { setTimeout as delay } from "node:timers/promises";
import { ServerError } from "colyseus";
import type { Database } from "../../infrastructure/database/database.js";
import type { RedisCoordination } from "../../infrastructure/redis/coordination.js";
import type { PartyConfig } from "../content/content.types.js";
import type { MatchRegistry } from "../match/match-registry.js";

const ACTIVE_PHASES = ["countdown", "running", "results"];

/**
 * Live operations: maintenance mode, draining before a restart, readiness for load balancers and service metrics.
 * New matches are refused (503) while in maintenance, draining, or when MySQL or Redis are unavailable.
 */
export class OperationsService {
  private draining = false;
  private shutdown?: Promise<void>;
  private readonly started = performance.now();

  constructor(
    private readonly db: Database,
    private readonly matches: MatchRegistry,
    private readonly config: PartyConfig,
    private maintenance: boolean,
    private message: string,
    private readonly redis?: RedisCoordination,
  ) {
    if (typeof maintenance !== "boolean" || typeof message !== "string" || message.length > 180)
      throw new Error("Invalid launch settings.");
  }

  get admissionsOpen(): boolean {
    return !this.maintenance && !this.draining;
  }

  ready(): boolean {
    try {
      return this.db.healthy && (!this.redis || this.redis.healthy) && this.admissionsOpen;
    } catch {
      return false;
    }
  }

  requireAdmission(): void {
    if (!this.ready()) throw new ServerError(503, this.message || "Server temporarily unavailable for new matches.");
  }

  setMaintenance(enabled: unknown, message: unknown = ""): void {
    if (typeof enabled !== "boolean" || typeof message !== "string" || message.length > 180)
      throw new Error("Boolean maintenance and message up to 180 characters required.");
    this.maintenance = enabled;
    this.message = message;
  }

  beginDrain(message = "Server restarting. Finishing active matches."): void {
    this.draining = true;
    this.message = message.slice(0, 180);
  }

  status() {
    return {
      admissionsOpen: this.ready(),
      maintenance: this.maintenance,
      draining: this.draining,
      message: this.message,
      serverTime: new Date().toISOString(),
      protocol: this.config.protocol,
      revision: this.config.revision,
    };
  }

  metrics() {
    const rooms = this.matches.all();
    return {
      ...this.status(),
      uptimeSeconds: Math.floor((performance.now() - this.started) / 1000),
      rooms: rooms.length,
      connectedClients: rooms.reduce((sum, room) => sum + room.clients.length, 0),
      reservedSeats: rooms.reduce((sum, room) => sum + room.suspended.size, 0),
      runningMatches: rooms.filter(room => ACTIVE_PHASES.includes(room.simulation.phase)).length,
      residentBytes: process.memoryUsage().rss,
    };
  }

  /**
   * Stops admissions, closes waiting lobbies and lets running matches finish for up to `seconds`. Colyseus then
   * disposes the remaining rooms.
   */
  drain(seconds: number): Promise<void> {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 300)
      throw new Error("Drain deadline must be an integer from 0 to 300 seconds.");
    if (this.shutdown) return this.shutdown;
    this.beginDrain();
    this.shutdown = (async () => {
      for (const room of this.matches.all()) {
        room.broadcast("notice", this.message);
        if (room.simulation.phase === "lobby") await room.disconnect(4000);
      }
      const deadline = performance.now() + seconds * 1000;
      while (
        performance.now() < deadline &&
        this.matches.all().some(room => room.humanCount > 0 && ACTIVE_PHASES.includes(room.simulation.phase))
      )
        await delay(100);
    })();
    return this.shutdown;
  }
}
