const armor = {
  ssh: {
    begin: "-----BEGIN AGE ENCRYPTED FILE-----",
    end: "-----END AGE ENCRYPTED FILE-----",
  },
} as const;

export function exactEnvelope(value: string) {
  const lines = value.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== armor.ssh.begin || lines.at(-1) !== armor.ssh.end) {
    throw new Error("Ciphertext must contain the AGE envelope and nothing before or after it");
  }
  if (
    lines.filter((line) => line === armor.ssh.begin).length !== 1 ||
    lines.filter((line) => line === armor.ssh.end).length !== 1
  ) {
    throw new Error("Ciphertext must contain exactly one AGE envelope");
  }
  return lines.join("\n");
}

export function extractFencedEnvelope(markdown: string) {
  const blocks = [...markdown.replaceAll("\r\n", "\n").matchAll(/```[A-Za-z0-9_-]*\n([\s\S]*?)\n```/gu)]
    .map((match) => match[1])
    .filter((block): block is string => block?.startsWith(armor.ssh.begin) ?? false);
  if (blocks.length !== 1) {
    throw new Error(`Rendered artifact must have one sealed fence; found ${blocks.length}`);
  }
  return exactEnvelope(blocks[0]!);
}

export function verifyRenderedEnvelope(markdown: string, ciphertext: string) {
  const expected = exactEnvelope(ciphertext);
  if (extractFencedEnvelope(markdown) !== expected) {
    throw new Error("Rendered sealed fence changed the ciphertext envelope");
  }
  return expected;
}
