// Fills public party rooms with simulated players that ready up and run, jump and dive like a client at 30 Hz.
// npm run loadtest -- --endpoint ws://localhost:2567 --numClients 32
import { Client, type Room } from "@colyseus/sdk";
import { cli, type Options } from "@colyseus/loadtest";
import { loadContent } from "../src/modules/content/active-content.js";

const { config } = loadContent();

export async function main(options: Options) {
  const room: Room = await new Client(options.endpoint).joinOrCreate(options.roomName, {
    protocol: config.protocol,
    revision: config.revision,
    name: "Load " + options.clientId,
  });
  room.onMessage("*", () => {});
  room.onStateChange(() => {});
  room.send("sync");
  room.send("ready");
  let seq = 0;
  const timer = setInterval(() => {
    const t = seq / config.tickRate;
    room.send("input", { seq: seq++, x: Math.sin(t), z: 1, jump: seq % 45 === 0, dive: seq % 97 === 0 });
  }, 1000 / config.tickRate);
  room.onLeave(() => clearInterval(timer));
}

cli(main);
