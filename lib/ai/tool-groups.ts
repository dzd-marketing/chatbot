/**
 * Tools the student can switch on and off from the composer's Tools menu.
 * Shared by the client (menu, saved settings) and the chat route (which
 * tools the model is given). Each group maps to one or more AI SDK tools.
 */

export const toolGroupIds = [
  "webSearch",
  "webFetch",
  "documents",
  "weather",
] as const;

export type ToolGroupId = (typeof toolGroupIds)[number];

export type ToolSettings = Record<ToolGroupId, boolean>;

/** Tools registered in the chat route (app/(chat)/api/chat/route.ts). */
export type ChatToolName =
  | "createDocument"
  | "editDocument"
  | "getWeather"
  | "requestSuggestions"
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
    description: "Find up-to-date facts, news and sources",
    id: "webSearch",
    label: "Web search",
    tools: ["webSearch"],
  },
  {
    description: "Open and read links from you or from search",
    id: "webFetch",
    label: "Read web pages",
    tools: ["webFetch"],
  },
  {
    description: "Write notes, essays, code and sheets in a side panel",
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
    description: "Current weather for a city",
    id: "weather",
    label: "Weather",
    tools: ["getWeather"],
  },
];

/** Every tool is on until the student switches it off. */
export const defaultToolSettings: ToolSettings = {
  documents: true,
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
