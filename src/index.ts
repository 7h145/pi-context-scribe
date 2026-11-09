/**
 * pi-context-scribe extension entry point
 *
 * Purpose: provide the Pi package factory without changing session behavior.
 * Strategy: register nothing until compaction is implemented.
 * Author: thias, OpenAI assistant
 * License: MIT
 * Version: 0.1.0
 * Date: 2026-11-09
 * Last verified with Node.js: 26.10.0 (scaffold checks; Pi 1.3.0)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function contextScribe(_pi: ExtensionAPI): void {
  // Intentionally leave Pi's model selection and compaction untouched.
}
