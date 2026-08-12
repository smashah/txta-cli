# @txtadev/cli

The implementation package behind [`npx txtadev`](https://www.npmjs.com/package/txtadev).

```bash
npx @txtadev/cli smashah hi
npx @txtadev/cli inbox
npx @txtadev/cli read 6
npx @txtadev/cli set
npx @txtadev/cli block
npx @txtadev/cli help
```

The bundled reader tries the expected SSH key first, then every supported private key in `~/.ssh`, so recipients do not need the `age` command or a specific key filename.

`set` publishes the fingerprint of a verified local-and-GitHub key in `.github/txta.jsonc` and can add the contact command to the profile README. `block` adds the public `blocked: true` preference so official txta send paths refuse new delivery. Both commands ask before committing through the authenticated GitHub CLI session.

See the [repository README](https://github.com/smashah/txta-cli#readme) for the complete flow.
