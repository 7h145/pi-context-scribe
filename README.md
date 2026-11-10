# pi-context-scribe

Use a separate model to compact [Pi](https://pi.dev) conversations,
without changing the model you use for coding.

- [What this is](#what-this-is)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Reading the completion widget](#reading-the-completion-widget)
- [Configuration](#configuration)
- [How compaction works](#how-compaction-works)
- [Context and privacy](#context-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Development and license](#development-and-license)
- [Last confirmed working](#last-confirmed-working)

## What this is

Pi compacts long conversations by summarizing older history and keeping
recent messages. Normally, that summary uses your coding model.
pi-context-scribe lets you choose a different model for the summary: one
that is cheaper for you, faster, or available on premises. Your coding
model and its thinking setting stay unchanged.

It handles both automatic compaction and Pi's **`/compact`** command.
It does not replace the branch summaries Pi offers when you navigate
with `/tree`.

You can configure fallback models. If none succeeds, context-scribe hands
control back to Pi's built-in compaction rather than blocking it.

## Requirements

- Pi, with its interactive terminal UI for the completion widget.
- Node.js 22.19 or newer.
- For separate-model compaction: a model registered in Pi, with the
  credentials and connectivity its provider requires.

Development and automated checks use Pi **1.3.0** and Node.js **26.10.0**
on Linux. Other Pi versions, platforms and the minimum Node version have
not been exercised. RPC clients receive completion notifications instead
of a terminal widget; compaction itself does not require the terminal UI.

This is pre-1.0 software. Interfaces may change without backward
compatibility. Broader summary quality and timeout calibration are still
being evaluated.

## Installation

Install for your Pi sessions from GitHub:

```sh
pi install git:github.com/7h145/pi-context-scribe
```

This is a personal/global install. Add `-l` for a project-local install;
Pi loads project packages only after you trust the project. Run Pi's
**`/reload`** if Pi is already running.

To try a local checkout without installing it:

```sh
pi --no-extensions -e /absolute/path/to/pi-context-scribe
```

That command loads the checkout explicitly and disables other discovered
extensions. Avoid loading both the installed and checkout copies, or
another compaction extension at the same time. Pi supplies the runtime
modules; no build step is needed.

Loading context-scribe does not contact a provider. Requests happen when
Pi compacts. Without model configuration, compaction stays with Pi's
built-in implementation.

## Usage

### Choose a compaction model

Create `pi-context-scribe.json` in Pi's agent directory, normally
`~/.pi/agent`. If `PI_CODING_AGENT_DIR` is set, use that directory instead.
For a project-specific choice, use `.pi/pi-context-scribe.json` in Pi's
working directory; it is read only after the project is trusted.

The only required setting is the model list. This example uses OpenAI:

```json
{
  "models": [
    "openai/gpt-6-luna"
  ]
}
```

OpenAI must already be configured in Pi, and your account must have
access to this model. For another model or provider, use a
`provider/modelId` from `pi --list-models`. Endpoints, credentials and
provider-specific settings belong in Pi's configuration, not this file.
See [Configuration](#configuration) for model order, fallbacks, thinking
and request timeouts.

Run **`/reload`**, then **`/context-scribe`**. The arrow should mark your
preferred model as the next one to try.

### Compact a conversation

Continue working normally: Pi still decides when automatic compaction is
needed. To try it manually once the conversation has enough history, use:

```text
/compact
```

You can add guidance for that summary, for example:

```text
/compact Preserve the decisions, constraints and unfinished work.
```

Before each attempt, context-scribe prints the model and effective
thinking level. After success, a temporary line above the editor shows
the successful model, elapsed time and reported token usage. Your coding
model stays selected. Read important summaries and check that the agent
continues with the right constraints; a completed request is not proof
that the summary preserved everything.

### Status

Use any of these equivalent commands:

```text
/context-scribe
/context-scribe status
/context-scribe s
```

The notification shows the loaded version, configured model order,
thinking levels and **the next compaction model to try**. An arrow marks
that choice. Earlier entries are labelled skipped until reset, and the
last entry names Pi's built-in fallback and the selected coding model.
Unregistered models and thinking levels adjusted by Pi are identified
explicitly.

Status reads the loaded settings and Pi's local model registry. It does
not test credentials or connectivity, so a listed model is not proof that
a request will work. It does not send a model request, reload configuration
or change the order. Use **`/reload`** to apply edits and retry from the
first configured model.

A Git installation also shows its own checkout revision, for example
`context-scribe: v0.1.0 (c0486a3)`.

### Fallback and recovery

If a model fails, context-scribe tries the next configured entry. Later
compactions start with that fallback rather than retrying failed models.
This is **sticky fallback**: it moves forward through the list, never
wraps around, and does not rewrite your configuration.

Full Pi **`/reload`**, starting a new session, or switching, resuming or
forking a session resets the order. For example, after restoring VPN
access to your preferred model, run `/reload` to try it again. Routing
state is not saved to disk. Cancelling compaction stops it rather than
trying another provider.

After all configured models fail, context-scribe prints:

```text
context-scribe: handing over to Pi's built-in compaction
```

Pi then runs its normal compaction. This fallback is also sticky: later
compactions continue using Pi's built-in compaction until the order is
reset.

## Reading the completion widget

After a successful context-scribe compaction, the line above the editor
might look like this:

```text
context-scribe: DeepSeek-V4.1-Flash-1017 · direct · 28.1s ↑44k ↓4,319 R43k
```

Read this as: DeepSeek summarized the prepared history in one request.
The whole operation took 28.1 seconds and used about 44,000 input tokens,
including about 43,000 read from the provider's cache, and 4,319 output
tokens.

| Part | Meaning |
| --- | --- |
| `DeepSeek-V4.1-Flash-1017` | The model that produced the installed summary, without its provider/path prefix |
| `direct` | The prepared history fit in one summary request |
| `28.1s` | Elapsed time for the whole operation, including earlier failed model attempts |
| `↑44k` | Total reported input tokens, **including cache reads and writes**, across compaction requests—not Pi's before-compaction conversation size |
| `↓4,319` | Reported output tokens, including reasoning when the provider includes it in output usage |
| `R43k` | Input tokens read from the provider's prompt cache, already included in `↑` |
| `W2.0k` (when present) | Input tokens reported as written to that cache, also already included in `↑` |

For longer input, `chunked (3ch/4req)` means three source chunks and four
requests on the successful model, including the final summary. If the
chunk notes need further shortening, additional requests are counted too.
Time and reported usage include earlier failed models; chunk/request
counts refer only to the successful model.

**Zero-valued `R` and `W` counters are omitted independently.** No `W` in
the example means no cache writes were reported, not proof that the
provider stored nothing. Some services do not report writes separately.
This is provider-side caching, not a cache maintained by context-scribe.
The labels match Pi's footer, but Pi's `↑` excludes cache reads/writes;
context-scribe's `↑` includes them. The widget does not show Pi's `CH`
cache-hit percentage.

Input and cache counts use Pi's rounded `k` (thousands) and `M` (millions)
notation: 111,959 becomes `112k`. Output stays exact with commas through
9,999, then uses the same compact format. Rounding changes only the
display, not the exact usage saved with the compaction.

An ending **`usage partial`** means some requests returned no usable
usage, so the counts cover only the reported portion.
**`usage unavailable`** replaces the counts when no usable usage was
returned. Neither label means compaction failed. Missing usage is not treated as
zero; provider-internal retries may consume unreported tokens.

The widget stays visible for an additional turn, then disappears automatically.

## Configuration

Personal settings live in:

```text
~/.pi/agent/pi-context-scribe.json
```

If `PI_CODING_AGENT_DIR` is set, use `pi-context-scribe.json` in that
directory. Project settings belong in `.pi/pi-context-scribe.json` under
Pi's working directory and apply only after project trust is granted.
The extension does not create these files or search parent directories.

Project `models` replaces the personal list; it does not append to it.
Other project fields override the corresponding personal settings.
Omitted fields inherit the personal value or built-in default, including
each timeout field independently.

Run full Pi **`/reload`** after editing. There is no separate settings
reload command. Missing configuration or `models: []` leaves compaction
to Pi. Invalid JSON or settings cause a warning and built-in fallback,
not a partly applied configuration. Unknown fields and duplicate model
entries are rejected. Configuration is never rewritten automatically.

### Full configuration and defaults

These are the built-in defaults. You can copy this as a starting point,
but the empty model list means no separate-model requests are made:

```json
{
  "models": [],
  "defaultThinking": "low",
  "timeout": {
    "baseMs": 45000,
    "msPer1000InputTokens": 250
  }
}
```

### Model order and thinking

List models in the order you want them tried. Entries can be strings or
objects with an explicit thinking level:

```json
{
  "models": [
    { "model": "my-provider/preferred-model", "thinking": "low" },
    "another-provider/fallback-model"
  ]
}
```

Model IDs use `provider/modelId`; the model ID can contain further
slashes. Every entry must already be registered in Pi. Context-scribe
uses Pi's provider adapters and credentials rather than maintaining
separate endpoints or keys.

Thinking resolves as **per-model setting → `defaultThinking` → `low`**.
Levels are Pi's `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and
`max`. Pi clamps unsupported levels and maps the effective level through
the model definition and provider adapter. The coding model's thinking
setting is not inherited or changed.

### Timeouts

Each summary request gets a base allowance plus time proportional to
its estimated input:

```text
timeoutMs = baseMs + msPer1000InputTokens × estimatedInputTokens / 1000
```

The defaults are **45 seconds plus 250 milliseconds per 1,000 input
tokens**: 70 seconds at 100k estimated input, or 170 seconds at 500k.
These are provisional allowances, not measured inference speeds.

The deadline covers the request, including waiting and generation; it
is not an idle-stream timeout. The same base allowance applies to every
request: a direct summary, each source chunk, further shortening of
notes and the final summary. Each request uses its own estimated input,
including instructions—not the coding session's headline context size.
Provider retries, if any, share that deadline. Context-scribe adds no
retry loop or whole-compaction deadline, and does not impose its timeout
on Pi's built-in fallback.

Both fields are optional independently. `baseMs` must be positive and
`msPer1000InputTokens` nonnegative. Set the latter to `0` for a fixed
per-request timeout.

## How compaction works

Pi decides which older messages to summarize and which recent messages
to keep. Context-scribe preserves that boundary, carries forward the
previous summary, and includes the early part of a response if Pi cuts
within it. Current `/compact` guidance is kept separate from historical
messages, so old instructions are evidence rather than new requests.

Short tool results are kept in full. To bound larger tool evidence:

- Argument values longer than **1,000 characters** keep their prefix.
- Results longer than **2,000 characters** keep the first and last
  **1,000 characters**, with an omission marker.
- Tool identity and reported error status remain outside those limits.
  File-operation lists describe historical tool calls, not independent
  proof that the operations succeeded.

Thinking and image payloads are omitted, as in Pi's text-summary
baseline. Content omitted by the original tool cannot be recovered here.
The summarizer gets no tools and does not reread live files to fill gaps.

When the prepared history fits within the compacting model's available
context, it is summarized in one request. Otherwise, chronological chunks
produce independent notes, then a final request combines them. Chunking
does not switch models. The previous summary is included once, in that
final request. If the notes are still too long, they are shortened in
chronological groups; a step that does not shrink them fails rather than
looping indefinitely.

A failed chunk or incomplete generation installs nothing. The next model
restarts from the original prepared history, without reusing partial
notes. A previous summary or current instructions too large to fit are
not silently dropped: that model fails and routing continues.

Request sizing accounts for the selected model's context window, output
allowance and a 10% safety margin. It also respects Pi 1.3.0's internal
4,096-token headroom floor on smaller windows. Estimates are approximate;
provider adapters may adjust output/thinking budgets further. There is
no separate chunk-size setting, summary-character target or rejection
of a completed summary solely because it exceeds a character count.

## Context and privacy

**Every provider tried can receive conversation history, tool excerpts
and previous-summary content.** Choose the whole model list for the data
you work with, not just the preferred entry. Built-in fallback can send
history through your coding-model provider too. For on-premises-only
work, that route must meet the same requirement.

Excerpts and omitted thinking reduce input size; they are not redaction.
Prompts, tool output, paths and summaries can still contain sensitive
information. Cancellation cannot recall data already sent or guarantee
that a provider has stopped processing it.

Context-scribe does not keep separate conversation or credential logs.
Pi saves the summary, file-operation evidence and available usage in its
session. On built-in fallback, Pi saves its own compactor's usage, not
unreported consumption from earlier failed extension attempts.

The summary model is asked to summarize historical evidence, not answer
it, and has no tools. Its output can still omit or misstate important
information. A completed compaction is not a guarantee of a correct
summary, lower cost or faster responses.

Like any Pi extension, this package runs with Pi's operating-system
permissions. Review the code before loading it.

## Troubleshooting

Start with **`/context-scribe`**. It shows the loaded version and the next
model to try; it does not perform a provider health check.

- **Pi's built-in compaction is selected immediately:** check the file
  location and model list, then `/reload`. Missing settings and an empty
  list deliberately leave compaction to Pi. Fix any configuration warning
  rather than assuming part of the file was accepted.
- **A configured model is skipped or fails:** check its exact
  `provider/modelId`, Pi credentials and network access. Unregistered
  models are skipped. After fixing access, `/reload` resets the sticky
  fallback order.
- **Project settings do not apply:** check Pi's working directory and
  project trust. Personal installation does not make project JSON trusted.
- **Compaction times out:** check provider load and the
  [request timeout allowance](#timeouts). Each chunk has its own deadline;
  a long total elapsed time can include several requests and failed models.
- **No completion widget appears:** confirm the compaction succeeded
  through context-scribe, not built-in fallback. RPC uses a notification
  instead. A new compaction, reload or session change clears old stats.
- **The model name or counts are clipped:** widen the terminal. Full
  model names remain available through `/context-scribe`.
- **Status shows a version without a Git hash:** this can be normal for
  a non-Git installation or when the optional Git lookup fails. It does
  not stop compaction. After updating code, `/reload` refreshes identity.

## Development and license

From a checkout:

```sh
npm ci --ignore-scripts
npm run check
```

Checks run offline with temporary directories, fake providers and mocked
clocks. They cover configuration, tool excerpts, request budgets,
direct/chunked summaries, cancellation, sticky fallback, repeated
compaction, the real Pi loader and SDK lifecycle, status/version display,
and native redraw/widget lifetime. They do not establish live provider
compatibility, summary quality or a supported-version range.

pi-context-scribe is licensed under the [MIT License](LICENSE), copyright
2026 thias. The package is distributed through GitHub; npm publication is
disabled.

## Last confirmed working

| Date | Code revision | Pi | Node.js | Platform |
| --- | --- | --- | --- | --- |
| 2026-11-09 | `c0486a3` (`v0.1.0`) | 1.3.0 | 26.10.0 | Linux x64 |

**Checked:** type checking and offline loader, SDK and native UI tests.
Live checks cover GitHub installation and status, direct DeepSeek
compaction, configured timeout fallback to GPT, and visible completion
statistics with compact counts. The R/W cache labels and extended widget
lifetime have offline coverage, not yet live confirmation. Timeout
allowances and broader summary fidelity remain under evaluation.

One known-working configuration, not a supported-version range.
