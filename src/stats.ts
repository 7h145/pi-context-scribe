import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const STATS_WIDGET = "context-scribe:compaction";

/** Pi footer rounding, with optional exact output counts through 9,999. */
export function formatTokenCount(count: number, exactOutput = false): string {
  if (exactOutput && count < 10_000) return count.toLocaleString("en-US");
  if (count < 1000) return count.toString();
  if (count < 10_000) return (count / 1000).toFixed(1) + "k";
  if (count < 1_000_000) return Math.round(count / 1000) + "k";
  if (count < 10_000_000) return (count / 1_000_000).toFixed(1) + "M";
  return Math.round(count / 1_000_000) + "M";
}

function middle(text: string, columns: number): string {
  if (visibleWidth(text) <= columns) return text;
  if (columns <= 1) return columns > 0 ? "…" : "";
  const right = Math.floor((columns - 1) / 2);
  return sliceByColumn(text, 0, columns - right - 1, true) + "…" +
    sliceByColumn(text, visibleWidth(text) - right, right, true);
}

/** Keep the model family and version suffix visible; never exceed the viewport. */
export function completionLine(model: string, detail: string, width: number): string {
  const name = stripTerminalSequences(model).split("/").filter(Boolean).at(-1) ?? "unknown";
  const prefix = "context-scribe: ";
  const tail = " · " + detail;
  const room = width - visibleWidth(prefix + tail);
  return truncateToWidth(prefix + middle(name, Math.max(5, room)) + tail, Math.max(0, width));
}
