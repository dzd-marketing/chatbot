import type { ChatToolName } from "./tool-groups";

/**
 * There is no fixed limit on searches or page reads: the model may browse
 * as many sites as it needs. The only limit is time. Vercel stops the chat
 * function after `maxDuration` (300 s, app/(chat)/api/chat/route.ts), which
 * would cut a reply off mid-way, so once TOOL_TIME_BUDGET_MS has passed the
 * model gets no more tools and writes its answer with what it has found.
 */
export const TOOL_TIME_BUDGET_MS = 210_000;

/**
 * Only a safety net against a model stuck in a loop (it is never reached in
 * normal use; the time budget above applies first).
 */
export const MAX_STEPS = 60;

export const FINAL_STEP_NOTE =
  "Time is up for tool calls in this reply. Do not call any tools. Write your final answer to the student now, using what you found. Share the most relevant links from your tool results, and if you did not find what they asked for, say so and suggest where to look.";

type StepInfo = {
  stepNumber: number;
  steps?: { toolCalls?: { toolName: string }[] }[];
};

/** Tools that create or rewrite a document (one per reply). */
const DOCUMENT_WRITE_TOOLS = new Set<string>([
  "createDocument",
  "updateDocument",
]);
const DOCUMENT_TOOLS = new Set<string>([
  "createDocument",
  "editDocument",
  "updateDocument",
]);

/**
 * streamText's prepareStep: a required retrieval can be forced on step zero;
 * tools then stay available until the time budget is used up (or the safety
 * net is reached), followed by a final answer step without tools.
 */
export function createPrepareStep({
  enabledTools,
  instructions,
  requiredFirstTool,
  startedAt = Date.now(),
  now = Date.now,
}: {
  enabledTools: ChatToolName[];
  instructions: string;
  /** Force a specific tool on step zero for requests that require retrieval. */
  requiredFirstTool?: ChatToolName;
  /** When the request started (ms). */
  startedAt?: number;
  /** For tests. */
  now?: () => number;
}) {
  return ({ stepNumber, steps = [] }: StepInfo) => {
    if (enabledTools.length === 0) {
      return;
    }
    const outOfTime = now() - startedAt >= TOOL_TIME_BUDGET_MS;
    if (outOfTime || stepNumber >= MAX_STEPS - 1) {
      return {
        activeTools: [] as ChatToolName[],
        instructions: `${instructions}\n\n${FINAL_STEP_NOTE}`,
        toolChoice: "none" as const,
      };
    }
    if (
      stepNumber === 0 &&
      requiredFirstTool &&
      enabledTools.includes(requiredFirstTool)
    ) {
      return {
        toolChoice: { toolName: requiredFirstTool, type: "tool" as const },
      };
    }
    // Once a document was created or rewritten, the document tools are
    // removed, so the model can't make the same document again.
    const wroteDocument = steps.some((step) =>
      step.toolCalls?.some((call) => DOCUMENT_WRITE_TOOLS.has(call.toolName))
    );
    if (wroteDocument) {
      return {
        activeTools: enabledTools.filter((name) => !DOCUMENT_TOOLS.has(name)),
      };
    }
  };
}
