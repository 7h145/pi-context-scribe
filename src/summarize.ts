import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRegistry, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { Timeout } from "./config.ts";
import { inputTokens, requestText, type Accounting } from "./request.ts";
import { serialize } from "./transcript.ts";

// Structure and concise/update guidance follow Pi 1.3.0's MIT-licensed
// compaction prompts (earendil-works/pi, Mario Zechner).
const FORMAT = "Create a structured context checkpoint another coding agent will use to continue work.\n" +
  "Use these sections: ## Goal; ## Constraints & Preferences; ## Progress with ### Done, " +
  "### In Progress and ### Blocked; ## Key Decisions (with rationale); ## Next Steps; ## Critical Context.\n" +
  "Keep each section concise but sufficient. Preserve exact paths, function names, error messages, " +
  "user constraints and decision rationale. Include unfinished work. Distinguish proposals, approvals, " +
  "attempted actions and observed outcomes. Later corrections supersede earlier statements. " +
  "Preserve relevant prior-summary information, update progress and next steps, and remove superseded information. " +
  "Later retained messages are stored separately: do not infer or recreate them.";
const NOTES = "Write concise evidence notes for this chronological portion of a conversation, not a complete session summary. " +
  "Record user requests, constraints, corrections, decisions and reasons, actions and their observed outcomes, " +
  "exact identifiers, and unfinished work. Keep local uncertainty explicit; other portions may change the status. " +
  "Preserve chronological order. Compress repetition, not important evidence. Do not invent missing context.";

interface Note {
  text: string;
  first: number;
  last: number;
}
export interface SummaryResult {
  summary: string;
  chunks: number;
  requests: number;
}
type Preparation = SessionBeforeCompactEvent["preparation"];

export async function summarize(
  preparation: Preparation,
  instructions: string | undefined,
  registry: Pick<ModelRegistry, "streamSimple">,
  model: Model<any>,
  thinking: ModelThinkingLevel,
  timeout: Timeout,
  signal: AbortSignal,
  accounting: Accounting,
): Promise<SummaryResult> {
  const maxTokens = Math.min(Math.floor(0.8 * preparation.settings.reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Infinity);
  // Pi 1.3.0 simple adapters reserve 4096 tokens internally. Respect that
  // floor as well as our 10% margin so they do not unexpectedly squeeze output.
  const margin = Math.max(4096, Math.ceil(model.contextWindow * 0.1));
  const capacity = model.contextWindow - maxTokens - margin;
  if (!Number.isFinite(capacity) || capacity <= 0 || maxTokens < 1) {
    throw new Error("model has no usable summarization input/output budget");
  }
  const focus = instructions ? "\nCurrent /compact guidance (for this summary only):\n" + instructions : "";
  const previous = preparation.previousSummary ?
    "\nPrevious summary (historical context):\n" + preparation.previousSummary : "";
  const finalPrompt = (text: string) => FORMAT + focus + previous + "\n\nChronological evidence:\n" + text;
  const notesPrompt = (text: string) => NOTES + focus + "\n\nChronological evidence:\n" + text;
  const fits = (prompt: string) => inputTokens(prompt) <= capacity;
  if (!fits(finalPrompt("")) || !fits(notesPrompt(""))) {
    throw new Error("instructions or previous summary exceed the model input budget");
  }

  const units = [
    ...serialize(preparation.messagesToSummarize, "history"),
    ...serialize(preparation.turnPrefixMessages, "split-turn prefix"),
  ];
  let requests = 0;
  const call = async (prompt: string) => {
    signal.throwIfAborted();
    if (!fits(prompt)) throw new Error("summarization request exceeds input budget");
    requests++;
    return requestText(registry, model, thinking, prompt, maxTokens, timeout, signal, accounting);
  };
  const all = units.join("\n\n");
  if (fits(finalPrompt(all))) {
    return { summary: await call(finalPrompt(all)), chunks: 0, requests };
  }

  // Greedy chronological packing. Only split a record if it cannot fit alone.
  function pack(records: string[], prompt: (text: string) => string): Note[] {
    const groups: Note[] = [];
    let current = "", first = 0;
    for (const [index, record] of records.entries()) {
      signal.throwIfAborted();
      const combined = current ? current + "\n\n" + record : record;
      if (fits(prompt(combined))) {
        if (!current) first = index;
        current = combined;
        continue;
      }
      if (current) { groups.push({ text: current, first, last: index - 1 }); current = ""; }
      if (fits(prompt(record))) { current = record; first = index; continue; }
      let offset = 0;
      while (offset < record.length) {
        signal.throwIfAborted();
        const label = "[Record " + (index + 1) + " continuation at character " + offset + "]\n";
        let lo = 0, hi = record.length - offset;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (fits(prompt(label + record.slice(offset, offset + mid)))) lo = mid;
          else hi = mid - 1;
        }
        // Do not split a surrogate pair across requests.
        if (lo && /[\uD800-\uDBFF]/.test(record[offset + lo - 1])) lo--;
        if (!lo) throw new Error("model input budget cannot fit a record continuation");
        groups.push({ text: label + record.slice(offset, offset + lo), first: index, last: index });
        offset += lo;
      }
    }
    if (current) groups.push({ text: current, first, last: records.length - 1 });
    return groups;
  }

  const groups = pack(units, notesPrompt);
  let notes: Note[] = [];
  for (let i = 0; i < groups.length; i++) {
    notes.push({ first: i + 1, last: i + 1, text: await call(notesPrompt(groups[i].text)) });
  }
  const render = (items: Note[]) => items.map((n) => "[source chunk " + n.first +
    (n.first === n.last ? "" : "-" + n.last) + "]\n" + n.text).join("\n\n");
  while (!fits(finalPrompt(render(notes)))) {
    const before = inputTokens(render(notes));
    const batches = pack(notes.map((n) => render([n])), notesPrompt);
    const reduced: Note[] = [];
    for (const batch of batches) {
      reduced.push({ first: notes[batch.first].first, last: notes[batch.last].last,
        text: await call(notesPrompt(batch.text)) });
    }
    if (inputTokens(render(reduced)) >= before) {
      throw new Error("intermediate summaries did not shrink; stopping reduction");
    }
    notes = reduced;
  }
  return { summary: await call(finalPrompt(render(notes))), chunks: groups.length, requests };
}
