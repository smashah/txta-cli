import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Effect } from "effect";
import { normalizeLogin, type CliOptions } from "./args.js";
import { createEncryptedIssue, discoverRecipient, ensureGithubAuth, ensureRecipientRepository, type RecipientKey } from "./github.js";
import { renderCanonicalIssue } from "./renderer.js";
import { encryptForSsh } from "./ssh.js";
import { verifyRenderedEnvelope } from "./envelope.js";

const prompt = (question: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => createInterface({ input: stdin, output: stdout })),
    (terminal) => Effect.promise(() => terminal.question(question)),
    (terminal) => Effect.sync(() => terminal.close()),
  );

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
    if (keys.length === 1) return keys[0]!;
    console.log("\nPublished keys:");
    keys.forEach((key, index) => console.log(`  ${index + 1}. ${key.algorithm}  ${key.fingerprint}`));
    const answer = yield* prompt("Choose a key: ");
    const selected = keys[Number.parseInt(answer, 10) - 1];
    if (!selected) return yield* Effect.fail(new Error("Choose one of the listed keys."));
    return selected;
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

    if (!options.yes) {
      const confirmation = yield* prompt(`Post one encrypted issue to ${login}/${login}? [y/N] `);
      if (!/^y(?:es)?$/iu.test(confirmation.trim())) return yield* Effect.fail(new Error("Send cancelled."));
    }

    const issue = yield* createEncryptedIssue(login, body);
    console.log(`Delivered: ${issue.html_url}`);
    return { dryRun: false as const, issue };
  });
