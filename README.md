# pi-context-scribe

An independent compaction extension for [Pi](https://pi.dev). The intended
capability is to keep your chosen coding model while using a separately
configured model to summarize conversation history, including an on-prem model.

**Status: package scaffold only (`0.1.0`).** Compaction is not implemented. The
extension currently registers no handlers, commands or tools, makes no model
calls, and leaves Pi's existing compaction behavior unchanged. Summary quality,
cost savings and on-prem routing have not been evaluated.

## Development

Requires Node.js **22.19 or newer** and npm. The development dependency pins Pi
**1.3.0**, matching the setup baseline; this is not a compatibility claim for
other releases. Pi supplies the runtime package when loading extensions, so it
is a peer dependency rather than a bundled runtime dependency.

```sh
npm ci --ignore-scripts
npm run check
```

`check` type-checks the TypeScript source and tests, then runs the Node test
runner. The setup tests confirm that the no-op factory does not access Pi's API
and that Pi's real extension loader accepts it. The loader test uses temporary
working and agent directories in offline mode, without accessing your configured
credentials or running a provider request. These are scaffold checks, not
compaction or live-session acceptance tests. The scaffold was checked with
Node.js 26.10.0 and Pi 1.3.0; the minimum Node.js version has not been exercised.

Pi loads the TypeScript source directly; no build step is required. To inspect
the package contents without publishing:

```sh
npm pack --dry-run
```

## Local loading

After installing the development dependencies, try the package for one Pi
invocation from the repository root:

```sh
pi --no-extensions --extension .
```

`--no-extensions` disables discovered/configured extensions while the explicit
package still loads. This does not install the package or change saved Pi
settings. It currently adds no visible behavior and does not replace compaction.
Avoid enabling multiple compaction handlers when implementing and testing that
feature. Extensions execute with Pi's operating-system permissions; review code
before loading it.

The package is marked `private` to prevent accidental npm publication.

## License

[MIT](LICENSE), copyright 2026 thias.
