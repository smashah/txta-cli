import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "txta-cli-acceptance-"));

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env });
  if (result.status !== 0) {
    throw new Error([`$ ${command} ${args.join(" ")}`, result.stdout, result.stderr].filter(Boolean).join("\n"));
  }
  return result.stdout.trim();
}

async function packageVersion(path) {
  return JSON.parse(await readFile(path, "utf8")).version;
}

try {
  const version = await packageVersion(join(root, "packages/cli/package.json"));
  run("pnpm", ["pack", "--pack-destination", temporary], join(root, "packages/cli"));
  run("pnpm", ["pack", "--pack-destination", temporary], join(root, "packages/txtadev"));

  const cliTarball = join(temporary, `txtadev-cli-${version}.tgz`);
  const aliasTarball = join(temporary, `txtadev-${version}.tgz`);
  const canonicalDir = join(temporary, "canonical");
  const aliasDir = join(temporary, "alias");
  run("mkdir", [canonicalDir]);
  run("mkdir", [aliasDir]);

  for (const directory of [canonicalDir, aliasDir]) run("npm", ["init", "--yes"], directory);
  run("npm", ["install", cliTarball], canonicalDir);
  run("npm", ["install", cliTarball], aliasDir);
  run("npm", ["install", aliasTarball, "--offline"], aliasDir);

  const canonicalBin = join(canonicalDir, "node_modules/.bin/txtadev");
  const aliasBin = join(aliasDir, "node_modules/.bin/txtadev");
  const canonicalVersion = run(canonicalBin, ["--version"], canonicalDir);
  const aliasVersion = run(aliasBin, ["--version"], aliasDir);
  const canonicalHelp = run(canonicalBin, ["--help"], canonicalDir);
  const aliasHelp = run(aliasBin, ["--help"], aliasDir);

  if (canonicalVersion !== version || aliasVersion !== version || canonicalHelp !== aliasHelp) {
    throw new Error(`Acceptance mismatch: expected=${version}, canonical=${canonicalVersion}, alias=${aliasVersion}`);
  }
  console.log(`Acceptance ${version}: packed @txtadev/cli and txtadev expose the same CLI`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
