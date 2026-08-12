import { spawn } from "node:child_process";
import { Effect } from "effect";
import { parseSshKey, sshFingerprint } from "./ssh.js";

export class GithubError extends Error {
  readonly _tag = "GithubError";
}

export type RecipientKey = {
  algorithm: "ssh-ed25519" | "ssh-rsa";
  fingerprint: string;
  key: string;
};

const runGh = (args: string[], input?: string) =>
  Effect.tryPromise({
    try: () => new Promise<string>((resolve, reject) => {
      const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let size = 0;

      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) child.kill();
        else stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (size > 5 * 1024 * 1024) return reject(new Error("GitHub CLI response exceeded 5 MiB"));
        if (code !== 0) {
          const detail = Buffer.concat(stderr).toString("utf8").trim();
          return reject(new Error(detail || `gh exited with ${code ?? signal ?? "an unknown status"}`));
        }
        resolve(Buffer.concat(stdout).toString("utf8").trim());
      });
      if (input === undefined) child.stdin.end();
      else child.stdin.end(input);
    }),
    catch: (error) => new GithubError(error instanceof Error ? error.message : String(error)),
  });

export const ensureGithubAuth = runGh(["auth", "status"]);

export const discoverRecipient = (login: string) =>
  Effect.gen(function* () {
    const [sshJson, gpgJson] = yield* Effect.all([
      runGh(["api", `users/${login}/keys`]),
      runGh(["api", `users/${login}/gpg_keys`]),
    ]);
    const sshApi = JSON.parse(sshJson) as Array<{ id: number; key: string }>;
    const gpgApi = JSON.parse(gpgJson) as Array<{ revoked: boolean }>;
    const keys: RecipientKey[] = [];
    for (const candidate of sshApi) {
      try {
        const parsed = parseSshKey(candidate.key);
        keys.push({ algorithm: parsed.type, fingerprint: yield* Effect.promise(() => sshFingerprint(candidate.key)), key: candidate.key });
      } catch {
        // GitHub also publishes authentication-only key types that stock age cannot decrypt.
      }
    }
    return { keys, gpgCount: gpgApi.filter((key) => !key.revoked).length };
  });

export const ensureRecipientRepository = (login: string) =>
  Effect.gen(function* () {
    const json = yield* runGh(["api", `repos/${login}/${login}`]).pipe(
      Effect.mapError((error) => new GithubError(`@${login}'s profile repository is unavailable. Nothing was delivered. ${error.message}`)),
    );
    const repo = JSON.parse(json) as { archived: boolean; has_issues: boolean; html_url: string };
    if (repo.archived || !repo.has_issues) {
      return yield* Effect.fail(new GithubError(`@${login}'s profile repository cannot receive issues.`));
    }
    return repo;
  });

export const createEncryptedIssue = (login: string, body: string) =>
  Effect.gen(function* () {
    const payload = JSON.stringify({ title: "📬 You've got mail", body });
    const json = yield* runGh(["api", `repos/${login}/${login}/issues`, "--method", "POST", "--input", "-"], payload).pipe(
      Effect.mapError((error) => new GithubError(`GitHub did not accept the issue. Nothing was delivered. ${error.message}`)),
    );
    return JSON.parse(json) as { html_url: string; number: number };
  });
