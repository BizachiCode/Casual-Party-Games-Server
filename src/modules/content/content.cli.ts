/**
 * npm run content -- export [output.json]
 *   bundles game_config/party-*.json (default output: Exports/Server) and copies the validated matchmaking
 *   rules (party-matchmaking.json) next to the bundle, where the server reads them
 * npm run content -- validate bundle.json
 * npm run content -- install source.json destination.json
 *   then point PARTY_CONTENT_BUNDLE at the destination
 *
 * The files in game_config are written by Unity's "Tools > Casual Party > Export to Server"; the Unity exporter also
 * produces the same bundles, and this is for servers and CI.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { exportedBundlePath, gameConfigDirectory } from "../../config/paths.js";
import { MATCHMAKING_FILE, validateMatchmakingCatalog } from "../matchmaking/matchmaking.catalog.js";
import { atomicWrite, packBundle, readBundle, writeTransaction } from "./content-bundle.js";

const args = process.argv.slice(2);
const command = args.shift();
try {
  if (command === "export") {
    if (args.length > 1 || args.some(argument => argument.startsWith("--")))
      throw new Error("Usage: export [output.json]");
    const output = resolve(args[0] || exportedBundlePath);
    const paths = ["courses", "characters", "goals"].map(key => join(gameConfigDirectory, `party-${key}.json`));
    if (paths.includes(output)) throw new Error("Output cannot overwrite a source catalog.");
    const bundle = packBundle(...(paths.map(path => readFileSync(path, "utf8")) as [string, string, string]));
    const matchmakingJson = readFileSync(join(gameConfigDirectory, MATCHMAKING_FILE), "utf8");
    validateMatchmakingCatalog(JSON.parse(matchmakingJson), JSON.parse(bundle.gameplayJson));
    const matchmakingOutput = join(dirname(output), MATCHMAKING_FILE);
    writeTransaction([
      [output, JSON.stringify(bundle) + "\n"],
      [matchmakingOutput, matchmakingJson],
    ]);
    console.log(`Exported ${output} and ${matchmakingOutput}`);
    console.log(`Checksum ${bundle.checksum}`);
  } else if (command === "validate") {
    if (args.length !== 1) throw new Error("Usage: validate bundle.json");
    const { bundle, config, characterCatalog, goalCatalog } = readBundle(args[0]);
    console.log(
      JSON.stringify(
        {
          valid: true,
          revision: config.revision,
          checksum: bundle.checksum,
          courses: config.courses.length,
          modes: config.modes.length,
          characters: characterCatalog.characters.length,
          goals: goalCatalog.goals.length,
        },
        null,
        2,
      ),
    );
  } else if (command === "install") {
    if (args.length !== 2 || resolve(args[0]) === resolve(args[1]))
      throw new Error("Usage: install source.json server-path.json (different files)");
    const { bundle, config } = readBundle(args[0]);
    atomicWrite(args[1], JSON.stringify(bundle) + "\n");
    console.log(`Installed ${config.revision}.`);
    console.log("Set PARTY_CONTENT_BUNDLE to the destination and restart the server. Running matches are unchanged.");
  } else {
    throw new Error(
      "Usage: npm run content -- export [output.json]" +
        " | validate bundle.json" +
        " | install source.json destination.json",
    );
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
