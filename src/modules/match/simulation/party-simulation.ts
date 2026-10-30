import type { CourseDefinition, PartyConfig, SkillDefinition } from "../../content/content.types.js";
import { cleanText } from "../../../shared/text.js";
import { animate } from "./animation-state.js";
import { type BotWorld, equipBot, nextSeed, resetBrain, scramble, steerBot } from "./bots.js";
import {
  isSurvival,
  lobbyRules,
  matchRules,
  platformPosition,
  platformTop,
  type LobbyRules,
  type MatchOptions,
  type MatchRules,
} from "./course-rules.js";
import { move } from "./motor.js";
import type { Runner } from "./runner.js";
import { SKILL_READY, cancelSkill, findAction, findSkill, resolveActions } from "./skills/index.js";
import { planarLength } from "./planar-length.js";

export type MatchPhase = "lobby" | "countdown" | "running" | "results" | "finished";

export interface PlayerInput {
  seq: number;
  x: number;
  z: number;
  jump: boolean;
  dive: boolean;
  /** The action button; optional so older inputs still parse. */
  action?: boolean;
}

const EMOTES: readonly string[] = ["wave", "happy", "wow", "gg"];
/** A tolerance for the timers that count down in floating point. */
const DONE = 0.00001;

/**
 * Headless match authority: lobby, rounds, bots, movement and results at a fixed tick. It never consumes client
 * positions, impulses, timers or results. The Unity offline backend runs the same rules
 * (Core/Simulation/PartySimulation.cs) and test:parity compares both tick by tick.
 */
export class PartySimulation {
  readonly rules: MatchRules;
  readonly lobby: LobbyRules;
  readonly matchSize: number;
  /** The dive button's skill and the action button's (absent when the catalog has none). */
  readonly skill: SkillDefinition;
  readonly action: SkillDefinition | undefined;
  players: Runner[] = [];
  tick = 0;
  round = 0;
  phase: MatchPhase = "lobby";
  remaining = 0;
  elapsed = 0;
  qualifySlots = 0;
  qualifyTeams = 0;
  finishOrder: string[] = [];
  winnerId = "";
  winnerIds: string[] = [];
  winnerName = "";
  winnerTeam = 0;
  hostId = "";
  /** Per platform: -1 while intact, otherwise the match time it disappears (vanishing tiles). */
  collapses: number[] = [];
  /** Per pickup: the match time it is collectable again. */
  pickups: number[] = [];
  /** The match's random stream: bot arrivals and each bot's own seed. */
  private seed: number;
  /** Seconds the lobby has been open with enough humans, and when the next bot joins. */
  private botClock = 0;
  private nextBotAt: number;
  private botsAdded = 0;

  constructor(
    readonly config: PartyConfig,
    matchSize = config.matchSize,
    options: MatchOptions = {},
  ) {
    this.rules = matchRules(config, options);
    this.lobby = lobbyRules(options);
    this.matchSize = this.rules.mode === "timeTrial" ? 1 : Math.max(1, Math.min(config.maxPlayers, matchSize));
    this.remaining = this.lobby.lobbySeconds;
    this.skill = findSkill(config.skills, config.skill);
    this.action = findAction(config.skills, config.action);
    this.seed = scramble(((options.seed || 1) >>> 0) ^ 0x9e3779b9);
    this.nextBotAt = config.bots.joinDelay;
  }

  get course(): CourseDefinition {
    return this.config.courses[this.rules.indices[this.round]];
  }

  // ---- Lobby ----------------------------------------------------------------------------------------------------

