import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Encrypter, Stanza, armor } from "age-encryption";

const encoder = new TextEncoder();
const SSH_ED25519_LABEL = encoder.encode("age-encryption.org/v1/ssh-ed25519");
const SSH_RSA_LABEL = encoder.encode("age-encryption.org/v1/ssh-rsa");

const decodeBase64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));
const encodeBase64NoPad = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").replace(/=+$/u, "");
const encodeBase64Url = (bytes: Uint8Array) => encodeBase64NoPad(bytes).replaceAll("+", "-").replaceAll("/", "_");

function concatBytes(...chunks: Uint8Array[]) {
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function readSshField(bytes: Uint8Array, offset: number) {
  if (offset + 4 > bytes.length) throw new Error("Malformed SSH key");
  const size = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
  const start = offset + 4;
  const end = start + size;
  if (end > bytes.length) throw new Error("Malformed SSH key");
  return { value: bytes.slice(start, end), offset: end };
}

type ParsedSshKey =
  | { type: "ssh-ed25519"; marshalled: Uint8Array; publicKey: Uint8Array }
  | { type: "ssh-rsa"; marshalled: Uint8Array; exponent: Uint8Array; modulus: Uint8Array };

function stripMpintPadding(bytes: Uint8Array) {
  let index = 0;
  while (index < bytes.length - 1 && bytes[index] === 0) index += 1;
  return bytes.slice(index);
}

export function parseSshKey(authorisedKey: string): ParsedSshKey {
  const [declaredType, encoded] = authorisedKey.trim().split(/\s+/u);
  if (!declaredType || !encoded) throw new Error("Malformed SSH public key");
  const marshalled = decodeBase64(encoded);
  const typeField = readSshField(marshalled, 0);
  const encodedType = new TextDecoder().decode(typeField.value);
  if (encodedType !== declaredType) throw new Error("SSH key type mismatch");

  if (declaredType === "ssh-ed25519") {
    const publicField = readSshField(marshalled, typeField.offset);
    if (publicField.value.length !== 32 || publicField.offset !== marshalled.length) {
      throw new Error("Malformed SSH Ed25519 key");
    }
    return { type: declaredType, marshalled, publicKey: publicField.value };
  }

  if (declaredType === "ssh-rsa") {
    const exponentField = readSshField(marshalled, typeField.offset);
    const modulusField = readSshField(marshalled, exponentField.offset);
    if (modulusField.offset !== marshalled.length) throw new Error("Malformed SSH RSA key");
    return {
      type: declaredType,
      marshalled,
      exponent: stripMpintPadding(exponentField.value),
      modulus: stripMpintPadding(modulusField.value),
    };
  }

  throw new Error(`Unsupported SSH key type: ${declaredType}`);
}

const asArrayBuffer = (bytes: Uint8Array) => Uint8Array.from(bytes).buffer;

const fingerprintBytes = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", asArrayBuffer(bytes)));

export async function sshFingerprint(authorisedKey: string) {
  return `SHA256:${encodeBase64NoPad(await fingerprintBytes(parseSshKey(authorisedKey).marshalled))}`;
}

class SshEd25519Recipient {
  readonly marshalled: Uint8Array;
  readonly publicKey: Uint8Array;

  constructor(parsed: Extract<ParsedSshKey, { type: "ssh-ed25519" }>) {
    this.marshalled = parsed.marshalled;
    this.publicKey = ed25519.utils.toMontgomery(parsed.publicKey);
  }

  async wrapFileKey(fileKey: Uint8Array) {
    const ephemeral = crypto.getRandomValues(new Uint8Array(32));
    const ephemeralPublic = x25519.getPublicKey(ephemeral);
    let sharedSecret = x25519.getSharedSecret(ephemeral, this.publicKey);
    const tweak = hkdf(sha256, new Uint8Array(), this.marshalled, SSH_ED25519_LABEL, 32);
    sharedSecret = x25519.getSharedSecret(tweak, sharedSecret);
    const salt = concatBytes(ephemeralPublic, this.publicKey);
    const wrappingKey = hkdf(sha256, sharedSecret, salt, SSH_ED25519_LABEL, 32);
    const wrapped = chacha20poly1305(wrappingKey, new Uint8Array(12)).encrypt(fileKey);
    const shortFingerprint = encodeBase64NoPad((await fingerprintBytes(this.marshalled)).slice(0, 4));
    return [new Stanza(["ssh-ed25519", shortFingerprint, encodeBase64NoPad(ephemeralPublic)], wrapped)];
  }
}

class SshRsaRecipient {
  constructor(private readonly parsed: Extract<ParsedSshKey, { type: "ssh-rsa" }>) {}

  async wrapFileKey(fileKey: Uint8Array) {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: encodeBase64Url(this.parsed.modulus), e: encodeBase64Url(this.parsed.exponent), alg: "RSA-OAEP-256", ext: true },
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP", label: asArrayBuffer(SSH_RSA_LABEL) }, key, asArrayBuffer(fileKey)));
    const shortFingerprint = encodeBase64NoPad((await fingerprintBytes(this.parsed.marshalled)).slice(0, 4));
    return [new Stanza(["ssh-rsa", shortFingerprint], wrapped)];
  }
}

export async function encryptForSsh(plaintext: string, authorisedKey: string) {
  const parsed = parseSshKey(authorisedKey);
  const recipient = parsed.type === "ssh-ed25519" ? new SshEd25519Recipient(parsed) : new SshRsaRecipient(parsed);
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  return armor.encode(await encrypter.encrypt(plaintext));
}
