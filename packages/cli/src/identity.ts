import { constants, createPrivateKey, privateDecrypt, type KeyObject } from "node:crypto";
import { createRequire } from "node:module";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { Decrypter, armor, type Identity, type Stanza } from "age-encryption";
import type { ParsedKey } from "ssh2";
import { exactEnvelope } from "./envelope.js";
import type { LocalSshKey } from "./preference.js";

const require = createRequire(import.meta.url);
const { utils } = require("ssh2") as typeof import("ssh2");
const encoder = new TextEncoder();
const SSH_ED25519_LABEL = encoder.encode("age-encryption.org/v1/ssh-ed25519");
const SSH_RSA_LABEL = encoder.encode("age-encryption.org/v1/ssh-rsa");

const decodeBase64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));
const decodeBase64Url = (value: string) => new Uint8Array(Buffer.from(value, "base64url"));
const encodeBase64NoPad = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").replace(/=+$/u, "");

function concatBytes(...chunks: Uint8Array[]) {
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

const fingerprint = (marshalled: Uint8Array) => `SHA256:${encodeBase64NoPad(sha256(marshalled))}`;
const shortFingerprint = (marshalled: Uint8Array) => encodeBase64NoPad(sha256(marshalled).slice(0, 4));

export abstract class SshIdentity implements Identity {
  readonly fingerprint: string;
  readonly path: string | undefined;

  constructor(readonly marshalled: Uint8Array, path?: string) {
    this.fingerprint = fingerprint(marshalled);
    this.path = path;
  }

  abstract unwrapFileKey(stanzas: Stanza[]): Promise<Uint8Array | null>;
}

class SshEd25519Identity extends SshIdentity {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;

  constructor(parsed: ParsedKey, key: KeyObject, path?: string) {
    const marshalled = new Uint8Array(parsed.getPublicSSH());
    super(marshalled, path);
    const jwk = key.export({ format: "jwk" });
    if (!jwk.d) throw new Error("Malformed SSH Ed25519 private key");
    this.secretKey = sha512(decodeBase64Url(jwk.d)).slice(0, 32);
    this.publicKey = x25519.getPublicKey(this.secretKey);
  }

  async unwrapFileKey(stanzas: Stanza[]) {
    for (const stanza of stanzas) {
      if (stanza.args[0] !== "ssh-ed25519") continue;
      if (stanza.args.length !== 3) throw new Error("Invalid SSH Ed25519 stanza");
      if (stanza.args[1] !== shortFingerprint(this.marshalled)) continue;
      const ephemeralPublic = decodeBase64(stanza.args[2]!);
      if (ephemeralPublic.length !== 32) throw new Error("Invalid SSH Ed25519 stanza");
      let sharedSecret = x25519.getSharedSecret(this.secretKey, ephemeralPublic);
      const tweak = hkdf(sha256, new Uint8Array(), this.marshalled, SSH_ED25519_LABEL, 32);
      sharedSecret = x25519.getSharedSecret(tweak, sharedSecret);
      const wrappingKey = hkdf(sha256, sharedSecret, concatBytes(ephemeralPublic, this.publicKey), SSH_ED25519_LABEL, 32);
      return chacha20poly1305(wrappingKey, new Uint8Array(12)).decrypt(stanza.body);
    }
    return null;
  }
}

class SshRsaIdentity extends SshIdentity {
  constructor(parsed: ParsedKey, private readonly key: KeyObject, path?: string) {
    super(new Uint8Array(parsed.getPublicSSH()), path);
  }

  async unwrapFileKey(stanzas: Stanza[]) {
    for (const stanza of stanzas) {
      if (stanza.args[0] !== "ssh-rsa") continue;
      if (stanza.args.length !== 2) throw new Error("Invalid SSH RSA stanza");
      if (stanza.args[1] !== shortFingerprint(this.marshalled)) continue;
      return new Uint8Array(privateDecrypt({
        key: this.key,
        oaepHash: "sha256",
        oaepLabel: Buffer.from(SSH_RSA_LABEL),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      }, stanza.body));
    }
    return null;
  }
}

export function parseSshPrivateIdentity(contents: Uint8Array, passphrase?: string, path?: string) {
  const parsed = utils.parseKey(Buffer.from(contents), passphrase);
  if (parsed instanceof Error) throw parsed;
  if (!parsed.isPrivateKey()) throw new Error("Not an SSH private key");
  const key = createPrivateKey(parsed.getPrivatePEM());
  if (parsed.type === "ssh-ed25519") return new SshEd25519Identity(parsed, key, path);
  if (parsed.type === "ssh-rsa") return new SshRsaIdentity(parsed, key, path);
  throw new Error(`Unsupported SSH private key type: ${parsed.type}`);
}

export async function decryptForSsh(ciphertext: string, identities: SshIdentity[]) {
  const envelope = armor.decode(exactEnvelope(ciphertext));
  let lastError: unknown;
  for (const identity of identities) {
    try {
      const decrypter = new Decrypter();
      decrypter.addIdentity(identity);
      return await decrypter.decrypt(envelope, "text");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("No SSH private key was available to open this letter.");
}

type LockedKey = { contents: Uint8Array; path: string; publishedFingerprint: string | undefined };

async function siblingFingerprint(path: string) {
  try {
    const publicKey = (await readFile(`${path}.pub`, "utf8")).trim().split(/\s+/u);
    if (!publicKey[0] || !publicKey[1]) return undefined;
    const marshalled = decodeBase64(publicKey[1]);
    return fingerprint(marshalled);
  } catch {
    return undefined;
  }
}

async function findLocalKeys(directory: string) {
  const identities: SshIdentity[] = [];
  const locked: LockedKey[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return { identities, locked };
  }
  for (const entry of entries) {
    if (entry.name.endsWith(".pub") || entry.name === "authorized_keys" || entry.name === "config" || entry.name.startsWith("known_hosts")) continue;
    const path = join(directory, entry.name);
    try {
      const details = await stat(path);
      if (!details.isFile() || details.size > 1024 * 1024) continue;
      const contents = new Uint8Array(await readFile(path));
      if (!Buffer.from(contents).includes("PRIVATE KEY")) continue;
      try {
        identities.push(parseSshPrivateIdentity(contents, undefined, path));
      } catch (error) {
        if (/encrypted|passphrase/iu.test(error instanceof Error ? error.message : String(error))) {
          locked.push({ contents, path, publishedFingerprint: await siblingFingerprint(path) });
        }
      }
    } catch {
      // Ignore unrelated or unreadable files in ~/.ssh.
    }
  }
  return { identities, locked };
}

export async function listLocalSshKeys({
  expectedFingerprints,
  promptPassphrase,
  sshDirectory = join(homedir(), ".ssh"),
  verifyLocked = false,
}: {
  expectedFingerprints?: string[];
  promptPassphrase?: (path: string) => Promise<string>;
  sshDirectory?: string;
  verifyLocked?: boolean;
} = {}) {
  const { identities, locked } = await findLocalKeys(sshDirectory);
  const keys: LocalSshKey[] = identities.map((identity) => ({
    fingerprint: identity.fingerprint,
    locked: false,
    path: identity.path!,
  }));
  for (const candidate of locked) {
    if (candidate.publishedFingerprint && expectedFingerprints && !expectedFingerprints.includes(candidate.publishedFingerprint)) continue;
    if (!verifyLocked) {
      if (candidate.publishedFingerprint) keys.push({ fingerprint: candidate.publishedFingerprint, locked: true, path: candidate.path });
      continue;
    }
    if (!promptPassphrase) continue;
    const passphrase = await promptPassphrase(candidate.path);
    if (!passphrase) continue;
    try {
      const identity = parseSshPrivateIdentity(candidate.contents, passphrase, candidate.path);
      keys.push({ fingerprint: identity.fingerprint, locked: true, path: candidate.path });
    } catch {
      // A locked key with the wrong passphrase is not a verified local match.
    }
  }
  return [...new Map(keys.map((key) => [key.fingerprint, key])).values()];
}

export async function decryptWithLocalSshKeys({
  ciphertext,
  expectedFingerprint,
  promptPassphrase,
  sshDirectory = join(homedir(), ".ssh"),
}: {
  ciphertext: string;
  expectedFingerprint: string;
  promptPassphrase?: (path: string) => Promise<string>;
  sshDirectory?: string;
}) {
  const { identities, locked } = await findLocalKeys(sshDirectory);
  identities.sort((left, right) => Number(right.fingerprint === expectedFingerprint) - Number(left.fingerprint === expectedFingerprint));
  try {
    if (identities.length > 0) return await decryptForSsh(ciphertext, identities);
  } catch {
    // Try encrypted identities next.
  }

  locked.sort((left, right) => Number(right.publishedFingerprint === expectedFingerprint) - Number(left.publishedFingerprint === expectedFingerprint));
  for (const candidate of locked) {
    if (!promptPassphrase) continue;
    const passphrase = await promptPassphrase(candidate.path);
    if (!passphrase) continue;
    try {
      identities.push(parseSshPrivateIdentity(candidate.contents, passphrase, candidate.path));
      return await decryptForSsh(ciphertext, identities);
    } catch {
      // A wrong passphrase or non-matching key must not stop the remaining candidates.
    }
  }

  if (identities.length === 0 && locked.length === 0) {
    throw new Error(`No SSH private keys were found in ${sshDirectory}. You need the private half of ${expectedFingerprint} from the machine or backup where it was created; publishing a new key only helps future letters.`);
  }
  throw new Error(`None of the SSH private keys in ${sshDirectory} can open this letter. You need the private half of ${expectedFingerprint} from the machine or backup where it was created; publishing a new key only helps future letters.`);
}