  addPlayer(id: string, name: string, bot = false): boolean {
    if (this.phase !== "lobby" || this.players.some(runner => runner.id === id)) return false;
    // A human always takes the seat of the bot that joined last.
    if (!bot && this.players.length >= this.matchSize) {
      const seat = this.players.filter(runner => runner.bot).pop();
      if (seat) this.removePlayer(seat.id);
    }
    if (this.players.length >= this.config.maxPlayers) return false;
    if (!this.hostId && !bot) this.hostId = id;
    this.players.push({
      id,
      name: cleanText(String(name || "Runner")).slice(0, 20),
      bot,
      ready: bot,
      status: "racing",
      team: 0,
      color: 0,
      characterId: "rookie",
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      grounded: true,
      groundIndex: -1,
      checkpoint: 0,
      facingX: 0,
      facingZ: 1,
      seq: -1,
      inputTick: -100,
      inputX: 0,
      inputZ: 0,
      jump: false,
      dive: false,
      jumped: false,
      action: false,
      acted: false,
      dived: false,
      skillPhase: SKILL_READY,
      skillUntil: 0,
      skillUsed: false,
      dashing: false,
      hitUntil: 0,
      knockedDown: false,
      impactX: 0,
      impactY: 0,
      impactZ: 0,
      landSpeed: 0,
      boostUntil: 0,
      boostFactor: 1,
      slimeFactor: 1,
      windX: 0,
      windZ: 0,
      inWind: false,
      fieldContacts: [],
      jumpTick: 0,
      diveTick: 0,
      hitTick: 0,
      landTick: 0,
      respawnTick: 0,
      emoteTick: 0,
      launchTick: 0,
      boostTick: 0,
      actionTick: 0,
      score: 0,
      totalScore: 0,
      finishTime: -1,
      deaths: 0,
      emote: "",
      emoteUntil: 0,
    });
    if (bot) {
      this.seed = nextSeed(this.seed);
      equipBot(this.players[this.players.length - 1], this.config.bots, this.seed);
    }
    return true;
  }

  /** Seats one more bot when the lobby rules leave a seat for it (`asked`: the host asked for bots, see hostStart). */
  private addBot(asked = false): boolean {
    const bots = this.players.filter(runner => runner.bot).length;
    const limit = this.lobby.maxBots < 0 ? this.matchSize : this.lobby.maxBots;
    if ((!this.lobby.fillBots && !asked) || this.players.length >= this.matchSize || bots >= limit) return false;
    this.botsAdded++;
    return this.addPlayer(`bot-${this.botsAdded}`, `Bot ${this.botsAdded}`, true);
  }

  /** The match's next number in [0, 1). */
  private random(): number {
    this.seed = nextSeed(this.seed);
    return this.seed / 4294967296;
  }

  removePlayer(id: string): void {
    this.players = this.players.filter(runner => runner.id !== id);
    this.finishOrder = this.finishOrder.filter(finisher => finisher !== id);
    if (this.hostId === id) this.hostId = this.players.find(runner => !runner.bot)?.id || "";
  }

  ready(id: string, value = true): void {
    const runner = this.player(id);
    if (runner && this.phase === "lobby") runner.ready = value;
  }

  selectTeam(id: string, team: number): boolean {
    const runner = this.player(id);
    const teamCount = Math.ceil(this.matchSize / this.rules.teamSize);
    if (this.phase !== "lobby" || !runner || this.rules.teamSize <= 1) return false;
    if (!Number.isInteger(team) || team < 1 || team > teamCount) return false;
    const teammates = this.players.filter(other => other.id !== id && other.team === team).length;
    if (teammates >= this.rules.teamSize) return false;
    runner.team = team;
    return true;
  }

  emote(id: string, value: unknown): boolean {
    const runner = this.player(id);
    if (!runner || typeof value !== "string" || !EMOTES.includes(value) || runner.emoteUntil > this.tick) return false;
    runner.emote = value;
    runner.emoteTick = this.tick;
    runner.emoteUntil = this.tick + this.config.tickRate * 2;
    return true;
  }

  // ---- Input ----------------------------------------------------------------------------------------------------

  /** Accepts one input message: a newer sequence, a stick inside the unit circle and three buttons. Nothing else. */
  input(id: string, data: PlayerInput): boolean {
    const runner = this.player(id);
    if (!runner || this.phase !== "running" || runner.status !== "racing" || !data) return false;
    if (!Number.isSafeInteger(data.seq) || data.seq < 0 || data.seq > 2147483647 || data.seq <= runner.seq)
      return false;
    if (
      typeof data.x !== "number" ||
      typeof data.z !== "number" ||
      !Number.isFinite(data.x) ||
      !Number.isFinite(data.z)
    ) {
      return false;
    }
    if (typeof data.jump !== "boolean" || typeof data.dive !== "boolean") return false;
    if (data.action !== undefined && typeof data.action !== "boolean") return false;
    let stickX = Math.max(-1, Math.min(1, data.x));
    let stickZ = Math.max(-1, Math.min(1, data.z));
    const length = planarLength(stickX, stickZ);
    if (length > 1) {
      stickX /= length;
      stickZ /= length;
    }
    runner.seq = data.seq;
    runner.inputX = stickX;
    runner.inputZ = stickZ;
    runner.inputTick = this.tick;
    // Latch rising edges until a simulation tick consumes them.
    runner.jump ||= data.jump && !runner.jumped;
    runner.dive ||= data.dive && !runner.dived;
    runner.action ||= !!data.action && !runner.acted;
    runner.jumped = data.jump;
    runner.dived = data.dive;
    runner.acted = !!data.action;
    return true;
  }

