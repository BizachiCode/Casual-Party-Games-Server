import assert from "node:assert/strict";
import { Decoder, Encoder } from "@colyseus/schema";
import { PartySimulation } from "../../src/modules/match/simulation/party-simulation.js";
import { MatchWire, updateWire, wireSnapshot } from "../../src/modules/match/wire/match-wire.js";
import { config } from "../support/server.js";

function compare(expected: unknown, actual: unknown, path = ""): void {
  if (typeof expected === "number")
    assert.ok(Math.abs(expected - (actual as number)) <= 0.00051, path + ":" + expected + "/" + actual);
  else if (Array.isArray(expected)) {
    assert.equal(expected.length, (actual as unknown[]).length, path);
    expected.forEach((value, i) => compare(value, (actual as unknown[])[i], path + "." + i));
  } else if (expected && typeof expected === "object") {
    assert.deepEqual(Object.keys(expected).sort(), Object.keys(actual as object).sort(), path);
    for (const key of Object.keys(expected))
      compare((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], path + "." + key);
  } else assert.equal(expected, actual, path);
}

describe("match wire", () => {
  it("reproduces every snapshot field through native Schema full state and deltas", () => {
    const sim = new PartySimulation(config, 32, { mode: "race", courseId: "boxing-boulevard" });
    sim.addPlayer("p", "Schema 🏆");
    sim.ready("p");
    const state = new MatchWire();
    const remote = new MatchWire();
    const encoder = new Encoder(state);
    const decoder = new Decoder(remote);
    let binary = 0;
    let json = 0;
    for (let tick = 0; tick < 900; tick++) {
      sim.input("p", { seq: tick, x: Math.sin(tick * 0.03), z: 1, jump: tick % 40 === 0, dive: tick % 90 === 0 });
      sim.step();
      if (tick % 2) continue;
      const authority = sim.snapshot();
      updateWire(state, authority);
      const bytes = tick === 0 ? encoder.encodeAll() : encoder.encode();
      decoder.decode(bytes);
      encoder.discardChanges();
      compare(authority, wireSnapshot(remote));
      binary += bytes.length;
      json += Buffer.byteLength(JSON.stringify(authority));
    }
    assert.ok(binary < json * 0.4, `Schema bytes ${binary} / JSON ${json}`);
    sim.removePlayer("p");
    updateWire(state, sim.snapshot());
    decoder.decode(encoder.encode());
    assert.equal(
      wireSnapshot(remote).players.some((player: { id: string }) => player.id === "p"),
      false,
    );
  });
});
