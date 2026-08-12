import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import { homedir } from "node:os";
import { Effect } from "effect";
import { normalizeLogin, type CliOptions } from "./args.js";
import { commitProfileFiles, createEncryptedIssue, discoverRecipient, ensureGithubAuth, ensureRecipientRepository, getGithubViewer, getInboxIssue, getProfileHead, getProfileReadme, getRecipientPreference, getRecipientPreferenceState, listInboxIssues, updateRecipientPreference } from "./github.js";
import { extractFencedEnvelope, verifyRenderedEnvelope } from "./envelope.js";
import { decryptWithLocalSshKeys, listLocalSshKeys } from "./identity.js";
import { intersectPublishedKeys, LEGACY_RECIPIENT_PREFERENCE_PATH, RECIPIENT_PREFERENCE_PATH, resolveRecipientKey, selectRecipientKey, serializeRecipientPreference, upsertReadmeFooter } from "./preference.js";
import { renderCanonicalIssue } from "./renderer.js";
import { encryptForSsh } from "./ssh.js";

const prompt = (question: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => createInterface({ input: stdin, output: stdout })),
    (terminal) => Effect.promise(() => terminal.question(question)),
    (terminal) => Effect.sync(() => terminal.close()),
  );

const promptPassphrase = async (path: string) => {
  if (!stdin.isTTY) return "";
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) stdout.write(chunk);
      callback();
    },
  });
  const terminal = createInterface({ input: stdin, output, terminal: true });
  const answer = terminal.question(`Passphrase for ${path} (leave blank to skip): `);
  muted = true;
  try {
    return await answer;
  } finally {
    muted = false;
    terminal.close();
    stdout.write("\n");
  }
};

const fingerprintFromIssue = (body: string) => {
  const match = body.match(/SHA256:[A-Za-z\d+/]+/u);
  if (!match) throw new Error("The sealed letter does not name its recipient key fingerprint.");
  return match[0];
};

const readPipedMessage = () =>
  Effect.promise(async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").replace(/\n$/u, "");
  });

export function parseConfirmation(value: string) {
  const answer = value.trim().toLowerCase();
  if (answer === "" || answer === "y" || answer === "yes") return true;
  if (answer === "n" || answer === "no") return false;
  throw new Error("Enter y or n.");
}

export const sendProgram = (options: CliOptions) =>
  Effect.gen(function* () {
    yield* ensureGithubAuth;
    const login = normalizeLogin(options.login ?? (yield* prompt("GitHub username to reach: ")));
    const discovery = yield* discoverRecipient(login);
    if (discovery.blocked) {
      return yield* Effect.fail(new Error(`@${login} is not accepting txta messages.`));
    }
    if (discovery.keys.length === 0) {
      return yield* Effect.fail(new Error(`@${login} has no SSH Ed25519 or RSA key that txta can encrypt for.`));
    }
    const key = yield* Effect.try({
      try: () => resolveRecipientKey(discovery.keys, {
        ...(options.fingerprint ? { explicitFingerprint: options.fingerprint } : {}),
        ...(discovery.preferredFingerprint ? { preferredFingerprint: discovery.preferredFingerprint } : {}),
        recipient: login,
      }),
      catch: (error) => error instanceof Error ? error : new Error(String(error)),
    });
    console.log(`Recipient: @${login}`);
    console.log(`Key: ${key.algorithm} ${key.fingerprint}`);

    const message = (options.message ?? (stdin.isTTY ? yield* prompt("Message: ") : yield* readPipedMessage())).trim();
    if (!message) return yield* Effect.fail(new Error("The message cannot be empty."));
    if (message.length > 20_000) return yield* Effect.fail(new Error("The message is over the 20,000 character limit."));

    yield* ensureRecipientRepository(login);
    const ciphertext = yield* Effect.promise(() => encryptForSsh(message, key.key));
    const body = renderCanonicalIssue({ ciphertext, fingerprint: key.fingerprint, messageId: crypto.randomUUID(), recipient: login });
    verifyRenderedEnvelope(body, ciphertext);

    if (options.dryRun) {
      console.log("Dry run passed: the exact canonical issue contains one verified AGE envelope.");
      return { body, dryRun: true as const };
    }

    const issue = yield* createEncryptedIssue(login, body);
    console.log(`Delivered: ${issue.html_url}`);
    return { dryRun: false as const, issue };
  });

