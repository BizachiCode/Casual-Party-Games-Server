// Generated from Protocol/snapshot-schema.json by Tools/generate-network-schema.py. Do not edit.
// Decimal values travel as integers in thousandths ("scaled"); the client divides them back.
import { type ArraySchema, schema, t, type SchemaType } from "@colyseus/schema";
import type { MatchSnapshot, PlayerSnapshot } from "../simulation/party-simulation.js";

export const PlayerWire = schema(
  {
    id: t.string(),
    name: t.string(),
    status: t.uint8(),
    flags: t.uint8(),
    x: t.int32(),
    y: t.int32(),
    z: t.int32(),
    vx: t.int32(),
    vy: t.int32(),
    vz: t.int32(),
    checkpoint: t.int32(),
    seq: t.int32(),
    jumpTick: t.uint32(),
    diveTick: t.uint32(),
    hitTick: t.uint32(),
    landTick: t.uint32(),
    respawnTick: t.uint32(),
    emoteTick: t.uint32(),
    launchTick: t.uint32(),
    boostTick: t.uint32(),
    boostRemaining: t.int32(),
    stunRemaining: t.int32(),
    impactX: t.int32(),
    impactY: t.int32(),
    impactZ: t.int32(),
    landSpeed: t.int32(),
    score: t.int32(),
    totalScore: t.int32(),
    finishTime: t.int32(),
    team: t.uint32(),
    deaths: t.uint32(),
    color: t.uint32(),
    emote: t.uint8(),
    characterId: t.string(),
    animationState: t.uint32(),
    animationTick: t.uint32(),
    facingX: t.int32(),
    facingZ: t.int32(),
    skillPhase: t.uint32(),
    skillUntil: t.uint32(),
    groundIndex: t.int32(),
    boostFactor: t.int32(),
    fieldContacts: t.array("boolean"),
    actionTick: t.uint32(),
  },
  "PlayerWire",
);
export type PlayerWire = SchemaType<typeof PlayerWire>;

function assignPlayerWire(target: PlayerWire, source: PlayerSnapshot): void {
  target.id = source.id || "";
  target.name = source.name || "";
  target.status = ["racing", "qualified", "eliminated"].indexOf(source.status || "");
  target.flags =
    (source.bot ? 1 : 0) |
    (source.ready ? 2 : 0) |
    (source.grounded ? 4 : 0) |
    (source.dashing ? 8 : 0) |
    (source.inWind ? 16 : 0) |
    (source.stunned ? 32 : 0) |
    (source.knockedDown ? 64 : 0) |
    (source.skillUsed ? 128 : 0);
  target.x = quantize(source.x);
  target.y = quantize(source.y);
  target.z = quantize(source.z);
  target.vx = quantize(source.vx);
  target.vy = quantize(source.vy);
  target.vz = quantize(source.vz);
  target.checkpoint = quantize(source.checkpoint);
  target.seq = source.seq || 0;
  target.jumpTick = source.jumpTick || 0;
  target.diveTick = source.diveTick || 0;
  target.hitTick = source.hitTick || 0;
  target.landTick = source.landTick || 0;
  target.respawnTick = source.respawnTick || 0;
  target.emoteTick = source.emoteTick || 0;
  target.launchTick = source.launchTick || 0;
  target.boostTick = source.boostTick || 0;
  target.boostRemaining = quantize(source.boostRemaining);
  target.stunRemaining = quantize(source.stunRemaining);
  target.impactX = quantize(source.impactX);
  target.impactY = quantize(source.impactY);
  target.impactZ = quantize(source.impactZ);
  target.landSpeed = quantize(source.landSpeed);
  target.score = quantize(source.score);
  target.totalScore = quantize(source.totalScore);
  target.finishTime = quantize(source.finishTime);
  target.team = source.team || 0;
  target.deaths = source.deaths || 0;
  target.color = source.color || 0;
  target.emote = ["", "wave", "happy", "wow", "gg"].indexOf(source.emote || "");
  target.characterId = source.characterId || "";
  target.animationState = source.animationState || 0;
  target.animationTick = source.animationTick || 0;
  target.facingX = quantize(source.facingX);
  target.facingZ = quantize(source.facingZ);
  target.skillPhase = source.skillPhase || 0;
  target.skillUntil = source.skillUntil || 0;
  target.groundIndex = source.groundIndex || 0;
  target.boostFactor = quantize(source.boostFactor);
  updateArray(target.fieldContacts, source.fieldContacts || []);
  target.actionTick = source.actionTick || 0;
}