  /** Drops held buttons and the stick, e.g. when the connection drops. */
  releaseInput(id: string): void {
    const runner = this.player(id);
    if (!runner) return;
    clearInput(runner);
    runner.inputTick = -100;
  }

  // ---- Ticks ----------------------------------------------------------------------------------------------------

  step(): void {
    this.stepCore();
    for (const runner of this.players) {
      animate(runner, this.tick, this.config.tickRate, this.phase, this.winnerIds, this.round);
    }
  }

  private stepCore(): void {
    const dt = 1 / this.config.tickRate;
    this.tick++;
    if (this.phase === "lobby") {
      this.stepLobby(dt);
      return;
    }
    if (this.phase === "finished") return;
    this.remaining = Math.max(0, this.remaining - dt);
    if (this.phase === "countdown") {
      if (this.remaining <= DONE) {
        this.phase = "running";
        this.remaining = this.roundSeconds();
      }
      return;
    }
    if (this.phase === "results") {
      if (this.remaining <= DONE) {
        this.round++;
        this.startRound();
      }
      return;
    }
    this.elapsed += dt;
    const skillWorld = {
      tick: this.tick,
      tickRate: this.config.tickRate,
      elapsed: this.elapsed,
      teamSize: this.rules.teamSize,
    };
    const botWorld: BotWorld = {
      ...skillWorld,
      course: this.course,
      dt,
      collapses: this.collapses,
      pickups: this.pickups,
      runners: this.players,
      action: this.action,
    };
    for (const runner of this.players) {
      if (runner.status !== "racing") continue;
      if (runner.brain) {
        steerBot(runner, botWorld);
        runner.inputTick = this.tick;
      }
      // Input older than 0.3 s has expired: the runner stops instead of running on a stale stick.
      if (this.tick - runner.inputTick > this.config.tickRate * 0.3) {
        runner.inputX = 0;
        runner.inputZ = 0;
        runner.jump = false;
        runner.dive = false;
        runner.action = false;
      }
      const world = {
        config: this.config,
        course: this.course,
        skill: this.skill,
        action: this.action,
        collapses: this.collapses,
        elapsed: this.elapsed,
        tick: this.tick,
        dt,
      };
      if (move(runner, world)) this.fall(runner);
      if (runner.status !== "racing") continue;
      this.score(runner, dt);
    }
    // Action skills reach other runners once everyone has moved, so runner order cannot favour anyone.
    resolveActions(this.players, this.action, skillWorld);
    this.checkRoundEnd();
  }

  private roundSeconds(): number {
    if (this.course.kind === "race") return this.config.raceSeconds;
    return isSurvival(this.course) ? this.config.survivalSeconds : this.config.scoreSeconds;
  }

  /** Out of the course: eliminated in survival rounds, otherwise back to the last checkpoint. */
  private fall(runner: Runner): void {
    runner.deaths++;
    if (isSurvival(this.course)) {
      runner.status = "eliminated";
      runner.score = this.elapsed;
    } else {
      this.respawn(runner);
    }
  }

  private score(runner: Runner, dt: number): void {
    const course = this.course;
    if (course.kind === "race" && runner.y > -0.1 && runner.grounded) {
      for (const checkpoint of course.checkpoints) {
        if (runner.z >= checkpoint && checkpoint > runner.checkpoint) runner.checkpoint = checkpoint;
      }
      if (runner.z >= course.finish) {
        runner.status = "qualified";
        runner.finishTime = this.elapsed;
        runner.score = this.players.length - this.finishOrder.length;
        this.finishOrder.push(runner.id);
      }
    }
    if (course.kind === "collect") {
      (course.pickups || []).forEach((coin, index) => {
        const reached =
          planarLength(runner.x - coin.x, runner.z - coin.z) < 1 && Math.abs(runner.y + 0.9 - coin.y) < 1.5;
        if (this.elapsed >= this.pickups[index] && reached) {
          runner.score += coin.value;
          this.pickups[index] = this.elapsed + coin.respawnSeconds;
        }
      });
      if (runner.score >= course.targetScore) {
        runner.status = "qualified";
        this.finishOrder.push(runner.id);
      }
    }
    if (course.kind === "hill" && runner.grounded && planarLength(runner.x, runner.z) < course.hillRadius)
      runner.score += dt;
  }

