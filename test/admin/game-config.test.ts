import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gameConfigDirectory } from "../../src/config/paths.js";
import { GAME_CONFIG_FILES } from "../../src/modules/content/game-config.service.js";
import { startServer } from "../support/server.js";

/** The files of game_config as Unity's export wrote them, by name. */
function exportedFiles(): Record<string, { [key: string]: unknown }> {
  const present = GAME_CONFIG_FILES.filter(name => existsSync(join(gameConfigDirectory, name)));
  return Object.fromEntries(
    present.map(name => [name, JSON.parse(readFileSync(join(gameConfigDirectory, name), "utf8"))]),
  );
}

describe("game config upload", () => {
  it("checks an uploaded export as a whole and writes it for the next start, only with the admin key", async () => {
    const key: string = randomUUID();
    const directory = mkdtempSync(join(tmpdir(), "party-config-"));
    const server = await startServer({ adminKey: key }, { gameConfigDirectory: directory });
    try {
      const upload = (body: unknown, adminKey = key) =>
        fetch(server.url + "/api/admin/game-config", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + adminKey },
          body: JSON.stringify(body),
        });
      const files = exportedFiles();
      assert.ok([401, 403].includes((await upload({ files }, "not-the-key")).status), "the admin key is required");
      assert.ok(!existsSync(join(directory, "party-courses.json")));

      const applied = await upload({ files });
      const answer = await applied.json();
      assert.equal(applied.status, 200, JSON.stringify(answer));
      assert.equal(answer.revision, files["party-courses.json"].revision);
      assert.equal(answer.restarting, false, "nothing restarts a process outside PM2");
      assert.deepEqual([...answer.files].sort(), Object.keys(files).sort());
      for (const name of Object.keys(files))
        assert.deepEqual(JSON.parse(readFileSync(join(directory, name), "utf8")), files[name], name);

      // One invalid file refuses the whole upload: nothing is written.
      for (const name of Object.keys(files)) rmSync(join(directory, name));
      const broken = structuredClone(files);
      (broken["party-matchmaking.json"].queues as { players: { max: number } }[])[0].players.max = 0;
      const refused = await upload({ files: broken });
      assert.equal(refused.status, 400);
      assert.match((await refused.json()).error, /players/);
      assert.ok(!existsSync(join(directory, "party-courses.json")), "an invalid matchmaking file writes no content");

      assert.equal((await upload({ files: { ...files, "other.json": {} } })).status, 400, "unknown file");
      const missing = structuredClone(files);
      delete missing["party-goals.json"];
      assert.equal((await upload({ files: missing })).status, 400, "missing required file");
      assert.equal((await upload({ nothing: true })).status, 400, "no files at all");
    } finally {
      await server.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
