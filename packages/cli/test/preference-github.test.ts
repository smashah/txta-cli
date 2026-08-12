import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { updateRecipientPreference } from "../src/github.js";
import { parseRecipientPreference } from "../src/preference.js";

describe("GitHub recipient preference", () => {
  it("publishes only the selected fingerprint to the profile repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "txta-fake-gh-"));
    const capture = join(directory, "capture.json");
    const gh = join(directory, "gh");
    const fingerprint = `SHA256:${"B".repeat(43)}`;
    const originalPath = process.env.PATH;
    try {
      await writeFile(gh, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const endpoint = args[1] ?? "";
if (endpoint === "repos/txta-test-user/txta-test-user") process.stdout.write(JSON.stringify({ default_branch: "main" }));
else if (endpoint.endsWith("/git/ref/heads/main")) process.stdout.write("head-oid");
else if (endpoint.endsWith("/.github/txta.jsonc")) {
  const current = JSON.stringify({ preferredSshFingerprint: process.env.TXTA_TEST_FINGERPRINT, version: 1 });
  process.stdout.write(JSON.stringify({ content: Buffer.from(current).toString("base64"), encoding: "base64", html_url: "https://github.test/current", sha: "current-sha" }));
} else if (endpoint.endsWith("/.github/txta.json")) {
  const legacy = JSON.stringify({ preferredSshFingerprint: process.env.TXTA_TEST_FINGERPRINT, version: 1 });
  process.stdout.write(JSON.stringify({ content: Buffer.from(legacy).toString("base64"), encoding: "base64", html_url: "https://github.test/legacy", sha: "legacy-sha" }));
} else if (endpoint === "graphql") {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  writeFileSync(process.env.TXTA_TEST_GH_CAPTURE, JSON.stringify({ args, payload: JSON.parse(input) }));
  process.stdout.write(JSON.stringify({ data: { createCommitOnBranch: { commit: { url: "https://github.test/commit" } } } }));
} else process.exit(2);
`);
      await chmod(gh, 0o755);
      process.env.PATH = `${directory}:${originalPath}`;
      process.env.TXTA_TEST_GH_CAPTURE = capture;
      process.env.TXTA_TEST_FINGERPRINT = fingerprint;

      await expect(Effect.runPromise(updateRecipientPreference("txta-test-user", () => ({ preferredSshFingerprint: fingerprint })))).resolves.toMatchObject({
        commit: { url: "https://github.test/commit" },
      });
      const request = JSON.parse(await readFile(capture, "utf8")) as { args: string[]; payload: { variables: { input: { branch: { branchName: string; repositoryNameWithOwner: string }; expectedHeadOid: string; fileChanges: { additions: Array<{ contents: string; path: string }>; deletions: Array<{ path: string }> } } } } };
      expect(request.args).toEqual(["api", "graphql", "--input", "-"]);
      expect(request.payload.variables.input.branch).toEqual({ branchName: "main", repositoryNameWithOwner: "txta-test-user/txta-test-user" });
      expect(request.payload.variables.input.expectedHeadOid).toBe("head-oid");
      const addition = request.payload.variables.input.fileChanges.additions[0]!;
      expect(addition.path).toBe(".github/txta.jsonc");
      expect(request.payload.variables.input.fileChanges.deletions).toEqual([{ path: ".github/txta.json" }]);
      expect(parseRecipientPreference(Buffer.from(addition.contents, "base64").toString("utf8"))).toEqual({
        preferredSshFingerprint: fingerprint,
        version: 1,
      });
    } finally {
      process.env.PATH = originalPath;
      delete process.env.TXTA_TEST_GH_CAPTURE;
      delete process.env.TXTA_TEST_FINGERPRINT;
      await rm(directory, { force: true, recursive: true });
    }
  });
});
