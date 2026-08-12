import { spawn } from "node:child_process";
import { Effect } from "effect";
import { LEGACY_RECIPIENT_PREFERENCE_PATH, parseRecipientPreference, RECIPIENT_PREFERENCE_PATH, serializeRecipientPreference, type RecipientPreference } from "./preference.js";
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

const preferenceEndpoint = (login: string, path = RECIPIENT_PREFERENCE_PATH) => `repos/${login}/${login}/contents/${path}`;

const getPreferenceFileAt = (login: string, path: string) =>
  runGh(["api", preferenceEndpoint(login, path)]).pipe(
    Effect.map((json) => ({ ...JSON.parse(json) as GithubContent, path })),
    Effect.catch((error) => /(?:HTTP )?404|Not Found/iu.test(error.message) ? Effect.succeed(undefined) : Effect.fail(error)),
  );

export const getRecipientPreferenceState = (login: string, { allowInvalid = false }: { allowInvalid?: boolean } = {}) =>
  Effect.gen(function* () {
    const [currentFile, legacyFile] = yield* Effect.all([
      getPreferenceFileAt(login, RECIPIENT_PREFERENCE_PATH),
      getPreferenceFileAt(login, LEGACY_RECIPIENT_PREFERENCE_PATH),
    ]);
    const file = currentFile ?? legacyFile;
    const legacyExists = legacyFile !== undefined;
    if (!file) return { file: undefined, legacyExists, preference: undefined };
    try {
      return {
        file,
        legacyExists,
        preference: parseRecipientPreference(Buffer.from(file.content, file.encoding).toString("utf8")),
      };
    } catch {
      if (allowInvalid) return { file, legacyExists, preference: undefined };
      return yield* Effect.fail(new GithubError(`@${login}'s ${file.path} is invalid. Ask them to run npx txtadev set again.`));
    }
  });

export const getRecipientPreference = (login: string) =>
  getRecipientPreferenceState(login).pipe(Effect.map((state) => state.preference));

const readmeEndpoint = (login: string) => `repos/${login}/${login}/contents/README.md`;

export const getProfileReadme = (login: string) =>
  runGh(["api", readmeEndpoint(login)]).pipe(
    Effect.map((json) => JSON.parse(json) as GithubContent),
    Effect.map((file) => ({ contents: Buffer.from(file.content, file.encoding).toString("utf8"), sha: file.sha })),
    Effect.catch((error) => /(?:HTTP )?404|Not Found/iu.test(error.message)
      ? Effect.succeed({ contents: "", sha: undefined })
      : Effect.fail(error)),
  );

export const getProfileHead = (login: string) =>
  Effect.gen(function* () {
    const repository = JSON.parse(yield* runGh(["api", `repos/${login}/${login}`])) as { default_branch: string };
    const oid = yield* runGh(["api", `repos/${login}/${login}/git/ref/heads/${encodeURIComponent(repository.default_branch)}`, "--jq", ".object.sha"]);
    return { branch: repository.default_branch, oid };
  });

export const commitProfileFiles = (
  login: string,
  { branch, deletions = [], files, message, oid }: { branch: string; deletions?: string[]; files: Array<{ contents: string; path: string }>; message: string; oid: string },
) => {
  const query = "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { url } } }";
  const payload = JSON.stringify({
    query,
    variables: {
      input: {
        branch: { branchName: branch, repositoryNameWithOwner: `${login}/${login}` },
        expectedHeadOid: oid,
        fileChanges: {
          additions: files.map((file) => ({ contents: Buffer.from(file.contents).toString("base64"), path: file.path })),
          ...(deletions.length > 0 ? { deletions: deletions.map((path) => ({ path })) } : {}),
        },
        message: { headline: message },
      },
    },
  });
  return runGh(["api", "graphql", "--input", "-"], payload).pipe(
    Effect.mapError((error) => new GithubError(`GitHub could not commit the txta profile changes. ${error.message}`)),
    Effect.map((json) => (JSON.parse(json) as { data: { createCommitOnBranch: { commit: { url: string } } } }).data.createCommitOnBranch.commit),
  );
};

export const updateRecipientPreference = (login: string, update: (current: RecipientPreference | undefined) => Omit<RecipientPreference, "version">) => {
  const attempt = Effect.gen(function* () {
    const head = yield* getProfileHead(login);
    const current = yield* getRecipientPreferenceState(login, { allowInvalid: true });
    const next = update(current.preference);
    const contents = serializeRecipientPreference(next.preferredSshFingerprint, next.blocked ? { blocked: true } : {});
    const commit = yield* commitProfileFiles(login, {
      ...head,
      deletions: current.legacyExists ? [LEGACY_RECIPIENT_PREFERENCE_PATH] : [],
      files: [{ contents, path: RECIPIENT_PREFERENCE_PATH }],
      message: next.blocked ? "chore: block txta.dev messages" : "chore: update txta.dev settings",
    });
    return { commit, preference: { ...next, version: 1 as const } };
  });
  return attempt;
};

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

export const discoverRecipient = (login: string, { ignoreConfig = false }: { ignoreConfig?: boolean } = {}) =>
  Effect.gen(function* () {
    const [sshJson, preference] = yield* Effect.all([
      runGh(["api", `users/${login}/keys`]),
      ignoreConfig ? Effect.succeed(undefined) : getRecipientPreference(login),
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
      ...(preference?.blocked ? { blocked: true as const } : {}),
      ...(preference?.preferredSshFingerprint ? { preferredFingerprint: preference.preferredSshFingerprint } : {}),
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
