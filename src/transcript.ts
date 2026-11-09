import { contentText } from "@earendil-works/pi-ai";
import { convertToLlm, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

type Message = SessionBeforeCompactEvent["preparation"]["messagesToSummarize"][number];

function prefix(text: string, length: number): string {
  // Do not leave half of a UTF-16 surrogate pair at the cut.
  const end = /[\uD800-\uDBFF]/.test(text[length - 1] ?? "") ? length - 1 : length;
  return text.slice(0, end);
}
export function excerpt(text: string, tail: boolean): string {
  const limit = tail ? 2000 : 1000;
  if (text.length <= limit) return text;
  const head = prefix(text, 1000);
  let end = tail ? text.slice(-1000) : "";
  if (end && /[\uDC00-\uDFFF]/.test(end[0])) end = end.slice(1);
  return head + "\n[... " + (text.length - head.length - end.length) +
    " characters omitted ...]\n" + end;
}

/** One labelled record per original message; never replay it as live dialogue. */
export function serialize(messages: Message[], label: string): string[] {
  const records: string[] = [];
  let openCalls = new Set<string>();
  messages.forEach((original, index) => {
    const parts: string[] = [];
    for (const msg of convertToLlm([original])) {
      if (msg.role === "user") {
        const text = contentText(msg.content, "");
        if (text) parts.push("[User]: " + text);
      } else if (msg.role === "assistant") {
        for (const block of msg.content) {
          if (block.type === "text") parts.push("[Assistant]: " + block.text);
          if (block.type === "toolCall") {
            const args = Object.entries(block.arguments).map(([key, value]) =>
              key + "=" + (typeof value === "string" ? JSON.stringify(excerpt(value, false)) :
                excerpt(JSON.stringify(value) ?? "null", false)));
            parts.push("[Tool call " + block.id + "]: " + block.name + "(" + args.join(", ") + ")");
          }
        }
      } else if (msg.role === "toolResult") {
        parts.push("[Tool result " + msg.toolCallId + " / " + msg.toolName +
          "; reported " + (msg.isError ? "error" : "no error") + "]:\n" +
          excerpt(contentText(msg.content, ""), true));
      }
    }
    if (!parts.length) return;
    const record = "[" + label + " message " + (index + 1) + "]\n" + parts.join("\n");
    if (original.role === "toolResult" && openCalls.has(original.toolCallId) && records.length) {
      records[records.length - 1] += "\n\n" + record;
      openCalls.delete(original.toolCallId);
    } else {
      records.push(record);
      openCalls = new Set(original.role === "assistant" ? original.content
        .filter((block) => block.type === "toolCall").map((block) => block.id) : []);
    }
  });
  return records;
}
