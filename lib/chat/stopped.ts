import type { ChatMessage } from "@/lib/types";

/**
 * A reply the student stopped (Stop button) is kept with what was written
 * so far plus a "data-stopped" part, which the chat shows as a notice. The
 * model never sees data parts (convertToModelMessages skips them).
 */

type Part = ChatMessage["parts"][number];

const FINISHED_TOOL_STATES = new Set([
  "output-available",
  "output-error",
  "output-denied",
]);

/** Tool calls cut off before their result (a call with no result breaks the next request). */
function isUnfinishedTool(part: Part) {
  const { state, type } = part as { state?: string; type: string };
  const isTool = type.startsWith("tool-") || type === "dynamic-tool";
  return isTool && !FINISHED_TOOL_STATES.has(state ?? "");
}

export function isStoppedMessage(message: Pick<ChatMessage, "parts">) {
  return message.parts.some((part) => part.type === "data-stopped");
}

/** Parts of a stopped reply: finished text, no half-made tools, the marker. */
export function markStopped(parts: ChatMessage["parts"]): ChatMessage["parts"] {
  const kept = parts
    .filter(
      (part) =>
        !isUnfinishedTool(part) &&
        part.type !== "data-stopped" &&
        part.type !== "data-waiting-status"
    )
    .map((part): Part => {
      if (
        (part.type === "text" || part.type === "reasoning") &&
        part.state === "streaming"
      ) {
        return { ...part, state: "done" as const };
      }
      // TheStudent AI's research panel stops "running".
      if (part.type === "data-dzd-activity" && part.data.status === "running") {
        return { ...part, data: { ...part.data, status: "done" as const } };
      }
      return part;
    });
  return [...kept, { data: null, type: "data-stopped" }];
}

/**
 * Client side, right after stop(): marks the reply being written, or adds
 * an empty stopped reply if the model hadn't started answering yet.
 */
export function withStoppedReply(
  messages: ChatMessage[],
  newId: () => string
): ChatMessage[] {
  const last = messages.at(-1);
  if (!last) {
    return messages;
  }
  if (last.role === "assistant") {
    if (isStoppedMessage(last)) {
      return messages;
    }
    return [
      ...messages.slice(0, -1),
      { ...last, parts: markStopped(last.parts) },
    ];
  }
  return [
    ...messages,
    { id: newId(), parts: markStopped([]), role: "assistant" },
  ];
}
