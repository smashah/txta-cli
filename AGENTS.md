# AGENTS.md

This repository ships the public txta.dev command-line client.

- Preserve Effect and use it for fallible process and network boundaries.
- `@txtadev/cli` owns every product behavior. The unscoped `txtadev` package is an exact-version forwarder only.
- Keep the two package versions in lockstep and run `pnpm run check:lockstep` before release.
- Never publish from a developer machine. `.github/workflows/release.yml` owns npm publication.
- Never send plaintext to txta.dev. Encryption and GitHub issue creation run on the sender's machine through their authenticated `gh` CLI.
- The canonical issue renderer is frozen from ALFRED commit `8cd95a6`; preserve its envelope guard and one-post/no-edit behavior.

Before finishing any session that changes this repository, run:

```bash
~/projects/ALFRED/scripts/log-work.sh \
  --what "one-line summary of what changed" \
  --goal "what was requested" \
  --status done|partial|blocked \
  --follow-up "what remains"
```

Commit and push finished work.