export const setProgram = Effect.gen(function* () {
  yield* ensureGithubAuth;
  const login = yield* getGithubViewer;
  yield* ensureRecipientRepository(login);
  const discovery = yield* discoverRecipient(login, { ignoreConfig: true });
  if (discovery.keys.length === 0) {
    return yield* Effect.fail(new Error(`@${login} has no public SSH Ed25519 or RSA keys on GitHub.`));
  }
  const localKeys = yield* Effect.tryPromise({
    try: () => listLocalSshKeys({
      expectedFingerprints: discovery.keys.map((key) => key.fingerprint),
      promptPassphrase,
      verifyLocked: true,
    }),
    catch: (error) => error instanceof Error ? error : new Error(String(error)),
  });
  const matches = intersectPublishedKeys(discovery.keys, localKeys);
  if (matches.length === 0) {
    return yield* Effect.fail(new Error("None of your supported public GitHub keys has a usable private key in ~/.ssh on this machine."));
  }
  console.log(`txta keys for @${login}`);
  for (const [index, key] of matches.entries()) {
    const localPath = key.localPath.startsWith(`${homedir()}/`) ? key.localPath.replace(homedir(), "~") : key.localPath;
    console.log(`${index + 1}.  ${key.algorithm}  ${key.fingerprint}  ${localPath}`);
  }
  const answer = (yield* prompt(`Key number to use${matches.length === 1 ? " [1]" : ""}: `)).trim();
  const selectedIndex = answer === "" && matches.length === 1 ? 0 : Number(answer) - 1;
  const selected = matches[selectedIndex];
  if (!selected) return yield* Effect.fail(new Error("Choose a key number from the list above."));
  const readmeAnswer = yield* prompt("Shall we add the txta command in the footer of your README? [Y/n]: ");
  const addReadme = yield* Effect.try({
    try: () => parseConfirmation(readmeAnswer),
    catch: (error) => error instanceof Error ? error : new Error(String(error)),
  });
  const changeLabel = addReadme ? "this preference and README footer" : "this preference";
  const confirmation = yield* prompt(`Commit ${changeLabel} to github.com/${login}/${login} now? [Y/n]: `);
  const shouldSave = yield* Effect.try({
    try: () => parseConfirmation(confirmation),
    catch: (error) => error instanceof Error ? error : new Error(String(error)),
  });
  if (!shouldSave) {
    console.log("Nothing changed.");
    return { cancelled: true as const };
  }
  const head = yield* getProfileHead(login);
  const currentState = yield* getRecipientPreferenceState(login, { allowInvalid: true });
  const current = currentState.preference;
  const nextPreference = selectRecipientKey(selected.fingerprint, current);
  const config = serializeRecipientPreference(nextPreference.preferredSshFingerprint, nextPreference.blocked ? { blocked: true } : {});
  const files = [{ contents: config, path: RECIPIENT_PREFERENCE_PATH }];
  if (addReadme) {
    const readme = yield* getProfileReadme(login);
    files.push({ contents: upsertReadmeFooter(readme.contents, login), path: "README.md" });
  }
  const saved = yield* commitProfileFiles(login, {
    ...head,
    deletions: currentState.legacyExists ? [LEGACY_RECIPIENT_PREFERENCE_PATH] : [],
    files,
    message: addReadme ? "chore: configure txta.dev profile" : "chore: set txta.dev recipient key",
  });
  if (addReadme) {
    console.log(`README footer added: npx txtadev ${login}`);
  }
  console.log(`Preferred key saved: ${selected.fingerprint}`);
  if (current?.blocked) console.log("Your existing txta block remains enabled.");
  console.log(`Commit: ${saved.url}`);
  return { cancelled: false as const, fingerprint: selected.fingerprint, url: saved.url };
});

export const blockProgram = Effect.gen(function* () {
  yield* ensureGithubAuth;
  const login = yield* getGithubViewer;
  yield* ensureRecipientRepository(login);
  const current = yield* getRecipientPreference(login).pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (current?.blocked) {
    console.log(`@${login} is already blocking txta messages.`);
    return { alreadyBlocked: true as const };
  }
  const confirmation = yield* prompt(`Block new txta messages for @${login}? [Y/n]: `);
  const shouldBlock = yield* Effect.try({
    try: () => parseConfirmation(confirmation),
    catch: (error) => error instanceof Error ? error : new Error(String(error)),
  });
  if (!shouldBlock) {
    console.log("Nothing changed.");
    return { cancelled: true as const };
  }
  const saved = yield* updateRecipientPreference(login, (fresh) => ({
    blocked: true,
    ...(fresh?.preferredSshFingerprint ? { preferredSshFingerprint: fresh.preferredSshFingerprint } : {}),
  }));
  console.log(`Blocked: official txta send paths will refuse new messages for @${login}.`);
  console.log(`Commit: ${saved.commit.url}`);
  return { blocked: true as const, url: saved.commit.url };
});

export const readProgram = ({ issueNumber, messageId }: { issueNumber?: number; messageId?: string }) =>
  Effect.gen(function* () {
    yield* ensureGithubAuth;
    const login = yield* getGithubViewer;
    const issue = yield* getInboxIssue(login, { ...(issueNumber === undefined ? {} : { issueNumber }), ...(messageId === undefined ? {} : { messageId }) });
    const ciphertext = extractFencedEnvelope(issue.body);
    const expectedFingerprint = fingerprintFromIssue(issue.body);
    const plaintext = yield* Effect.tryPromise({
      try: () => decryptWithLocalSshKeys({ ciphertext, expectedFingerprint, promptPassphrase }),
      catch: (error) => error instanceof Error ? error : new Error(String(error)),
    });
    console.log(plaintext);
    return { issue, plaintext };
  });

export const inboxProgram = Effect.gen(function* () {
  yield* ensureGithubAuth;
  const login = yield* getGithubViewer;
  const issues = yield* listInboxIssues(login);
  if (issues.length === 0) return yield* Effect.fail(new Error("Your txta inbox is empty."));
  console.log(`txta inbox for @${login}`);
  for (const issue of issues) {
    const date = new Date(issue.createdAt).toLocaleDateString();
    console.log(`#${issue.number}  ${date}  from @${issue.author?.login ?? "unknown"}`);
  }
  const answer = yield* prompt("Issue number to open: ");
  const issueNumber = Number(answer.replace(/^#/u, ""));
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0 || !issues.some((issue) => issue.number === issueNumber)) {
    return yield* Effect.fail(new Error("Choose an issue number from the inbox above."));
  }
  return yield* readProgram({ issueNumber });
});
