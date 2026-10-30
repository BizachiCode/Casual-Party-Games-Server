import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checksum, packBundle, verifyBundle, writeTransaction } from "../../src/modules/content/content-bundle.js";
import type {
  CharacterCatalog,
  ContentBundle,
  GoalCatalog,
  PartyConfig,
} from "../../src/modules/content/content.types.js";
import { serverRoot } from "../../src/config/paths.js";
import { content, startServer } from "../support/server.js";

type Sections = [PartyConfig, CharacterCatalog, GoalCatalog];
const sections = (): Sections => [
  structuredClone(content.config),
  structuredClone(content.characterCatalog),
  structuredClone(content.goalCatalog),
];
const pack = (data = sections()) =>
  packBundle(JSON.stringify(data[0]), JSON.stringify(data[1]), JSON.stringify(data[2]));
function invalid(edit: (...data: Sections) => void, pattern: RegExp) {
  const data = sections();
  edit(...data);
  assert.throws(() => pack(data), pattern);
}
/** Runs a TypeScript entry point the way `npm run` does. */
const run = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(process.execPath, ["--import", "tsx", ...args], { encoding: "utf8", cwd: serverRoot, env });

describe("content bundles", () => {
  it("round-trips deterministically and stamps all content in the revision", () => {
    const bundle = pack();
    assert.deepEqual(bundle, pack());
    const catalogs = verifyBundle(bundle);
    assert.match(catalogs.config.revision, /^party-v7-[a-f0-9]{12}$/);
    assert.equal(catalogs.config.courses.length, 31);
    assert.equal(catalogs.characterCatalog.characters.length, 14);
    assert.equal(catalogs.goalCatalog.goals.length, 16);
    assert.deepEqual(packBundle(bundle.gameplayJson, bundle.charactersJson, bundle.goalsJson), bundle);
    const changed = sections();
    changed[2].goals[0].title += " ★";
    assert.notEqual(pack(changed).checksum, bundle.checksum);
    assert.notEqual(verifyBundle(pack(changed)).config.revision, catalogs.config.revision);
  });

  it("rejects corruption, an unsupported format, oversized sections and forged revisions", () => {
    const bundle = pack();
    assert.throws(() => verifyBundle({ ...bundle, charactersJson: bundle.charactersJson + " " }), /checksum/);
    assert.throws(() => verifyBundle({ ...bundle, formatVersion: 2 } as unknown as ContentBundle), /version/);
    const forged = bundle.gameplayJson.replace(/party-v7-[a-f0-9]{12}/, "party-v7-000000000000");
    assert.throws(
      () =>
        verifyBundle({
          ...bundle,
          gameplayJson: forged,
          checksum: checksum(forged, bundle.charactersJson, bundle.goalsJson),
        }),
      /revision/,
    );
    assert.throws(() => packBundle(" ".repeat(1024 * 1024 + 1), bundle.charactersJson, bundle.goalsJson));
  });

  it("rejects a stale protocol, broken references, unsupported geometry and non-finite movement", () => {
    invalid(gameplay => {
      gameplay.protocol = 2;
    }, /protocol/);
    invalid(gameplay => {
      gameplay.playlists[0].courseIds = ["missing"];
    }, /playlist course/);
    invalid(gameplay => {
      gameplay.courses[1].id = gameplay.courses[0].id;
    }, /unique/);
    invalid(gameplay => {
      gameplay.courses[0].platforms[0].y = -1;
    }, /platform\.y/);
    invalid(gameplay => {
      gameplay.courses[0].platforms[0].depth = 4;
      gameplay.courses[0].platforms[0].rise = 10;
    }, /slope/);
    invalid(gameplay => {
      gameplay.courses[0].platforms[0].width = 0;
    }, /width/);
    invalid(gameplay => {
      gameplay.speed = NaN;
    }, /speed/);
    invalid(gameplay => {
      gameplay.courses[0].hazards[0].period = 1;
      gameplay.courses[0].hazards[0].onSeconds = 2;
    }, /onSeconds/);
    invalid(gameplay => {
      gameplay.skill = "missing";
    }, /skill/);
    invalid(gameplay => {
      gameplay.skills[0].kind = "teleport";
    }, /kind/);
    invalid(gameplay => {
      gameplay.skills[0].speed = 99;
    }, /speed/);
  });

  it("rejects empty pity pools, free draws and unsupported goal metrics", () => {
    invalid((_gameplay, catalog) => {
      catalog.banners[0].weights.pop();
    }, /four rarity/);
    invalid((_gameplay, catalog) => {
      catalog.starterId = "missing";
    }, /starterId/);
    invalid((_gameplay, catalog) => {
      catalog.banners[0].cost = 0;
    }, /cost/);
    invalid((_gameplay, catalog) => {
      catalog.characters = catalog.characters.filter(character => character.rarity !== "legendary");
    }, /empty rarity/);
    invalid((_gameplay, _catalog, goals) => {
      (goals.goals[0] as { metric: string }).metric = "clientScore";
    }, /metric/);
    invalid((_gameplay, _catalog, goals) => {
      goals.goals[0].credits = -1;
    }, /credits/);
  });

  it("validates weekly goals and the battle pass XP of a goal", () => {
    const weekly = (edit: (goal: GoalCatalog["goals"][number]) => void) => {
      const data = sections();
      edit(data[2].goals.find(goal => goal.scope === "weekly"));
      return data;
    };
    const accepted = pack(
      weekly(goal => {
        goal.metric = "teams";
        goal.passXp = 10000;
      }),
    );
    assert.equal(verifyBundle(accepted).goalCatalog.goals.filter(goal => goal.scope === "weekly").length, 3);
    // A goal without passXp counts as 0.
    pack(
      weekly(goal => {
        delete goal.passXp;
      }),
    );
    invalid((_gameplay, _catalog, goals) => {
      goals.goals.find(goal => goal.scope === "weekly").metric = "level";
    }, /metric/);
    invalid((_gameplay, _catalog, goals) => {
      goals.goals.find(goal => goal.scope === "weekly").metric = "collection";
    }, /metric/);
    invalid((_gameplay, _catalog, goals) => {
      (goals.goals[0] as { scope: string }).scope = "monthly";
    }, /scope/);
    invalid((_gameplay, _catalog, goals) => {
      goals.goals[0].passXp = 10001;
    }, /passXp/);
    invalid((_gameplay, _catalog, goals) => {
      goals.goals[0].passXp = -1;
    }, /passXp/);
    invalid((_gameplay, _catalog, goals) => {
      goals.goals[0].passXp = 1.5;
    }, /passXp/);
  });

  it("rolls back a multi-file export when a later file cannot be written", () => {
    const dir = mkdtempSync(join(tmpdir(), "party-transaction-"));
    try {
      const first = join(dir, "first.json");
      const block = join(dir, "block");
      writeFileSync(first, "original");
      writeFileSync(block, "file");
      assert.throws(() =>
        writeTransaction([
          [first, "new"],
          [join(block, "child"), "fail"],
        ]),
      );
      assert.equal(readFileSync(first, "utf8"), "original");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs valid bundles from the CLI and refuses to start on a broken one", () => {
    const dir = mkdtempSync(join(tmpdir(), "party-cli-"));
    try {
      const source = join(dir, "bundle.json");
      const installed = join(dir, "installed.json");
      const bundle = pack();
      writeFileSync(source, JSON.stringify(bundle));
      for (const args of [
        ["validate", source],
        ["install", source, installed],
      ]) {
        const result = run(["src/modules/content/content.cli.ts", ...args]);
        assert.equal(result.status, 0, result.stderr);
      }
      const load = (path: string) =>
        run(
          [
            "--input-type=module",
            "-e",
            "import { loadContent } from './src/modules/content/active-content.js';" +
              "console.log(loadContent(process.env.BUNDLE).config.revision)",
          ],
          { ...process.env, BUNDLE: path },
        );
      assert.equal(load(installed).stdout.trim(), verifyBundle(bundle).config.revision);
      writeFileSync(installed, "{}");
      assert.notEqual(load(installed).status, 0);
      const bad = run(["src/modules/content/content.cli.ts", "install", installed, join(dir, "bad.json")]);
      assert.notEqual(bad.status, 0);
      assert.equal(existsSync(join(dir, "bad.json")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("content upload", () => {
  it("authenticates, validates before writing and protects owned characters, without hot reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "party-upload-"));
    const stagePath = join(dir, "next.json");
    const key: string = randomUUID();
    const server = await startServer({ adminKey: key, contentStagePath: stagePath });
    const post = (body: unknown, auth = key) =>
      fetch(server.url + "/api/admin/content", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + auth },
        body: JSON.stringify(body),
      });
    try {
      const bundle = pack();
      assert.equal((await post(bundle, "wrong")).status, 401);
      assert.equal(existsSync(stagePath), false);
      assert.equal((await post({ ...bundle, checksum: "0".repeat(64) })).status, 400);
      assert.equal(existsSync(stagePath), false);
      const response = await post(bundle);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.restartRequired, true);
      assert.equal(result.activeConfigChanged, false);
      assert.equal(JSON.parse(readFileSync(stagePath, "utf8")).checksum, bundle.checksum);
      assert.equal((await (await fetch(server.url + "/health")).json()).revision, content.config.revision);

      const rarity = sections();
      rarity[1].characters[0].rarity = "rare";
      const rejectedIdentity = await post(pack(rarity));
      assert.equal(rejectedIdentity.status, 400);
      assert.match((await rejectedIdentity.json()).error, /migration/);
      const metric = sections();
      metric[2].goals[0].metric = "wins";
      assert.equal((await post(pack(metric))).status, 400);
      const scope = sections();
      scope[2].goals[0].scope = "weekly";
      const rejectedScope = await post(pack(scope));
      assert.equal(rejectedScope.status, 400);
      assert.match((await rejectedScope.json()).error, /migration/);

      const account = await server.container.accounts.register({
        username: "exporttest",
        password: "export-test-password",
      });
      await server.container.collection.state(account.profile.id);
      const changed = sections();
      changed[1].starterId = "coral";
      changed[1].characters = changed[1].characters.filter(character => character.id !== "rookie");
      const rejected = await post(pack(changed));
      assert.equal(rejected.status, 400);
      assert.match((await rejected.json()).error, /owned/);
      assert.equal(JSON.parse(readFileSync(stagePath, "utf8")).checksum, bundle.checksum);
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is disabled without deployment credentials", async () => {
    const server = await startServer({ adminKey: undefined, contentStagePath: undefined });
    try {
      assert.equal((await fetch(server.url + "/api/admin/content", { method: "POST" })).status, 404);
    } finally {
      await server.stop();
    }
  });
});