  private checkRoundEnd(): void {
    const racing = this.players.filter(runner => runner.status === "racing");
    const byScore = (first: Runner, second: Runner) =>
      second.score - first.score || this.players.indexOf(first) - this.players.indexOf(second);
    if (isSurvival(this.course)) {
      if (this.remaining <= DONE || racing.length <= 1) {
        for (const runner of racing) {
          runner.status = "qualified";
          runner.score = this.elapsed;
          this.finishOrder.push(runner.id);
        }
        this.endRound();
      }
    } else if (this.course.kind === "hill" && this.remaining <= DONE) {
      this.finishOrder = racing
        .slice()
        .sort(byScore)
        .map(runner => runner.id);
      this.endRound();
    } else if (
      (this.rules.teamSize === 1 && this.finishOrder.length >= this.qualifySlots) ||
      !racing.length ||
      this.remaining <= DONE
    ) {
      if (this.course.kind === "collect") {
        const standing = this.players.filter(runner => runner.status !== "eliminated");
        this.finishOrder = standing
          .slice()
          .sort(byScore)
          .map(runner => runner.id);
      }
      this.endRound();
    }
  }

  // ---- Rounds ---------------------------------------------------------------------------------------------------

  private startRound(): void {
    this.elapsed = 0;
    this.finishOrder = [];
    this.collapses = this.course.platforms.map(() => -1);
    this.pickups = (this.course.pickups || []).map(() => 0);
    for (const runner of this.players) runner.score = 0;
    const active = this.players.filter(runner => runner.status !== "eliminated");
    const finalRound = this.round === this.rules.indices.length - 1;
    if (finalRound) this.qualifySlots = 1;
    else this.qualifySlots = isSurvival(this.course) ? active.length : Math.max(1, Math.ceil(active.length * 0.65));
    active.forEach((runner, index) => {
      runner.status = "racing";
      runner.checkpoint = 0;
      if (this.round === 0 && runner.team === 0) {
        let team = 1;
        while (active.filter(member => member.team === team).length >= this.rules.teamSize) team++;
        runner.team = team;
      }
      runner.score = 0;
      runner.finishTime = -1;
      this.respawn(runner, index);
      clearInput(runner);
      runner.inputTick = -100;
    });
    const teams = new Set(active.map(runner => runner.team)).size;
    this.qualifyTeams = finalRound ? 1 : Math.max(1, Math.ceil(teams / 2));
    this.phase = "countdown";
    // The map carousel (roundDraw.revealSeconds) plays before the countdown proper.
    this.remaining = this.config.countdownSeconds + this.config.roundDraw.revealSeconds;
  }

  /**
   * The lobby rules: with enough humans in, the match starts when everyone is ready, when the lobby timer runs out or
   * when the seats are full, whichever the rules allow first. Below the minimum the timer waits at its full length.
   * Meanwhile bots take the empty seats one by one (config.bots); the seats still empty at the start fill at once.
   */
  private stepLobby(dt: number): void {
    const humans = this.players.filter(runner => !runner.bot);
    if (!humans.length || humans.length < this.lobby.minPlayers) {
      this.remaining = this.lobby.lobbySeconds;
      this.botClock = 0;
      this.nextBotAt = this.config.bots.joinDelay;
      return;
    }
    this.botClock += dt;
    if (this.lobby.fillBots && this.botClock >= this.nextBotAt - DONE) {
      this.addBot();
      const { joinIntervalMin, joinIntervalMax } = this.config.bots;
      this.nextBotAt = this.botClock + joinIntervalMin + this.random() * (joinIntervalMax - joinIntervalMin);
    }
    if (this.lobby.lobbySeconds > 0) this.remaining = Math.max(0, this.remaining - dt);
    const start =
      (this.lobby.readyCheck && humans.every(runner => runner.ready)) ||
      (this.lobby.lobbySeconds > 0 && this.remaining <= DONE) ||
      (this.lobby.startWhenFull && humans.length >= this.matchSize);
    if (!start) return;
    while (this.addBot());
    this.startRound();
  }

