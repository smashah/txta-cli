import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "txta-set-acceptance-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error([`$ ${command} ${args.join(" ")}`, result.stdout, result.stderr].filter(Boolean).join("\n"));
  }
  return result;
}

async function runInteractive(command, args, { steps, ...options }) {
  const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let nextPrompt = 0;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    while (nextPrompt < steps.length && stdout.includes(steps[nextPrompt].prompt)) {
      child.stdin.write(steps[nextPrompt].answer);
      nextPrompt += 1;
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (status !== 0) {
    throw new Error([`$ ${command} ${args.join(" ")}`, stdout, stderr].filter(Boolean).join("\n"));
  }
  return { stderr, stdout };
}

try {
  const home = join(temporary, "home");
  const sshDirectory = join(home, ".ssh");
  const binDirectory = join(temporary, "bin");
  const capture = join(temporary, "capture.json");
  const declinedCapture = join(temporary, "declined-capture.json");
  await mkdir(sshDirectory, { recursive: true });
  await mkdir(binDirectory);
  const privateKey = join(sshDirectory, "id_txta_acceptance");
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", privateKey]);
  const publicKey = (await readFile(`${privateKey}.pub`, "utf8")).trim();
  const help = run(process.execPath, [join(root, "packages/cli/dist/run.js"), "help"], { cwd: temporary });
  if (!help.stdout.includes("npx txtadev block") || !help.stdout.includes("--to <reserved>")) {
    throw new Error("help acceptance is missing the new commands or reserved-name escape hatch");
  }

  const gh = join(binDirectory, "gh");
  await writeFile(gh, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const endpoint = args[1] ?? "";
if (args[0] === "auth") process.exit(0);
if (endpoint === "user") process.stdout.write("txta-test-user");
else if (endpoint === "users/txta-test-user/keys") process.stdout.write(JSON.stringify([{ id: 1, key: process.env.TXTA_TEST_PUBLIC_KEY }]));
else if (endpoint === "repos/txta-test-user/txta-test-user") process.stdout.write(JSON.stringify({ archived: false, default_branch: "main", has_issues: true, html_url: "https://github.test/txta-test-user/txta-test-user" }));
else if (endpoint === "repos/txta-test-user/txta-test-user/git/ref/heads/main") process.stdout.write("head-oid");
else if (endpoint.endsWith("/README.md") && !args.includes("PUT")) process.stdout.write(JSON.stringify({ content: Buffer.from("# Test fixture\\n").toString("base64"), encoding: "base64", html_url: "https://github.test/readme", sha: "readme-sha" }));
else if (endpoint === "graphql") {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  for (const addition of request.variables.input.fileChanges.additions) appendFileSync(process.env.TXTA_TEST_GH_CAPTURE, JSON.stringify({ endpoint: addition.path, payload: { content: addition.contents } }) + "\\n");
  process.stdout.write(JSON.stringify({ data: { createCommitOnBranch: { commit: { url: "https://github.test/commit" } } } }));
} else if (endpoint.endsWith("/.github/txta.jsonc") && process.env.TXTA_TEST_CONFIG) {
  process.stdout.write(JSON.stringify({ content: Buffer.from(process.env.TXTA_TEST_CONFIG).toString("base64"), encoding: "base64", html_url: "https://github.test/config", sha: "config-sha" }));
} else if (endpoint.endsWith("/.github/txta.jsonc") || endpoint.endsWith("/.github/txta.json")) {
  process.stderr.write("gh: Not Found (HTTP 404)\\n");
  process.exit(1);
} else {
  process.stderr.write(\`unexpected gh call: \${args.join(" ")}\\n\`);
  process.exit(1);
}
`);
  await chmod(gh, 0o755);

  const prompts = [
    "Key number to use [1]: ",
    "Shall we add the txta command in the footer of your README? [Y/n]: ",
    "Commit this preference and README footer to github.com/txta-test-user/txta-test-user now? [Y/n]: ",
  ];
  const runSet = (confirmation, capturePath) =>
    runInteractive(process.execPath, [join(root, "packages/cli/dist/run.js"), "set"], {
      cwd: temporary,
      env: {
      ...process.env,
      HOME: home,
      PATH: `${binDirectory}:${process.env.PATH}`,
      TXTA_TEST_GH_CAPTURE: capturePath,
      TXTA_TEST_PUBLIC_KEY: publicKey,
      },
      steps: [
        { answer: "1\n", prompt: prompts[0] },
        { answer: "\n", prompt: prompts[1] },
        { answer: confirmation, prompt: prompts[2] },
      ],
    });

  const cli = await runSet("\n", capture);
  if (!cli.stdout.includes("Preferred key saved:") || !cli.stdout.includes("Commit: https://github.test/commit")) {
    throw new Error(`set acceptance did not complete:\n${cli.stdout}`);
  }
  const requests = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const configRequest = requests.find((request) => request.endpoint === ".github/txta.jsonc");
  const readmeRequest = requests.find((request) => request.endpoint === "README.md");
  const configText = Buffer.from(configRequest.payload.content, "base64").toString("utf8");
  const preference = JSON.parse(configText.replace(/^(?:\/\/.*\n)+/u, ""));
  if (preference.version !== 1 || typeof preference.preferredSshFingerprint !== "string") {
    throw new Error("set acceptance wrote an invalid preference");
  }
  if (Object.keys(preference).sort().join(",") !== "preferredSshFingerprint,version") {
    throw new Error("set acceptance leaked more than the public fingerprint");
  }
  if (!configText.startsWith("// Public txta.dev receiving preferences.")) {
    throw new Error("set acceptance did not write commented JSONC");
  }
  const readme = Buffer.from(readmeRequest.payload.content, "base64").toString("utf8");
  if (!readme.includes("npx txtadev txta-test-user") || !readme.endsWith("<!-- txta.dev:end -->\n")) {
    throw new Error("set acceptance did not append the README footer");
  }
  if (!cli.stdout.includes(prompts[2])) {
    throw new Error(`set acceptance did not ask before writing:\n${cli.stdout}`);
  }

  const declined = await runSet("n\n", declinedCapture);
  if (!declined.stdout.includes("Nothing changed.")) {
    throw new Error(`set acceptance did not confirm cancellation:\n${declined.stdout}`);
  }
  await readFile(declinedCapture, "utf8").then(
    () => { throw new Error("set acceptance wrote the preference after it was declined"); },
    () => undefined,
  );

  const blockCapture = join(temporary, "block-capture.json");
  const blocked = await runInteractive(process.execPath, [join(root, "packages/cli/dist/run.js"), "block"], {
    cwd: temporary,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${binDirectory}:${process.env.PATH}`,
      TXTA_TEST_GH_CAPTURE: blockCapture,
      TXTA_TEST_PUBLIC_KEY: publicKey,
    },
    steps: [{ answer: "\n", prompt: "Block new txta messages for @txta-test-user? [Y/n]: " }],
  });
  if (!blocked.stdout.includes("official txta send paths will refuse")) throw new Error("block acceptance did not complete");
  const blockRequest = JSON.parse((await readFile(blockCapture, "utf8")).trim());
  const blockText = Buffer.from(blockRequest.payload.content, "base64").toString("utf8");
  const blockConfig = JSON.parse(blockText.replace(/^(?:\/\/.*\n)+/u, ""));
  if (blockConfig.blocked !== true || blockConfig.version !== 1) throw new Error("block acceptance did not persist blocked: true");

  const refused = spawnSync(process.execPath, [join(root, "packages/cli/dist/run.js"), "txta-test-user", "hello", "--dry-run"], {
    cwd: temporary,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${binDirectory}:${process.env.PATH}`,
      TXTA_TEST_CONFIG: blockText,
      TXTA_TEST_PUBLIC_KEY: publicKey,
    },
  });
  if (refused.status === 0 || !refused.stderr.includes("not accepting txta messages")) {
    throw new Error(`sender did not honor blocked config:\n${refused.stdout}\n${refused.stderr}`);
  }
  console.log(`Profile acceptance: selected ${preference.preferredSshFingerprint}, added one README footer, honored decline, and blocked delivery`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
