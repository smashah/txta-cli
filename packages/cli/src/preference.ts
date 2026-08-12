export const RECIPIENT_PREFERENCE_PATH = ".github/txta.json";

const fingerprintPattern = /^SHA256:[A-Za-z\d+/]{43}$/u;

export type RecipientPreference = {
  preferredSshFingerprint: string;
  version: 1;
};

export type LocalSshKey = {
  fingerprint: string;
  locked: boolean;
  path: string;
};

export function parseRecipientPreference(contents: string): RecipientPreference {
  const parsed = JSON.parse(contents) as Partial<RecipientPreference>;
  const fields = typeof parsed === "object" && parsed !== null ? Object.keys(parsed).sort() : [];
  if (
    fields.length !== 2
    || fields[0] !== "preferredSshFingerprint"
    || fields[1] !== "version"
    || parsed.version !== 1
    || typeof parsed.preferredSshFingerprint !== "string"
    || !fingerprintPattern.test(parsed.preferredSshFingerprint)
  ) {
    throw new Error(`Invalid ${RECIPIENT_PREFERENCE_PATH}`);
  }
  return { preferredSshFingerprint: parsed.preferredSshFingerprint, version: 1 };
}

export function serializeRecipientPreference(preferredSshFingerprint: string) {
  if (!fingerprintPattern.test(preferredSshFingerprint)) throw new Error("Invalid SSH fingerprint");
  return `${JSON.stringify({ preferredSshFingerprint, version: 1 }, null, 2)}\n`;
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
