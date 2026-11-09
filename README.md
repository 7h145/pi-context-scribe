# pi-context-scribe

Use a separately configured model to compact [Pi](https://pi.dev) conversations
without changing your coding model. Prefer a model that is cheaper for you,
faster, or available on premises. Inside Pi the extension calls itself
**context-scribe**.

When the prepared input fits, context-scribe summarizes it directly. Otherwise,
it processes chronological chunks independently and synthesizes their notes with
the previous summary. It preserves Pi's retained-history boundary. Chunking stays
on your preferred model; it is not a reason to fall back.

**Status: initial implementation, ready for local dogfooding.** Automated checks
use mocked requests and offline SDK providers. Initial dogfooding confirms
direct DeepSeek compaction and configured fallback; broader summary quality
and timeout calibration remain unconfirmed.

## Configuration

Create `pi-context-scribe.json` in either location:

- Global: `<getAgentDir()>/pi-context-scribe.json`, following Pi's configured
  agent directory (normally `~/.pi/agent`).
- Project: `<cwd>/.pi/pi-context-scribe.json`, read only in a trusted project.

The only required setting is the ordered model list:

```json
{
  "models": [
    "my-provider/preferred-model",
    "another-provider/fallback-model"
  ]
}
```

Models must already be registered with Pi. Model IDs may contain additional
slashes. Keep endpoints, credentials and provider-specific thinking mappings in
Pi's own configuration; this extension does not store credentials.

All other settings are optional. For example:

```json
{
  "models": [
    { "model": "my-provider/preferred-model", "thinking": "low" },
    "another-provider/fallback-model"
  ],
  "defaultThinking": "low",
  "timeout": {
    "baseMs": 45000,
    "msPer1000InputTokens": 250
  }
}
```

Thinking resolves as **per-model setting → `defaultThinking` → `low`**. Levels
are Pi's `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`. Pi clamps
unsupported levels and maps the effective level through the model definition and
provider adapter. The coding model's thinking setting is unchanged.

Project `models` replaces the global list, not appends to it. Other project
settings override the corresponding global fields; omitted fields retain their
defaults or inherited values. An empty model list selects ordinary Pi compaction.
Missing configuration also leaves compaction to Pi. Invalid configuration warns
and delegates to Pi rather than blocking unattended work. Configuration is never
rewritten. Edits take effect on `/reload` or fresh session activation.

## Status

Use any of these equivalent commands:

```text
/context-scribe
/context-scribe status
/context-scribe s
```

The notification shows the loaded extension version, the configured model chain,
Pi thinking levels and the current compaction route (the next candidate to try).
An arrow marks that route; earlier entries are marked skipped until reset. The
chain includes Pi's built-in fallback, identifying the selected coding model.
Unregistered model IDs and clamped thinking levels are labelled explicitly.

Status reads only in-memory configuration/routing and Pi's local model registry.
It does not probe authentication or provider availability, send a model request,
reload configuration or change the route. Use `/reload` to apply edits and reset
the order.

The version header includes a short Git HEAD when the package has its own
checkout, for example `context-scribe: v0.1.0 (1234abc)`. It never borrows the
parent workspace's revision. Identity is cached once per loaded extension runtime
at session startup; status does not run Git. The optional read-only Git lookup
has a 500 ms limit and falls back to version-only if Git is absent or fails.
The hash identifies committed HEAD, not uncommitted source edits.

## Fallback and visibility

Each compaction starts at the session's current route. If a model fails, the
extension advances to the next configured model. This is **sticky**: subsequent
compactions do not retry earlier failed candidates. After exhausting the list,
it hands control back to **Pi's actual built-in compaction**, also sticky.

`/reload`, starting a new session, or switching/resuming/forking a session resets
the order. Routing state is not saved to disk. Restore VPN access, for example,
and `/reload` to retry your preferred model.

The extension prints a notification before each attempt and a warning on failure.

### Reading the completion widget

After a successful context-scribe compaction, a temporary line above the editor
shows which model produced the summary and how much work the compaction took:

```text
context-scribe: DeepSeek-V4.1-Flash-1017 · direct · 28.1s ↑44k ↓4,319 R43k
```

Read this example as: DeepSeek summarized the prepared history in one request.
The whole operation took 28.1 seconds and used about 44,000 input tokens,
including about 43,000 read from the provider's cache, and 4,319 output tokens.

| Part | Meaning |
|---|---|
| `DeepSeek-V4.1-Flash-1017` | The model that produced the installed summary, without its provider/path prefix. |
| `direct` | The prepared history fit in one summary request. Otherwise, `chunked (3ch/4req)` means three source chunks and four requests on the successful model, including synthesis. Extra reduction steps can require more requests. |
| `28.1s` | Elapsed time for the whole operation, including earlier failed model attempts—not just the successful request. |
| `↑44k` | Total reported input tokens, **including cache reads and writes**. This is input to compaction requests, not Pi's before-compaction conversation size. |
| `↓4,319` | Reported output tokens, including reasoning tokens when the provider includes them in output usage. |
| `R43k` | Input tokens reported as read from the provider's prompt cache. These are already included in `↑`, not additional tokens. |
| `W2.0k` (when present) | Input tokens reported as written to the provider's prompt cache. These are also already included in `↑`. |

**`R` and `W` are omitted independently when their reported counts are zero.**
There is no `W` in the example because no cache writes were reported. That does
not prove the provider stored nothing; some services do not report writes
separately. This is provider-side caching, not a cache maintained by context-scribe.
The labels match Pi's footer, but the input total differs: Pi's `↑` excludes
cache reads/writes; context-scribe's `↑` includes them. The widget does not show
Pi's `CH` cache-hit percentage.

Input and cache counts use Pi's rounded `k` (thousands) and `M` (millions)
notation: for example, 111,959 becomes `112k`. Output stays exact with commas
through 9,999, then uses the same compact format. Display rounding does not
change the exact usage saved with the compaction.

Time and reported usage include earlier failed candidates; chunk/request counts
refer only to the successful candidate. If some requests returned no usable
usage, the line ends with **`usage partial`**: the shown counts cover only the
reported portion. If no usable usage was returned, **`usage unavailable`**
replaces the token counts. Neither label means the compaction failed. Missing
usage is not treated as zero, and provider-internal retries may consume
unreported tokens.

The widget survives Pi's chat redraw. It is separate from the footer and needs
no compositor. If compaction happens during a response, the widget stays visible
through the rest of that response and while you read it or type your next message.
It clears only after you send your next message and Pi finishes responding,
including all tool steps and automatic continuations. The same rule applies after
manual `/compact` while idle: it stays until the response to your next message
finishes. Extension-generated messages do not count as your next message.

Another compaction clears the old widget and, on success, shows fresh statistics
with a new lifetime. Reloading or changing/closing the session also clears it.
Status commands do not clear it, and the widget never enters the model's context
or session transcript.

Model labels use the last `/`-separated component, shortened in the middle when
space is tight so the beginning and version suffix stay visible. Full model
identifiers remain available through `/context-scribe`. The widget adapts to
terminal width; very narrow windows may clip the remaining text with an ellipsis.

RPC clients receive a normal completion notification instead of a terminal
widget. The pre-compaction notification is retained in either mode.

### Built-in handoff

On built-in fallback it prints only:

```text
context-scribe: handing over to Pi's built-in compaction
```

There is **no trailing context-scribe line or widget**. Any previous widget is
cleared when compaction starts. Completion, failure, usage and recovery are
Pi's business from that point onward. Pi's saved entry contains its own
compactor's usage, not earlier failed extension attempts.

**Built-in fallback can use your expensive or off-prem coding-model route.**
Availability takes precedence after configured routes fail. The extension does
not promise success if Pi's default provider also fails. User cancellation stops
compaction instead of triggering another provider request.

## Timeouts

Each individual summary request gets a base allowance plus additional time
proportional to its estimated input size:

```text
timeoutMs = baseMs + msPer1000InputTokens × estimatedInputTokens / 1000
```

The defaults are **45 seconds plus 250 milliseconds per 1,000 input
tokens**: 70 seconds for 100k estimated input tokens, or 170 seconds for 500k.
These are provisional allowances, not measured inference speeds.

The same rule and base allowance apply to a direct summary, each source chunk,
intermediate reductions and final synthesis. Estimates include instructions and
other request input, not the coding session's headline context size. Provider
retries, if any, share that request's deadline; there is no extension retry loop.
There is no additional whole-compaction deadline. Pi's built-in fallback uses
Pi's own timeout handling, unaffected by this setting.

Both timeout fields are optional, independently. `baseMs` must be positive;
`msPer1000InputTokens` must be nonnegative. Set the latter to `0` for a fixed
per-request timeout.

## What gets summarized

Pi chooses the discarded span and recent retained messages. Context-scribe uses
that preparation, includes any split-turn prefix and carries forward the previous
summary. Current `/compact …` guidance is separate from historical evidence.

To bound tool evidence, it retains:

- Tool argument values up to **1,000 characters**; longer values keep the prefix.
- Tool results up to **2,000 characters**; longer results keep the first and last
  **1,000 characters**, with an explicit omission marker.
- Tool identity and supplied error status outside those excerpts. A tool call
  alone is not proof that a change succeeded.

Thinking and image payloads are omitted, as in Pi's text-summary baseline.
Text omitted by the original tool cannot be recovered here. No live files are
read to reconstruct historical results, and the summarizer gets no tools.

Request sizing follows the selected model's window, Pi's generation-budget logic
and a 10% context safety margin, respecting Pi 1.3.0's internal 4,096-token
headroom floor on smaller windows. Token estimates are approximate; provider
adapters may further adjust output/thinking budgets. There is no independent
numeric summary-text target or character-limit rejection of completed output.

If chunk notes do not fit synthesis, they are reduced in chronological groups.
A reduction must shrink; otherwise that model attempt fails rather than loops.
A failed chunk or incomplete generation installs nothing: the next candidate
restarts from the original prepared input without reusing partial notes. A prior
summary or instructions too large to fit cannot be silently dropped; that
candidate fails and routing continues.

## Local loading and development

Requires Node.js **22.19 or newer** and npm. Development pins Pi **1.3.0**; other
releases and the minimum Node version have not been exercised. Pi supplies the
runtime packages; no build step is needed.

```sh
npm ci --ignore-scripts
npm run check
```

Checks run offline with temporary directories, fake providers and mocked clocks.
They cover configuration, excerpts, request budgets, direct/chunked paths,
cancellation, sticky fallback, repeated compaction, the real extension loader,
Pi's manual/automatic compaction lifecycle, and native UI redraw/widget lifetime. They do not establish summary
quality or live provider compatibility.

Load explicitly for an isolated invocation:

```sh
pi --no-extensions --extension /absolute/path/to/pi-context-scribe
```

Or link into a trusted project's `.pi/extensions/` and `/reload`:

```sh
mkdir -p .pi/extensions
ln -s /absolute/path/to/pi-context-scribe .pi/extensions/pi-context-scribe
```

Do not enable another compaction extension at the same time. Apart from read-only
status, there is no model picker, background calibration, transcript logging or
retrieval shell.
Extensions execute with Pi's operating-system permissions; review before loading.
The package is private to prevent accidental npm publication.

## License

[MIT](LICENSE), copyright 2026 thias.

## Last confirmed working

| Date | Code revision | Pi | Node.js | Platform |
|---|---|---|---|---|
| 2026-11-09 | `v0.1.0` | 1.3.0 | 26.10.0 | Linux x64 |

**Checked:** type checking and offline automated tests, including the real loader,
read-only status dispatch, own-checkout Git identity, SDK compaction lifecycle
with fake providers, and native redraw/widget regression checks. Live checks
cover direct DeepSeek compaction, configured timeout fallback to GPT and visible
completion statistics and the compact arrow/count format. The current timeout
allowances have not been calibrated under real load. The R/W cache labels and
extended widget lifetime are covered by offline checks, not yet live confirmation.
One known-working configuration, not a supported-version range.
