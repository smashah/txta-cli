#!/usr/bin/env node
import { Effect } from "effect";
import packageJson from "../package.json" with { type: "json" };
import { parseCommand } from "./args.js";
import { blockProgram, inboxProgram, readProgram, sendProgram, setProgram } from "./program.js";

const help = `txta.dev ${packageJson.version}

Send a locally encrypted letter through your authenticated GitHub CLI.

Usage:
  npx txtadev <github-login> <message>
  printf 'a secure message' | npx txtadev <github-login>
  npx txtadev
  npx txtadev inbox
  npx txtadev read [issue-number]
  npx txtadev set
  npx txtadev block
  npx txtadev help

Reserved names:
  block                    Stop accepting new txta messages
  help                     Show this help
  inbox                    List sealed issues and choose one to open
  read                     Open the latest or selected sealed issue
  set                      Choose the public key that txta should use for you
  --to <reserved> <text>   Send to a GitHub user named block, help, inbox, read, or set

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
  if (command.kind === "help") return console.log(help);
  if (command.kind === "send" && command.options.help) return console.log(help);
  if (command.kind === "send" && command.options.version) return console.log(packageJson.version);
  if (command.kind === "inbox") return Effect.runPromise(inboxProgram);
  if (command.kind === "read") return Effect.runPromise(readProgram(command));
  if (command.kind === "set") return Effect.runPromise(setProgram);
  if (command.kind === "block") return Effect.runPromise(blockProgram);
  await Effect.runPromise(sendProgram(command.options));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(`txta: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
