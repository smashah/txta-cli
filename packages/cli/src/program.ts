import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import { Effect } from "effect";
import { normalizeLogin, type CliOptions } from "./args.js";
import { createEncryptedIssue, discoverRecipient, ensureGithubAuth, ensureRecipientRepository, getGithubViewer, getInboxIssue, listInboxIssues, type RecipientKey } from "./github.js";
import { extractFencedEnvelope, verifyRenderedEnvelope } from "./envelope.js";
import { decryptWithLocalSshKeys } from "./identity.js";
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

const chooseKey = (keys: RecipientKey[], fingerprint?: string) =>
  Effect.gen(function* () {
    if (fingerprint) {
      const selected = keys.find((key) => key.fingerprint === fingerprint);
      if (!selected) return yield* Effect.fail(new Error("The selected key is no longer published. Check the recipient again before sending."));
      return selected;
    }
    return keys[0]!;
  });

export const sendProgram = (options: CliOptions) =>
  Effect.gen(function* () {
    yield* ensureGithubAuth;
    const login = normalizeLogin(options.login ?? (yield* prompt("GitHub username to reach: ")));
    const discovery = yield* discoverRecipient(login);
    if (discovery.keys.length === 0) {
      const gpgNote = discovery.gpgCount > 0
        ? ` GitHub publishes ${discovery.gpgCount} GPG key${discovery.gpgCount === 1 ? "" : "s"}, but the frozen txta issue transport currently requires SSH Ed25519 or RSA.`
        : "";
      return yield* Effect.fail(new Error(`@${login} has no SSH key that txta can encrypt for.${gpgNote}`));
    }
    const key = yield* chooseKey(discovery.keys, options.fingerprint);
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
