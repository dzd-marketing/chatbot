/**
 * Student-facing choices are TheStudent AI modes, not provider or model IDs.
 * The server maps these allowlisted IDs to automatic, NVIDIA-only, or
 * GPT-OSS-only Study routing in lib/ai/router.ts.
 */
export const DZD_LEARN_MODEL_ID = "dzd-learn/auto";
export const DZD_FLASH_MODEL_ID = "dzd-learn/flash-v1";
export const DZD_STUDY_MODEL_ID = "dzd-learn/study-v1";
export const CHAT_MODEL_IDS = [
  DZD_LEARN_MODEL_ID,
  DZD_FLASH_MODEL_ID,
  DZD_STUDY_MODEL_ID,
] as const;
export type ChatModelId = (typeof CHAT_MODEL_IDS)[number];
export type ChatRouteMode = "auto" | "flash" | "study";

export const DEFAULT_CHAT_MODEL = DZD_LEARN_MODEL_ID;

export function isChatModelId(modelId: string): modelId is ChatModelId {
  return (CHAT_MODEL_IDS as readonly string[]).includes(modelId);
}

export function getChatRouteMode(modelId: ChatModelId): ChatRouteMode {
  switch (modelId) {
    case DZD_FLASH_MODEL_ID:
      return "flash";
    case DZD_STUDY_MODEL_ID:
      return "study";
    default:
      return "auto";
  }
}

/**
 * The model list endpoint used by the composer. The version query makes
 * browsers skip responses cached by older deployments; bump it when the
 * response shape changes.
 */
export const MODELS_API_URL = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/models?v=5`;

export type ModelCapabilities = {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  /**
   * The model's own server searches the web when needed (no website tools
   * involved), so the Web search toggle doesn't apply to it.
   */
  builtInWebSearch?: boolean;
};

/**
 * User-selectable reasoning level. How it maps onto a model depends on that
 * model's `reasoning.control`:
 * - "toggle": the model can only switch thinking on or off (Z.AI GLM-4.7
 *   series: `thinking.type`). "off" = Fast, anything else = Thinking.
 * - "effort": the model accepts low / medium / high effort and cannot turn
 *   reasoning off (OpenAI gpt-oss: `reasoningEffort`). "off" maps to "low".
 */
export const reasoningLevels = ["off", "low", "medium", "high"] as const;
export type ReasoningLevel = (typeof reasoningLevels)[number];

export type ReasoningConfig = {
  control: "toggle" | "effort";
  defaultLevel: ReasoningLevel;
};

export type ChatModel = {
  id: string;
  name: string;
  provider: string;
  description: string;
  reasoning?: ReasoningConfig;
};

export type ReasoningOption = {
  value: ReasoningLevel;
  label: string;
  description: string;
};

const toggleReasoningOptions: ReasoningOption[] = [
  {
    description: "Answers straight away. Best for quick questions.",
    label: "Fast",
    value: "off",
  },
  {
    description: "Works through the problem step by step before answering.",
    label: "Thinking",
    value: "high",
  },
];

const effortReasoningOptions: ReasoningOption[] = [
  {
    description: "Light reasoning for quick answers.",
    label: "Low",
    value: "low",
  },
  {
    description: "Balanced speed and depth.",
    label: "Medium",
    value: "medium",
  },
  {
    description: "Deepest reasoning for hard problems. Slower.",
    label: "High",
    value: "high",
  },
];

export function getReasoningOptions(
  model: Pick<ChatModel, "reasoning"> | undefined
): ReasoningOption[] {
  if (!model?.reasoning) {
    return [];
  }
  return model.reasoning.control === "toggle"
    ? toggleReasoningOptions
    : effortReasoningOptions;
}

/**
 * Coerces a stored or requested level to one the model actually supports,
 * falling back to the model's default. Returns undefined for models without
 * a reasoning control.
 */
export function resolveReasoningLevel(
  model: Pick<ChatModel, "reasoning"> | undefined,
  level: ReasoningLevel | undefined
): ReasoningLevel | undefined {
  const config = model?.reasoning;
  if (!config) {
    return;
  }
  const requested = level ?? config.defaultLevel;
  if (config.control === "toggle") {
    return requested === "off" ? "off" : "high";
  }
  return requested === "off" ? "low" : requested;
}

export const dzdLearnModel: ChatModel = {
  description: "Automatic routing across TheStudent AI services",
  id: DZD_LEARN_MODEL_ID,
  name: "TheStudent AI Auto",
  provider: "thestudent",
  // Fast (thinking off) or Thinking; the server applies it to whichever
  // model answers.
  reasoning: { control: "toggle", defaultLevel: "high" },
};

export const dzdFlashModel: ChatModel = {
  description: "Quick replies from TheStudent AI",
  id: DZD_FLASH_MODEL_ID,
  name: "TheStudent AI Flash v1",
  provider: "thestudent",
  reasoning: { control: "toggle", defaultLevel: "off" },
};

export const dzdStudyModel: ChatModel = {
  description: "Deeper tutoring from TheStudent AI",
  id: DZD_STUDY_MODEL_ID,
  name: "TheStudent AI Study v1",
  provider: "thestudent",
  reasoning: { control: "effort", defaultLevel: "medium" },
};

/** What each student-facing route can do. */
export const dzdLearnCapabilities: ModelCapabilities = {
  reasoning: true,
  tools: true,
  vision: true,
};

export const dzdFlashCapabilities: ModelCapabilities = {
  reasoning: true,
  tools: true,
  vision: true,
};

export const dzdStudyCapabilities: ModelCapabilities = {
  reasoning: true,
  tools: true,
  vision: false,
};

export const chatModels: ChatModel[] = [
  dzdLearnModel,
  dzdFlashModel,
  dzdStudyModel,
];

const chatModelCapabilities: Record<ChatModelId, ModelCapabilities> = {
  [DZD_LEARN_MODEL_ID]: dzdLearnCapabilities,
  [DZD_FLASH_MODEL_ID]: dzdFlashCapabilities,
  [DZD_STUDY_MODEL_ID]: dzdStudyCapabilities,
};

export function getChatModel(modelId: string): ChatModel {
  return chatModels.find((model) => model.id === modelId) ?? dzdLearnModel;
}

export function getModelCapabilities(modelId: string): ModelCapabilities {
  return isChatModelId(modelId)
    ? chatModelCapabilities[modelId]
    : dzdLearnCapabilities;
}

export function getCapabilities(): Record<string, ModelCapabilities> {
  return { ...chatModelCapabilities };
}

export function getActiveModels(): ChatModel[] {
  return chatModels;
}

export const allowedModelIds = new Set<string>(CHAT_MODEL_IDS);
