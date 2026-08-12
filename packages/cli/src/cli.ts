#!/usr/bin/env node
import { Effect } from "effect";
import packageJson from "../package.json" with { type: "json" };
import { parseArgs } from "./args.js";
import { sendProgram } from "./program.js";

const help = `txta.dev ${packageJson.version}

Send a locally encrypted letter through your authenticated GitHub CLI.

Usage:
  npx txtadev <github-login> <message>
  printf 'a private message' | npx txtadev <github-login>
  npx txtadev

Options:
  --to <login>          Recipient GitHub username
  --fingerprint <value> Advanced: require one exact published key
  --message <text>      Read the message from an argument instead of the prompt
  --dry-run             Encrypt and verify the issue without posting
  --version             Print the package version
  --help                Show this help
`;

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) return console.log(help);
  if (options.version) return console.log(packageJson.version);
  await Effect.runPromise(sendProgram(options));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(`txta: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
