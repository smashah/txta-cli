import { describe, expect, it } from "vitest";
import { normalizeLogin } from "../packages/cli/src/args.js";
import { exactEnvelope, extractFencedEnvelope } from "../packages/cli/src/envelope.js";
import { renderCanonicalIssue } from "../packages/cli/src/renderer.js";

const envelope = `-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRpb24ub3JnL3Yx
-----END AGE ENCRYPTED FILE-----`;

describe("canonical issue", () => {
  it("keeps exactly one AGE envelope in the frozen issue shape", () => {
    const body = renderCanonicalIssue({ ciphertext: envelope, fingerprint: "SHA256:test", messageId: "test-id", recipient: "smashah" });
    expect(extractFencedEnvelope(body)).toBe(envelope);
    expect(body.match(/-----BEGIN AGE ENCRYPTED FILE-----/gu)).toHaveLength(1);
    expect(body).toContain("<!-- txta-id:test-id -->");
    expect(body).toContain("smashah/smashah");
  });

  it("rejects content outside the envelope", () => {
    expect(() => exactEnvelope(`prefix\n${envelope}`)).toThrow(/envelope and nothing/u);
  });
});

describe("GitHub login", () => {
  it("normalizes an @ prefix", () => expect(normalizeLogin("@smashah")).toBe("smashah"));
  it("rejects invalid usernames", () => expect(() => normalizeLogin("not/a/user")).toThrow(/valid GitHub/u));
});
