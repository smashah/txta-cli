import { exactEnvelope } from "./envelope.js";

export const canonicalAssets = Object.freeze({
  bannerScroll: "https://raw.githubusercontent.com/smashah/smashah/2efe9030981e69e00bbb9e3247e3366fac23d156/img/txta/banner-scroll.png",
  ponyExpress: "https://raw.githubusercontent.com/smashah/smashah/d0c3f3777e1c9ebb972eff6dfa8979797e6ddf40/img/txta/pony-express.png",
  sealedLetter: "https://raw.githubusercontent.com/smashah/smashah/d0c3f3777e1c9ebb972eff6dfa8979797e6ddf40/img/txta/sprite-d.png",
  signoff: "https://raw.githubusercontent.com/smashah/smashah/d0c3f3777e1c9ebb972eff6dfa8979797e6ddf40/img/txta/sprite-b.png",
  postmaster: "https://raw.githubusercontent.com/smashah/smashah/d0c3f3777e1c9ebb972eff6dfa8979797e6ddf40/img/txta/sprite-e.png",
});

const fence = (language: string, content: string) => [language ? `\`\`\`${language}` : "```", content, "```"].join("\n");

export function renderCanonicalIssue({
  ciphertext,
  fingerprint,
  messageId,
  recipient,
}: {
  ciphertext: string;
  fingerprint: string;
  messageId: string;
  recipient: string;
}) {
  const envelope = exactEnvelope(ciphertext);
  const marker = `txta-id:${messageId}`;
  const repo = `${recipient}/${recipient}`;
  const decryptCommand = [
    `gh issue view "$(gh issue list --repo ${repo} --state all --search '${marker} in:body' --json number --jq '.[0].number')" -R ${repo} --json body -q .body \\`,
    "  | awk '/^-----BEGIN AGE/{f=1} f{print} /^-----END AGE/{exit}' \\",
    "  | age -d -i ~/.ssh/id_ed25519",
  ].join("\n");

  return [
    `<!-- ${marker} -->`,
    `<p align="center"><img src="${canonicalAssets.bannerScroll}" width="820" alt="txta.dev"></p>`,
    "",
    `<img src="${canonicalAssets.postmaster}" width="140" align="right" alt="">`,
    "",
    "# 📬 You've got mail",
    `### Sealed for **@${recipient}** — and only @${recipient}`,
    "",
    "Someone wanted to reach you badly enough to write this where they knew you'd see it, and privately enough that no one else ever will. It was encrypted **in their browser**, to the key you already publish. We couriered a locked box.",
    "",
    '<br clear="all">',
    "",
    "**Open it** *(this is the whole thing)*:",
    "",
    fence("bash", decryptCommand),
    "",
    `<img src="${canonicalAssets.ponyExpress}" width="96" align="left" alt="">`,
    "",
    "&nbsp;",
    '<sub>missing `age`? → `brew install age` &nbsp;·&nbsp; no `gh`? open the sealed letter below, copy it, `pbpaste | age -d -i ~/.ssh/id_ed25519`<br>',
    `wrong key? \`ssh-keygen -lf ~/.ssh/id_ed25519.pub\` should print<br>\`${fingerprint}\`</sub>`,
    "",
    '<br clear="all">',
    "",
    "<details>",
    `<summary><img src="${canonicalAssets.sealedLetter}" width="42" align="top" alt=""> &nbsp;<b>The Sealed Letter!</b></summary>`,
    "",
    fence("", envelope),
    "",
    "</details>",
    "",
    "---",
    "",
    '<sub><b><a href="https://txta.dev">txta.dev</a></b> — message any developer, no app, no permissions, no way for us to read it. <i>This issue is yours: keep it, close it, burn it.</i></sub> ' +
      `<img src="${canonicalAssets.signoff}" width="40" align="right" alt="">`,
    "",
  ].join("\n");
}
