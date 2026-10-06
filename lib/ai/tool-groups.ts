/**
 * Tools the student can switch on and off from the composer's Tools menu.
 * Shared by the client (menu, saved settings) and the chat route (which
 * tools the model is given). Each group maps to one or more AI SDK tools.
 */

export const toolGroupIds = [
  "webSearch",
  "webFetch",
  "documents",
  "study",
  "calculator",
  "weather",
] as const;

export type ToolGroupId = (typeof toolGroupIds)[number];

export type ToolSettings = Record<ToolGroupId, boolean>;

/** Tools registered in the chat route (app/(chat)/api/chat/route.ts). */
export type ChatToolName =
  | "calculate"
  | "createDocument"
  | "createFlashcards"
  | "createQuiz"
  | "editDocument"
  | "getWeather"
  | "readDocument"
  | "requestSuggestions"
  | "shareFiles"
  | "updateDocument"
  | "webFetch"
  | "webSearch";

export type ToolGroup = {
  id: ToolGroupId;
  label: string;
  description: string;
  /** AI SDK tool names enabled by this group. */
  tools: readonly ChatToolName[];
};

export const toolGroups: readonly ToolGroup[] = [
  {
    description:
      "Find facts, news and past papers, with checked download links",
    id: "webSearch",
    label: "Web search",
    tools: ["webSearch", "shareFiles"],
  },
  {
    description: "Open web pages, PDF and Word files from links",
    id: "webFetch",
    label: "Read pages & PDFs",
    tools: ["webFetch", "readDocument"],
  },
  {
    description: "Write notes and essays, download as Word or PDF",
    id: "documents",
    label: "Documents",
    tools: [
      "createDocument",
      "editDocument",
      "updateDocument",
      "requestSuggestions",
    ],
  },
  {
    description: "Interactive MCQ quizzes and flashcards",
    id: "study",
    label: "Quizzes & flashcards",
    tools: ["createQuiz", "createFlashcards"],
  },
  {
    description: "Exact maths, formulas and unit conversions",
    id: "calculator",
    label: "Calculator",
    tools: ["calculate"],
  },
  {
    description: "Current weather for a city",
    id: "weather",
    label: "Weather",
    tools: ["getWeather"],
  },
];

/** Every tool is on until the student switches it off. */
export const defaultToolSettings: ToolSettings = {
  calculator: true,
  documents: true,
  study: true,
  weather: true,
  webFetch: true,
  webSearch: true,
};

/** Fills in defaults for missing (or unknown) saved values. */
export function resolveToolSettings(
  partial: Partial<Record<string, unknown>> | null | undefined
): ToolSettings {
  const settings = { ...defaultToolSettings };
  for (const id of toolGroupIds) {
    const value = partial?.[id];
    if (typeof value === "boolean") {
      settings[id] = value;
    }
  }
  return settings;
}

/** AI SDK tool names for the enabled groups. */
export function activeToolNames(settings: ToolSettings): ChatToolName[] {
  return toolGroups
    .filter((group) => settings[group.id])
    .flatMap((group) => [...group.tools]);
}
