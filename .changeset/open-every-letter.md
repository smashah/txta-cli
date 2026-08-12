---
"@txtadev/cli": patch
"txtadev": patch
---

Open sealed letters with `txtadev inbox` and `txtadev read`. The bundled reader uses the issue fingerprint to try the likely SSH key first, falls back across local keys, and prompts for locked keys without requiring `age` or a fixed key filename.