  /**
   * The host starts the lobby now, when the rules allow it (created rooms): with `fillBots` the empty seats take bots
   * up to the bot limit, otherwise the match starts with whoever is in. False when nothing started.
   */
  hostStart(id: string, fillBots: boolean): boolean {
    if (this.phase !== "lobby" || !this.lobby.hostStart || !id || id !== this.hostId) return false;
    if (fillBots) while (this.addBot(true));
    this.startRound();
    return true;
  }

  /** Puts the runner back on its last checkpoint (races) or its start spot, clearing motion, skill and buffs. */
  respawn(runner: Runner, index = this.players.indexOf(runner)): void {
    const spawn = this.config.spawn;
    if (this.course.kind !== "race") {
      const row = Math.floor(index / spawn.arenaPerRow);
      runner.x = ((index % spawn.arenaPerRow) - (spawn.arenaPerRow - 1) / 2) * spawn.arenaGap;
      runner.z = (row - 1) * spawn.arenaGap;
    } else if (runner.checkpoint === 0) {
      // The start line has room behind it (courses keep floor there); staggered rows keep runners apart.
      const row = Math.floor(index / spawn.startPerRow);
      const stagger = row % 2 === 0 ? -spawn.startStagger : spawn.startStagger;
      runner.x = ((index % spawn.startPerRow) - (spawn.startPerRow - 1) / 2) * spawn.startColumnGap + stagger;
      runner.z = 0 - row * spawn.startRowGap;
    } else {
      const row = Math.floor(index / spawn.checkpointPerRow);
      runner.x = ((index % spawn.checkpointPerRow) - (spawn.checkpointPerRow - 1) / 2) * spawn.checkpointColumnGap;
      runner.z = runner.checkpoint - row * spawn.checkpointRowGap;
    }
    runner.y = this.groundHeight(runner.x, runner.z);
    runner.vx = 0;
    runner.vy = 0;
    runner.vz = 0;
    runner.grounded = true;
    runner.dashing = false;
    runner.hitUntil = 0;
    runner.facingX = 0;
    runner.facingZ = 1;
    cancelSkill(runner);
    runner.skillUsed = false;
    runner.groundIndex = -1;
    runner.knockedDown = false;
    runner.respawnTick = this.tick;
    runner.boostUntil = 0;
    runner.boostFactor = 1;
    runner.slimeFactor = 1;
    runner.windX = 0;
    runner.windZ = 0;
    runner.inWind = false;
    runner.fieldContacts = [];
    // A bot starts over from the spot: what it decided before it fell (its lane, a jump it forgot) must not repeat.
    if (runner.brain) resetBrain(runner.brain);
  }

  /** The highest platform top standing under a spot (a checkpoint may sit up a climb), or 0 over open air. */
  private groundHeight(x: number, z: number): number {
    let height: number | undefined;
    this.course.platforms.forEach((platform, index) => {
      if (this.collapses[index] >= 0 && this.elapsed >= this.collapses[index]) return;
      const center = platformPosition(platform, this.elapsed);
      if (Math.abs(x - center.x) > platform.width / 2 || Math.abs(z - center.z) > platform.depth / 2) return;
      const top = platformTop(platform, center, z);
      if (height === undefined || top > height) height = top;
    });
    return height ?? 0;
  }

  private endRound(): void {
    let qualified = new Set(this.finishOrder.slice(0, this.qualifySlots));
    const finalRound = this.round === this.rules.indices.length - 1;
    if (this.rules.teamSize > 1) {
      const teamScore = (team: number) =>
        this.players.filter(runner => runner.team === team).reduce((sum, runner) => sum + runner.score, 0);
      const scoringTeams = this.players
        .filter(runner => runner.status !== "eliminated" || runner.score > 0)
        .map(runner => runner.team);
      const teams = [...new Set(scoringTeams)].filter(
        team =>
          this.course.kind !== "race" ||
          this.players.filter(runner => runner.team === team).some(runner => runner.score > 0),
      );
      teams.sort((first, second) => teamScore(second) - teamScore(first) || first - second);
      const winners = teams.slice(0, finalRound ? 1 : Math.max(1, Math.ceil(teams.length / 2)));
      qualified = new Set(this.players.filter(runner => winners.includes(runner.team)).map(runner => runner.id));
    }
    for (const runner of this.players) {
      runner.totalScore += runner.score;
      runner.status = qualified.has(runner.id) ? "qualified" : "eliminated";
    }
    const survivors = this.players.filter(runner => qualified.has(runner.id));
    const remainingTeams = new Set(survivors.map(runner => runner.team)).size;
    if (finalRound || survivors.length <= 1 || (this.rules.teamSize > 1 && remainingTeams <= 1)) {
      this.winnerIds = survivors.map(runner => runner.id);
      this.winnerId = survivors[0]?.id || "";
      this.winnerTeam = this.rules.teamSize > 1 ? survivors[0]?.team || 0 : 0;
      this.winnerName = this.winnerTeam ? `Team ${this.winnerTeam}` : survivors[0]?.name || "";
      this.phase = "finished";
      this.remaining = 0;
    } else {
      this.phase = "results";
      this.remaining = this.config.resultSeconds;
    }
  }

