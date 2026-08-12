import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "txta-set-acceptance-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error([`$ ${command} ${args.join(" ")}`, result.stdout, result.stderr].filter(Boolean).join("\n"));
  }
  return result;
}

try {
  const home = join(temporary, "home");
  const sshDirectory = join(home, ".ssh");
  const binDirectory = join(temporary, "bin");
  const capture = join(temporary, "capture.json");
  await mkdir(sshDirectory, { recursive: true });
  await mkdir(binDirectory);
  const privateKey = join(sshDirectory, "id_txta_acceptance");
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", privateKey]);
  const publicKey = (await readFile(`${privateKey}.pub`, "utf8")).trim();

  const gh = join(binDirectory, "gh");
  await writeFile(gh, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const endpoint = args[1] ?? "";
if (args[0] === "auth") process.exit(0);
if (endpoint === "user") process.stdout.write("Dylan");
else if (endpoint === "users/Dylan/keys") process.stdout.write(JSON.stringify([{ id: 1, key: process.env.TXTA_TEST_PUBLIC_KEY }]));
else if (endpoint === "repos/Dylan/Dylan") process.stdout.write(JSON.stringify({ archived: false, has_issues: true, html_url: "https://github.test/Dylan/Dylan" }));
else if (endpoint.endsWith("/.github/txta.json") && args.includes("PUT")) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  writeFileSync(process.env.TXTA_TEST_GH_CAPTURE, input);
  process.stdout.write(JSON.stringify({ commit: { html_url: "https://github.test/commit" }, content: { html_url: "https://github.test/config" } }));
} else if (endpoint.endsWith("/.github/txta.json")) {
  process.stderr.write("gh: Not Found (HTTP 404)\\n");
  process.exit(1);
} else {
  process.stderr.write(\`unexpected gh call: \${args.join(" ")}\\n\`);
  process.exit(1);
}
`);
  await chmod(gh, 0o755);

  const cli = run(process.execPath, [join(root, "packages/cli/dist/run.js"), "set"], {
    cwd: temporary,
    input: "1\n",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${binDirectory}:${process.env.PATH}`,
      TXTA_TEST_GH_CAPTURE: capture,
      TXTA_TEST_PUBLIC_KEY: publicKey,
    },
  });
  if (!cli.stdout.includes("Preferred key saved:") || !cli.stdout.includes("Public config: https://github.test/config")) {
    throw new Error(`set acceptance did not complete:\n${cli.stdout}`);
  }
  const request = JSON.parse(await readFile(capture, "utf8"));
  const preference = JSON.parse(Buffer.from(request.content, "base64").toString("utf8"));
  if (preference.version !== 1 || typeof preference.preferredSshFingerprint !== "string") {
    throw new Error("set acceptance wrote an invalid preference");
  }
  if (Object.keys(preference).sort().join(",") !== "preferredSshFingerprint,version") {
    throw new Error("set acceptance leaked more than the public fingerprint");
  }
  console.log(`Set acceptance: selected one local-and-public key and wrote only ${preference.preferredSshFingerprint}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
