import { readFile } from "node:fs/promises";

const load = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const cli = await load("../packages/cli/package.json");
const alias = await load("../packages/txtadev/package.json");
const pinned = alias.dependencies?.["@txtadev/cli"];
const sourcePin = pinned?.replace(/^workspace:/u, "");

if (cli.version !== alias.version || sourcePin !== cli.version) {
  console.error(`Lockstep violation: @txtadev/cli=${cli.version}, txtadev=${alias.version}, dependency=${pinned}`);
  process.exit(1);
}

console.log(`Lockstep ${cli.version}: txtadev -> @txtadev/cli`);
