export type CliOptions = {
  dryRun: boolean;
  fingerprint?: string;
  help: boolean;
  login?: string;
  message?: string;
  version: boolean;
  yes: boolean;
};

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { dryRun: false, help: false, version: false, yes: false };
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
    else if (value === "--yes" || value === "-y") options.yes = true;
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

export const normalizeLogin = (value: string) => {
  const login = value.trim().replace(/^@/u, "");
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/iu.test(login)) throw new Error("Enter a valid GitHub username.");
  return login;
};
