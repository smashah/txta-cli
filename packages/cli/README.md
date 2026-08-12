# @txtadev/cli

The implementation package behind [`npx txtadev`](https://www.npmjs.com/package/txtadev).

```bash
npx @txtadev/cli smashah hi
npx @txtadev/cli inbox
npx @txtadev/cli read 6
npx @txtadev/cli set
```

The bundled reader tries the expected SSH key first, then every supported private key in `~/.ssh`, so recipients do not need the `age` command or a specific key filename.

`set` publishes the fingerprint of a verified local-and-GitHub key in the recipient's own profile repository so future senders choose the decryptable key automatically.

See the [repository README](https://github.com/smashah/txta-cli#readme) for the complete flow.