export const MatchWire = schema(
  {
    protocol: t.uint32(),
    round: t.uint32(),
    qualifySlots: t.uint32(),
    revision: t.string(),
    phase: t.uint8(),
    courseId: t.string(),
    winnerId: t.string(),
    remaining: t.int32(),
    elapsed: t.int32(),
    mode: t.string(),
    playlist: t.string(),
    hostId: t.string(),
    winnerName: t.string(),
    winnerIds: t.array("string"),
    totalRounds: t.uint32(),
    winnerTeam: t.uint32(),
    capacity: t.uint32(),
    teamSize: t.uint32(),
    qualifyTeams: t.uint32(),
    platformActive: t.array("boolean"),
    pickupActive: t.array("boolean"),
    tick: t.uint32(),
    players: t.map(PlayerWire),
  },
  "MatchWire",
);
export type MatchWire = SchemaType<typeof MatchWire>;

function assignMatchWire(target: MatchWire, source: MatchSnapshot): void {
  target.protocol = source.protocol || 0;
  target.round = source.round || 0;
  target.qualifySlots = source.qualifySlots || 0;
  target.revision = source.revision || "";
  target.phase = ["lobby", "countdown", "running", "results", "finished"].indexOf(source.phase || "");
  target.courseId = source.courseId || "";
  target.winnerId = source.winnerId || "";
  target.remaining = quantize(source.remaining);
  target.elapsed = quantize(source.elapsed);
  target.mode = source.mode || "";
  target.playlist = source.playlist || "";
  target.hostId = source.hostId || "";
  target.winnerName = source.winnerName || "";
  updateArray(target.winnerIds, source.winnerIds || []);
  target.totalRounds = source.totalRounds || 0;
  target.winnerTeam = source.winnerTeam || 0;
  target.capacity = source.capacity || 0;
  target.teamSize = source.teamSize || 0;
  target.qualifyTeams = source.qualifyTeams || 0;
  updateArray(target.platformActive, source.platformActive || []);
  updateArray(target.pickupActive, source.pickupActive || []);
}

function updateArray<T>(target: ArraySchema<T>, values: T[]): void {
  while (target.length > values.length) target.pop();
  for (let i = 0; i < values.length; i++) {
    if (target[i] !== values[i]) target[i] = values[i];
  }
}

function quantize(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > 2147483) throw Error("Out of schema range");
  return Math.sign(value) * Math.round(Math.abs(value) * 1000);
}

/** Copies a simulation snapshot into the synchronized state; Colyseus sends only what changed. */
export function updateWire(target: MatchWire, state: MatchSnapshot): void {
  assignMatchWire(target, state);
  target.tick = state.tick;
  const ids = new Set(state.players.map(player => player.id));
  for (const id of target.players.keys()) {
    if (!ids.has(id)) target.players.delete(id);
  }
  for (const player of state.players) {
    let wire = target.players.get(player.id);
    if (!wire) {
      wire = new PlayerWire();
      target.players.set(player.id, wire);
    }
    assignPlayerWire(wire, player);
  }
}

interface WireField {
  id: number;
  name: string;
  kind: string;
  fields?: string[];
  values?: string[];
}

