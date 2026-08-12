import { parse, type ParseError } from "jsonc-parser";

export const RECIPIENT_PREFERENCE_PATH = ".github/txta.jsonc";
export const LEGACY_RECIPIENT_PREFERENCE_PATH = ".github/txta.json";

const fingerprintPattern = /^SHA256:[A-Za-z\d+/]{43}$/u;

export type RecipientPreference = {
  blocked?: true;
  preferredSshFingerprint?: string;
  version: 1;
};

export type LocalSshKey = {
  fingerprint: string;
  locked: boolean;
  path: string;
};

export function parseRecipientPreference(contents: string): RecipientPreference {
  const errors: ParseError[] = [];
  const value: unknown = parse(contents, errors, { allowTrailingComma: true });
  const parsed = typeof value === "object" && value !== null ? value as Partial<RecipientPreference> : undefined;
  const fields = parsed ? Object.keys(parsed).sort() : [];
  if (
    errors.length > 0
    || !parsed
    || fields.some((field) => field !== "blocked" && field !== "preferredSshFingerprint" && field !== "version")
    || parsed.version !== 1
    || (parsed.blocked !== undefined && parsed.blocked !== true)
    || (parsed.preferredSshFingerprint !== undefined && !fingerprintPattern.test(parsed.preferredSshFingerprint))
    || (parsed.blocked !== true && parsed.preferredSshFingerprint === undefined)
  ) {
    throw new Error(`Invalid ${RECIPIENT_PREFERENCE_PATH}`);
  }
  return {
    ...(parsed.blocked ? { blocked: true as const } : {}),
    ...(parsed.preferredSshFingerprint ? { preferredSshFingerprint: parsed.preferredSshFingerprint } : {}),
    version: 1,
  };
}

export function serializeRecipientPreference(preferredSshFingerprint?: string, { blocked = false }: { blocked?: boolean } = {}) {
  if (preferredSshFingerprint !== undefined && !fingerprintPattern.test(preferredSshFingerprint)) throw new Error("Invalid SSH fingerprint");
  if (!preferredSshFingerprint && !blocked) throw new Error("A recipient preference must select a key or block delivery");
  const config = {
    version: 1,
    ...(preferredSshFingerprint ? { preferredSshFingerprint } : {}),
    ...(blocked ? { blocked: true } : {}),
  };
  return `// Public txta.dev receiving preferences. No private keys or messages belong here.\n// Run \"npx txtadev help\" before editing.\n${JSON.stringify(config, null, 2)}\n`;
}

export function selectRecipientKey(preferredSshFingerprint: string, current?: RecipientPreference) {
  return {
    ...(current?.blocked ? { blocked: true as const } : {}),
    preferredSshFingerprint,
  };
}

const readmeFooterStart = "<!-- txta.dev:start -->";
const readmeFooterEnd = "<!-- txta.dev:end -->";

export function upsertReadmeFooter(contents: string, login: string) {
  const footer = `${readmeFooterStart}\n📫 Send me a secure developer message: \`npx txtadev ${login}\` · [txta.dev/${login}](https://txta.dev/${login})\n${readmeFooterEnd}`;
  const existing = new RegExp(`${readmeFooterStart.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[\\s\\S]*?${readmeFooterEnd.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u");
  if (existing.test(contents)) return `${contents.replace(existing, footer).trimEnd()}\n`;
  return `${contents.trimEnd()}\n\n${footer}\n`;
}

export function resolveRecipientKey<T extends { fingerprint: string }>(
  keys: T[],
  {
    explicitFingerprint,
    preferredFingerprint,
    recipient,
  }: { explicitFingerprint?: string; preferredFingerprint?: string; recipient: string },
) {
  const requested = explicitFingerprint ?? preferredFingerprint;
  if (!requested) return keys[0]!;
  const selected = keys.find((key) => key.fingerprint === requested);
  if (selected) return selected;
  if (explicitFingerprint) throw new Error("The selected key is no longer published. Check the recipient again before sending.");
  throw new Error(`@${recipient}'s preferred key is no longer published. Ask them to run npx txtadev set again.`);
}

export function intersectPublishedKeys<T extends { fingerprint: string }>(published: T[], local: LocalSshKey[]) {
  const localByFingerprint = new Map(local.map((key) => [key.fingerprint, key]));
  return published.flatMap((key) => {
    const match = localByFingerprint.get(key.fingerprint);
    return match ? [{ ...key, localPath: match.path, locked: match.locked }] : [];
  });
}
