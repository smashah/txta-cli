export type CliOptions = {
  dryRun: boolean;
  fingerprint?: string;
  help: boolean;
  login?: string;
  message?: string;
  version: boolean;
};

export type CliCommand =
  | { kind: "block" }
  | { kind: "help" }
  | { kind: "inbox" }
  | { issueNumber?: number; kind: "read"; messageId?: string }
  | { kind: "set" }
  | { kind: "send"; options: CliOptions };

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { dryRun: false, help: false, version: false };
  const positional: string[] = [];
  const nextValue = (flag: string, index: number) => {
    const value = args[index];
    if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value.`);
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--help" || value === "-h") options.help = true;
    else if (value === "--version" || value === "-v") options.version = true;
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "--to") options.login = nextValue(value, ++index);
    else if (value === "--fingerprint") options.fingerprint = nextValue(value, ++index);
    else if (value === "--message") options.message = nextValue(value, ++index);
    else if (value === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    else if (value?.startsWith("-")) throw new Error(`Unknown argument: ${value}`);
    else if (value) positional.push(value);
  }
  if (!options.login && positional.length > 0) options.login = positional.shift()!;
  if (!options.message && positional.length > 0) options.message = positional.join(" ");
  return options;
}

export function parseCommand(args: string[]): CliCommand {
  if (args[0] === "help") {
    if (args.length !== 1) throw new Error("Usage: npx txtadev help");
    return { kind: "help" };
  }
  if (args[0] === "block") {
    if (args.length !== 1) throw new Error("Usage: npx txtadev block");
    return { kind: "block" };
  }
  if (args[0] === "set") {
    if (args.length !== 1) throw new Error("Usage: npx txtadev set");
    return { kind: "set" };
  }
  if (args[0] === "inbox") {
    if (args.length !== 1) throw new Error("Usage: npx txtadev inbox");
    return { kind: "inbox" };
  }
  if (args[0] === "read") {
    let issueNumber: number | undefined;
    let messageId: string | undefined;
    for (let index = 1; index < args.length; index += 1) {
      const value = args[index];
      if (value === "--id") {
        messageId = args[++index];
        if (!messageId || messageId.startsWith("-")) throw new Error("--id requires a message ID.");
      } else if (/^\d+$/u.test(value ?? "") && issueNumber === undefined) {
        issueNumber = Number(value);
      } else {
        throw new Error("Usage: npx txtadev read [issue-number] [--id message-id]");
      }
    }
    if (issueNumber !== undefined && messageId !== undefined) throw new Error("Choose an issue number or --id, not both.");
    return {
      kind: "read",
      ...(issueNumber === undefined ? {} : { issueNumber }),
      ...(messageId === undefined ? {} : { messageId }),
    };
  }
  return { kind: "send", options: parseArgs(args) };
}

export const normalizeLogin = (value: string) => {
  const login = value.trim().replace(/^@/u, "");
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/iu.test(login)) throw new Error("Enter a valid GitHub username.");
  return login;
};