  // ---- Snapshot -------------------------------------------------------------------------------------------------

  private player(id: string): Runner | undefined {
    return this.players.find(runner => runner.id === id);
  }

  /** The published state: field for field what the wire carries (Protocol/snapshot-schema.json) and C# produces. */
  snapshot() {
    return {
      protocol: this.config.protocol,
      revision: this.config.revision,
      tick: this.tick,
      phase: this.phase,
      round: this.round,
      remaining: this.remaining,
      elapsed: this.elapsed,
      courseId: this.course.id,
      qualifySlots: this.qualifySlots,
      winnerId: this.winnerId,
      winnerIds: [...this.winnerIds],
      winnerName: this.winnerName,
      winnerTeam: this.winnerTeam,
      mode: this.rules.mode,
      playlist: this.rules.playlist,
      totalRounds: this.rules.indices.length,
      hostId: this.hostId,
      capacity: this.matchSize,
      teamSize: this.rules.teamSize,
      qualifyTeams: this.qualifyTeams,
      platformActive: this.course.platforms.map(
        (_platform, index) => !(this.collapses[index] >= 0 && this.elapsed >= this.collapses[index]),
      ),
      pickupActive: (this.course.pickups || []).map((_coin, index) => this.elapsed >= (this.pickups[index] || 0)),
      players: this.players.map(runner => this.publish(runner)),
    };
  }

  private publish(runner: Runner) {
    return {
      id: runner.id,
      name: runner.name,
      bot: runner.bot,
      ready: runner.ready,
      status: runner.status,
      x: runner.x,
      y: runner.y,
      z: runner.z,
      vx: runner.vx,
      vy: runner.vy,
      vz: runner.vz,
      animationState: runner.animationState || 0,
      animationTick: runner.animationTick || 0,
      grounded: runner.grounded,
      dashing: runner.dashing,
      checkpoint: runner.checkpoint,
      seq: runner.seq,
      facingX: runner.facingX,
      facingZ: runner.facingZ,
      skillPhase: runner.skillPhase,
      skillUntil: runner.skillUntil,
      skillUsed: runner.skillUsed,
      groundIndex: runner.groundIndex,
      boostFactor: runner.boostFactor,
      fieldContacts: [...runner.fieldContacts],
      launchTick: runner.launchTick,
      boostTick: runner.boostTick,
      actionTick: runner.actionTick,
      boostRemaining: Math.max(0, runner.boostUntil - this.elapsed),
      inWind: runner.inWind,
      jumpTick: runner.jumpTick,
      diveTick: runner.diveTick,
      hitTick: runner.hitTick,
      landTick: runner.landTick,
      respawnTick: runner.respawnTick,
      emoteTick: runner.emoteTick,
      stunned: this.elapsed < runner.hitUntil,
      knockedDown: runner.knockedDown,
      stunRemaining: Math.max(0, runner.hitUntil - this.elapsed),
      impactX: runner.impactX,
      impactY: runner.impactY,
      impactZ: runner.impactZ,
      landSpeed: runner.landSpeed,
      score: runner.score,
      totalScore: runner.totalScore,
      team: runner.team,
      finishTime: runner.finishTime,
      deaths: runner.deaths,
      emote: runner.emoteUntil > this.tick ? runner.emote : "",
      color: runner.color,
      characterId: runner.characterId,
    };
  }
}

/** Stick to zero and every button released. */
function clearInput(runner: Runner): void {
  runner.inputX = 0;
  runner.inputZ = 0;
  runner.jump = false;
  runner.dive = false;
  runner.action = false;
  runner.jumped = false;
  runner.dived = false;
  runner.acted = false;
}

export type MatchSnapshot = ReturnType<PartySimulation["snapshot"]>;
export type PlayerSnapshot = MatchSnapshot["players"][number];
