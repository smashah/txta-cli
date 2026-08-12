#!/usr/bin/env node
import { Effect } from "effect";
import packageJson from "../package.json" with { type: "json" };
import { parseCommand } from "./args.js";
import { inboxProgram, readProgram, sendProgram } from "./program.js";

const help = `txta.dev ${packageJson.version}

Send a locally encrypted letter through your authenticated GitHub CLI.

Usage:
  npx txtadev <github-login> <message>
  printf 'a secure message' | npx txtadev <github-login>
  npx txtadev
  npx txtadev inbox
  npx txtadev read [issue-number]

Reserved names:
  inbox                    List sealed issues and choose one to open
  read                     Open the latest or selected sealed issue
  --to inbox <message>     Send to a GitHub user whose name is reserved

Options:
  --to <login>          Recipient GitHub username
  --fingerprint <value> Advanced: require one exact published key
  --message <text>      Read the message from an argument instead of the prompt
  --dry-run             Encrypt and verify the issue without posting
  --version             Print the package version
  --help                Show this help
`;

export async function main(args = process.argv.slice(2)) {
  const command = parseCommand(args);
  if (command.kind === "send" && command.options.help) return console.log(help);
  if (command.kind === "send" && command.options.version) return console.log(packageJson.version);
  if (command.kind === "inbox") return Effect.runPromise(inboxProgram);
  if (command.kind === "read") return Effect.runPromise(readProgram(command));
  await Effect.runPromise(sendProgram(command.options));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(`txta: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
