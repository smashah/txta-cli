#!/usr/bin/env node
import { main } from "./cli.js";

main().catch((error: unknown) => {
  console.error(`txta: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
