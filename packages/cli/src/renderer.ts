import { exactEnvelope } from "./envelope.js";

export const canonicalAssets = Object.freeze({
  bannerScroll: "https://assets.txta.dev/i/banner-scroll-2efe9030.png",
  ponyExpress: "https://assets.txta.dev/i/pony-express-d0c3f377.png",
  sealedLetter: "https://assets.txta.dev/i/sealed-letter-d0c3f377.png",
  signoff: "https://assets.txta.dev/i/signoff-d0c3f377.png",
  postmaster: "https://assets.txta.dev/i/postmaster-d0c3f377.png",
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
  const decryptCommand = `npx txtadev read --id ${messageId}`;

  return [
    `<!-- ${marker} -->`,
    `<p align="center"><img src="${canonicalAssets.bannerScroll}" width="820" alt="txta.dev"></p>`,
    "",
    `<img src="${canonicalAssets.postmaster}" width="140" align="right" alt="">`,
    "",
    "# 📬 You've got mail",
    `### Sealed for **@${recipient}** — and only @${recipient}`,
    "",
    "Someone wanted to reach you badly enough to write this where they knew you'd see it, and securely enough that only the matching private key can open it. It was encrypted **on their machine**, to the key you already publish. We couriered a locked box.",
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
    '<sub>txta checks every private key in `~/.ssh` and asks only when a locked key needs its passphrase.<br>',
    `no match? you need the private half of<br>\`${fingerprint}\` from the machine or backup where it was created.</sub>`,
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
