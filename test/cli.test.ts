import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeLogin, parseArgs, parseCommand } from "../packages/cli/src/args.js";
import { exactEnvelope, extractFencedEnvelope } from "../packages/cli/src/envelope.js";
import { decryptWithLocalSshKeys, listLocalSshKeys } from "../packages/cli/src/identity.js";
import { intersectPublishedKeys, parseRecipientPreference, resolveRecipientKey, serializeRecipientPreference } from "../packages/cli/src/preference.js";
import { renderCanonicalIssue } from "../packages/cli/src/renderer.js";
import { encryptForSsh, sshFingerprint } from "../packages/cli/src/ssh.js";

const envelope = `-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRpb24ub3JnL3Yx
-----END AGE ENCRYPTED FILE-----`;

describe("canonical issue", () => {
  it("keeps exactly one AGE envelope in the frozen issue shape", () => {
    const body = renderCanonicalIssue({ ciphertext: envelope, fingerprint: "SHA256:test", messageId: "test-id", recipient: "smashah" });
    expect(extractFencedEnvelope(body)).toBe(envelope);
    expect(body.match(/-----BEGIN AGE ENCRYPTED FILE-----/gu)).toHaveLength(1);
    expect(body).toContain("<!-- txta-id:test-id -->");
    expect(body).toContain("Sealed for **@smashah**");
    expect(body).toContain("https://assets.txta.dev/i/banner-scroll-2efe9030.png");
    expect(body).toContain("npx txtadev read --id test-id");
    expect(body).not.toContain("age -d");
    expect(body).not.toContain("~/.ssh/id_ed25519");
  });

  it("rejects content outside the envelope", () => {
    expect(() => exactEnvelope(`prefix\n${envelope}`)).toThrow(/envelope and nothing/u);
  });
});

describe("GitHub login", () => {
  it("normalizes an @ prefix", () => expect(normalizeLogin("@smashah")).toBe("smashah"));
  it("rejects invalid usernames", () => expect(() => normalizeLogin("not/a/user")).toThrow(/valid GitHub/u));
});

describe("zero-ceremony arguments", () => {
  it("accepts a target followed by a plain message", () => {
    expect(parseArgs(["smashah", "hi", "from", "txta"])).toMatchObject({ login: "smashah", message: "hi from txta" });
  });

  it("keeps stdin available when only the target is positional", () => {
    const options = parseArgs(["smashah"]);
    expect(options.login).toBe("smashah");
    expect(options.message).toBeUndefined();
  });

  it("reserves inbox, read, and set while keeping an explicit username escape hatch", () => {
    expect(parseCommand(["inbox"])).toEqual({ kind: "inbox" });
    expect(parseCommand(["read", "6"])).toEqual({ issueNumber: 6, kind: "read" });
    expect(parseCommand(["set"])).toEqual({ kind: "set" });
    expect(parseCommand(["--to", "inbox", "--message", "hi"])).toMatchObject({ kind: "send", options: { login: "inbox", message: "hi" } });
  });
});

describe("recipient key preference", () => {
  const firstFingerprint = `SHA256:${"A".repeat(43)}`;
  const secondFingerprint = `SHA256:${"B".repeat(43)}`;
  const goneFingerprint = `SHA256:${"C".repeat(43)}`;
  const localOnlyFingerprint = `SHA256:${"D".repeat(43)}`;
  const keys = [
    { algorithm: "ssh-ed25519" as const, fingerprint: firstFingerprint, key: "first" },
    { algorithm: "ssh-ed25519" as const, fingerprint: secondFingerprint, key: "second" },
  ];

  it("round-trips the public preference document", () => {
    const encoded = serializeRecipientPreference(secondFingerprint);
    expect(parseRecipientPreference(encoded)).toEqual({ preferredSshFingerprint: secondFingerprint, version: 1 });
    expect(() => parseRecipientPreference(JSON.stringify({ extra: "not part of the public contract", preferredSshFingerprint: secondFingerprint, version: 1 })))
      .toThrow(/Invalid .github\/txta.json/u);
  });

  it("uses the recipient preference unless the sender explicitly overrides it", () => {
    expect(resolveRecipientKey(keys, { preferredFingerprint: secondFingerprint, recipient: "Dylan" })).toBe(keys[1]);
    expect(resolveRecipientKey(keys, { explicitFingerprint: firstFingerprint, preferredFingerprint: secondFingerprint, recipient: "Dylan" })).toBe(keys[0]);
    expect(() => resolveRecipientKey(keys, { preferredFingerprint: goneFingerprint, recipient: "Dylan" })).toThrow(/npx txtadev set/u);
  });

  it("offers only public keys whose private half is local", () => {
    expect(intersectPublishedKeys(keys, [
      { fingerprint: secondFingerprint, locked: false, path: "/tmp/second" },
      { fingerprint: localOnlyFingerprint, locked: false, path: "/tmp/local" },
    ])).toEqual([{ ...keys[1], localPath: "/tmp/second", locked: false }]);
  });

});

describe("bundled SSH decryption", () => {
  it("tries every local private key and opens with the matching one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "txta-keys-"));
    try {
      const decoy = join(directory, "decoy");
      const matching = join(directory, "matching");
      for (const path of [decoy, matching]) {
        const generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path]);
        expect(generated.status, generated.stderr.toString()).toBe(0);
      }
      const publicKey = await readFile(`${matching}.pub`, "utf8");
      const ciphertext = await encryptForSsh("hello from txta", publicKey);

      await expect(decryptWithLocalSshKeys({
        ciphertext,
        expectedFingerprint: await sshFingerprint(publicKey),
        sshDirectory: directory,
      })).resolves.toBe("hello from txta");
      const localKeys = await listLocalSshKeys({ sshDirectory: directory });
      expect(localKeys.map((key) => key.fingerprint)).toContain(await sshFingerprint(publicKey));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("prompts only when a matching private key is locked", async () => {
    const directory = await mkdtemp(join(tmpdir(), "txta-locked-key-"));
    try {
      const matching = join(directory, "locked");
      const generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "secret", "-f", matching]);
      expect(generated.status, generated.stderr.toString()).toBe(0);
      const publicKey = await readFile(`${matching}.pub`, "utf8");
      const ciphertext = await encryptForSsh("locked letter", publicKey);
      const prompted: string[] = [];

      await expect(decryptWithLocalSshKeys({
        ciphertext,
        expectedFingerprint: await sshFingerprint(publicKey),
        promptPassphrase: async (path) => {
          prompted.push(path);
          return "secret";
        },
        sshDirectory: directory,
      })).resolves.toBe("locked letter");
      expect(prompted).toEqual([matching]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
