import { spawn } from "node:child_process";
import { Effect } from "effect";
import { parseRecipientPreference, RECIPIENT_PREFERENCE_PATH, serializeRecipientPreference } from "./preference.js";
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

export type InboxIssue = {
  author: { login: string } | null;
  createdAt: string;
  number: number;
  title: string;
  url: string;
};

export const getGithubViewer = runGh(["api", "user", "--jq", ".login"]);

type GithubContent = {
  content: string;
  encoding: "base64";
  html_url: string;
  sha: string;
};

const preferenceEndpoint = (login: string) => `repos/${login}/${login}/contents/${RECIPIENT_PREFERENCE_PATH}`;

const getPreferenceFile = (login: string) =>
  runGh(["api", preferenceEndpoint(login)]).pipe(
    Effect.map((json) => JSON.parse(json) as GithubContent),
    Effect.catch((error) => /(?:HTTP )?404|Not Found/iu.test(error.message) ? Effect.succeed(undefined) : Effect.fail(error)),
  );

export const getRecipientPreference = (login: string) =>
  Effect.gen(function* () {
    const file = yield* getPreferenceFile(login);
    if (!file) return undefined;
    try {
      return parseRecipientPreference(Buffer.from(file.content, file.encoding).toString("utf8"));
    } catch {
      return yield* Effect.fail(new GithubError(`@${login}'s ${RECIPIENT_PREFERENCE_PATH} is invalid. Ask them to run npx txtadev set again.`));
    }
  });

export const putRecipientPreference = (login: string, fingerprint: string) =>
  Effect.gen(function* () {
    const current = yield* getPreferenceFile(login);
    const payload = JSON.stringify({
      message: "chore: set txta.dev recipient key",
      content: Buffer.from(serializeRecipientPreference(fingerprint)).toString("base64"),
      ...(current ? { sha: current.sha } : {}),
    });
    const json = yield* runGh(["api", preferenceEndpoint(login), "--method", "PUT", "--input", "-"], payload).pipe(
      Effect.mapError((error) => new GithubError(`GitHub could not save the txta key preference. ${error.message}`)),
    );
    return JSON.parse(json) as { commit: { html_url: string }; content: { html_url: string } };
  });

export const listInboxIssues = (login: string) =>
  runGh([
    "issue", "list", "--repo", `${login}/${login}`, "--state", "all",
    "--search", "txta-id: in:body", "--limit", "100",
    "--json", "author,createdAt,number,title,url",
  ]).pipe(Effect.map((json) => JSON.parse(json) as InboxIssue[]));

export const getInboxIssue = (login: string, selector: { issueNumber?: number; messageId?: string }) =>
  Effect.gen(function* () {
    let issueNumber = selector.issueNumber;
    if (issueNumber === undefined) {
      const issues = yield* listInboxIssues(login);
      const selected = selector.messageId
        ? yield* runGh([
            "issue", "list", "--repo", `${login}/${login}`, "--state", "all",
            "--search", `txta-id:${selector.messageId} in:body`, "--limit", "1", "--json", "number",
          ]).pipe(Effect.map((json) => (JSON.parse(json) as Array<{ number: number }>)[0]))
        : issues[0];
      if (!selected) return yield* Effect.fail(new GithubError(selector.messageId ? "That sealed letter was not found." : "Your txta inbox is empty."));
      issueNumber = selected.number;
    }
    const json = yield* runGh([
      "issue", "view", String(issueNumber), "--repo", `${login}/${login}`,
      "--json", "body,number,url",
    ]);
    return JSON.parse(json) as { body: string; number: number; url: string };
  });

export const discoverRecipient = (login: string, { ignorePreference = false }: { ignorePreference?: boolean } = {}) =>
  Effect.gen(function* () {
    const [sshJson, preference] = yield* Effect.all([
      runGh(["api", `users/${login}/keys`]),
      ignorePreference ? Effect.succeed(undefined) : getRecipientPreference(login),
    ]);
    const sshApi = JSON.parse(sshJson) as Array<{ id: number; key: string }>;
    const keys: RecipientKey[] = [];
    for (const candidate of sshApi) {
      try {
        const parsed = parseSshKey(candidate.key);
        keys.push({ algorithm: parsed.type, fingerprint: yield* Effect.promise(() => sshFingerprint(candidate.key)), key: candidate.key });
      } catch {
        // GitHub also publishes authentication-only key types that stock age cannot decrypt.
      }
    }
    return {
      keys,
      ...(preference ? { preferredFingerprint: preference.preferredSshFingerprint } : {}),
    };
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
