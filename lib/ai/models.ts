/** The one student-facing assistant. Provider identities remain server-side. */
export const THESTUDENT_AI_MODEL_ID = "thestudent/auto";
export const DEFAULT_CHAT_MODEL = THESTUDENT_AI_MODEL_ID;
export const CHAT_MODEL_IDS = [THESTUDENT_AI_MODEL_ID] as const;

/**
 * Accepted only for requests from already-open clients during a deployment.
 * Every legacy choice is normalized to Auto by the chat route.
 */
export const LEGACY_CHAT_MODEL_IDS = [
  "dzd-learn/auto",
  "dzd-learn/flash-v1",
  "dzd-learn/study-v1",
] as const;
export const ACCEPTED_CHAT_MODEL_IDS = [
  ...CHAT_MODEL_IDS,
  ...LEGACY_CHAT_MODEL_IDS,
] as const;

export type ChatModelId = (typeof CHAT_MODEL_IDS)[number];
export type AcceptedChatModelId = (typeof ACCEPTED_CHAT_MODEL_IDS)[number];

export function isChatModelId(modelId: string): modelId is ChatModelId {
  return (CHAT_MODEL_IDS as readonly string[]).includes(modelId);
}

/** The model list endpoint used by the composer; bump to bypass stale caches. */
export const MODELS_API_URL = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/models?v=6`;

export type ModelCapabilities = {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  builtInWebSearch?: boolean;
};

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

/** Coerces the stored reasoning choice to the current assistant's capability. */
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

const theStudentAiModel: ChatModel = {
  description: "Automatic routing for TheStudent AI",
  id: THESTUDENT_AI_MODEL_ID,
  name: "TheStudent AI",
  provider: "thestudent",
  reasoning: { control: "toggle", defaultLevel: "high" },
};

/** Auto may use image-capable NVIDIA models before text-only fallbacks. */
const theStudentAiCapabilities: ModelCapabilities = {
  reasoning: true,
  tools: true,
  vision: true,
};

export const chatModels: ChatModel[] = [theStudentAiModel];

export function getChatModel(_modelId: string): ChatModel {
  return theStudentAiModel;
}

export function getModelCapabilities(_modelId: string): ModelCapabilities {
  return theStudentAiCapabilities;
}

export function getCapabilities(): Record<string, ModelCapabilities> {
  return { [THESTUDENT_AI_MODEL_ID]: theStudentAiCapabilities };
}

export function getActiveModels(): ChatModel[] {
  return chatModels;
}

export const allowedModelIds = new Set<string>(CHAT_MODEL_IDS);
