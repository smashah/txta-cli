import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { putRecipientPreference } from "../src/github.js";
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
if (!args.includes("PUT")) {
  process.stderr.write("gh: Not Found (HTTP 404)\\n");
  process.exit(1);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
writeFileSync(process.env.TXTA_TEST_GH_CAPTURE, JSON.stringify({ args, payload: JSON.parse(input) }));
process.stdout.write(JSON.stringify({ commit: { html_url: "https://github.test/commit" }, content: { html_url: "https://github.test/config" } }));
`);
      await chmod(gh, 0o755);
      process.env.PATH = `${directory}:${originalPath}`;
      process.env.TXTA_TEST_GH_CAPTURE = capture;

      await expect(Effect.runPromise(putRecipientPreference("Dylan", fingerprint))).resolves.toMatchObject({
        content: { html_url: "https://github.test/config" },
      });
      const request = JSON.parse(await readFile(capture, "utf8")) as { args: string[]; payload: { content: string; message: string } };
      expect(request.args).toEqual(["api", "repos/Dylan/Dylan/contents/.github/txta.json", "--method", "PUT", "--input", "-"]);
      expect(parseRecipientPreference(Buffer.from(request.payload.content, "base64").toString("utf8"))).toEqual({
        preferredSshFingerprint: fingerprint,
        version: 1,
      });
      expect(request.payload).not.toHaveProperty("path");
    } finally {
      process.env.PATH = originalPath;
      delete process.env.TXTA_TEST_GH_CAPTURE;
      await rm(directory, { force: true, recursive: true });
    }
  });
});