const descriptor: { player: WireField[]; match: WireField[] } = {
  player: [
    {
      id: 1,
      name: "id",
      kind: "string",
    },
    {
      id: 2,
      name: "name",
      kind: "string",
    },
    {
      id: 3,
      name: "status",
      kind: "enum",
      values: ["racing", "qualified", "eliminated"],
    },
    {
      id: 4,
      name: "flags",
      kind: "flags",
      fields: ["bot", "ready", "grounded", "dashing", "inWind", "stunned", "knockedDown", "skillUsed"],
    },
    {
      id: 5,
      name: "x",
      kind: "scaled",
    },
    {
      id: 6,
      name: "y",
      kind: "scaled",
    },
    {
      id: 7,
      name: "z",
      kind: "scaled",
    },
    {
      id: 8,
      name: "vx",
      kind: "scaled",
    },
    {
      id: 9,
      name: "vy",
      kind: "scaled",
    },
    {
      id: 10,
      name: "vz",
      kind: "scaled",
    },
    {
      id: 11,
      name: "checkpoint",
      kind: "scaled",
    },
    {
      id: 12,
      name: "seq",
      kind: "sint",
    },
    {
      id: 13,
      name: "jumpTick",
      kind: "uint",
    },
    {
      id: 14,
      name: "diveTick",
      kind: "uint",
    },
    {
      id: 15,
      name: "hitTick",
      kind: "uint",
    },
    {
      id: 16,
      name: "landTick",
      kind: "uint",
    },
    {
      id: 17,
      name: "respawnTick",
      kind: "uint",
    },
    {
      id: 18,
      name: "emoteTick",
      kind: "uint",
    },
    {
      id: 19,
      name: "launchTick",
      kind: "uint",
    },
    {
      id: 20,
      name: "boostTick",
      kind: "uint",
    },
    {
      id: 21,
      name: "boostRemaining",
      kind: "scaled",
    },
    {
      id: 22,
      name: "stunRemaining",
      kind: "scaled",
    },
    {
      id: 23,
      name: "impactX",
      kind: "scaled",
    },
    {
      id: 24,
      name: "impactY",
      kind: "scaled",
    },
    {
      id: 25,
      name: "impactZ",
      kind: "scaled",
    },
    {
      id: 26,
      name: "landSpeed",
      kind: "scaled",
    },
    {
      id: 27,
      name: "score",
      kind: "scaled",
    },
    {
      id: 28,
      name: "totalScore",
      kind: "scaled",
    },
    {
      id: 29,
      name: "finishTime",
      kind: "scaled",
    },
    {
      id: 30,
      name: "team",
      kind: "uint",
    },
    {
      id: 31,
      name: "deaths",
      kind: "uint",
    },
    {
      id: 32,
      name: "color",
      kind: "uint",
    },
    {
      id: 33,
      name: "emote",
      kind: "enum",
      values: ["", "wave", "happy", "wow", "gg"],
    },
    {
      id: 34,
      name: "characterId",
      kind: "string",
    },
    {
      id: 35,
      name: "animationState",
      kind: "uint",
    },
    {
      id: 36,
      name: "animationTick",
      kind: "uint",
    },
    {
      id: 37,
      name: "facingX",
      kind: "scaled",
    },
    {
      id: 38,
      name: "facingZ",
      kind: "scaled",
    },
    {
      id: 39,
      name: "skillPhase",
      kind: "uint",
    },
    {
      id: 40,
      name: "skillUntil",
      kind: "uint",
    },
    {
      id: 41,
      name: "groundIndex",
      kind: "sint",
    },
    {
      id: 42,
      name: "boostFactor",
      kind: "scaled",
    },
    {
      id: 43,
      name: "fieldContacts",
      kind: "bits",
    },
    {
      id: 44,
      name: "actionTick",
      kind: "uint",
    },
  ],
  match: [
    {
      id: 1,
      name: "protocol",
      kind: "uint",
    },
    {
      id: 2,
      name: "round",
      kind: "uint",
    },
    {
      id: 3,
      name: "qualifySlots",
      kind: "uint",
    },
    {
      id: 4,
      name: "revision",
      kind: "string",
    },
    {
      id: 5,
      name: "phase",
      kind: "enum",
      values: ["lobby", "countdown", "running", "results", "finished"],
    },
    {
      id: 6,
      name: "courseId",
      kind: "string",
    },
    {
      id: 7,
      name: "winnerId",
      kind: "string",
    },
    {
      id: 8,
      name: "remaining",
      kind: "scaled",
    },
    {
      id: 9,
      name: "elapsed",
      kind: "scaled",
    },
    {
      id: 10,
      name: "mode",
      kind: "string",
    },
    {
      id: 11,
      name: "playlist",
      kind: "string",
    },
    {
      id: 12,
      name: "hostId",
      kind: "string",
    },
    {
      id: 13,
      name: "winnerName",
      kind: "string",
    },
    {
      id: 14,
      name: "winnerIds",
      kind: "strings",
    },
    {
      id: 15,
      name: "totalRounds",
      kind: "uint",
    },
    {
      id: 16,
      name: "winnerTeam",
      kind: "uint",
    },
    {
      id: 17,
      name: "capacity",
      kind: "uint",
    },
    {
      id: 18,
      name: "teamSize",
      kind: "uint",
    },
    {
      id: 19,
      name: "qualifyTeams",
      kind: "uint",
    },
    {
      id: 20,
      name: "platformActive",
      kind: "bits",
    },
    {
      id: 21,
      name: "pickupActive",
      kind: "bits",
    },
  ],
};

function unpack(value: Record<string, unknown>, fields: WireField[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = value[field.name];
    if (field.kind === "flags")
      field.fields.forEach((name, bit) => (result[name] = ((raw as number) & (1 << bit)) !== 0));
    else if (field.kind === "scaled") result[field.name] = (raw as number) / 1000;
    else if (field.kind === "enum") result[field.name] = field.values[raw as number];
    else if (field.kind === "bits" || field.kind === "strings")
      result[field.name] = Array.from(raw as Iterable<unknown>);
    else result[field.name] = raw;
  }
  return result;
}

/** Decodes received state back into snapshot values (used by tests and tools that act as clients). */
export function wireSnapshot(state: MatchWire): MatchSnapshot {
  const match = unpack(state as unknown as Record<string, unknown>, descriptor.match);
  const players = Array.from(state.players.values()).map(player =>
    unpack(player as unknown as Record<string, unknown>, descriptor.player),
  );
  return { ...match, tick: state.tick, players } as unknown as MatchSnapshot;
}
