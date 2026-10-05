export const DEFAULT_CHAT_MODEL = "zai/glm-4.7-flash";

// Use Z.AI for title generation too, so the default chat path does not
// depend on Vercel AI Gateway.
export const titleModel = {
  description: "Fast model for title generation",
  id: "zai/glm-4.7-flash",
  name: "GLM-4.7 Flash",
  provider: "zai",
};

export type ModelCapabilities = {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
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
  gatewayOrder?: string[];
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

export const chatModels: ChatModel[] = [
  {
    description: "Free, lightweight model from Z.AI",
    id: "zai/glm-4.7-flash",
    name: "GLM-4.7 Flash",
    provider: "zai",
    // GLM-4.7 thinks by default; Z.AI only allows switching it on or off.
    reasoning: { control: "toggle", defaultLevel: "high" },
  },
  {
    description: "Fast and capable model with tool use",
    gatewayOrder: ["bedrock", "deepinfra"],
    id: "deepseek/deepseek-v3.2",
    name: "DeepSeek V3.2",
    provider: "deepseek",
  },
  {
    description: "Moonshot AI flagship model",
    gatewayOrder: ["fireworks", "bedrock"],
    id: "moonshotai/kimi-k2.5",
    name: "Kimi K2.5",
    provider: "moonshotai",
  },
  {
    description: "Compact reasoning model",
    gatewayOrder: ["groq", "bedrock"],
    id: "openai/gpt-oss-20b",
    name: "GPT OSS 20B",
    provider: "openai",
    reasoning: { control: "effort", defaultLevel: "low" },
  },
  {
    description: "Open-source 120B parameter model",
    gatewayOrder: ["fireworks", "bedrock"],
    id: "openai/gpt-oss-120b",
    name: "GPT OSS 120B",
    provider: "openai",
    reasoning: { control: "effort", defaultLevel: "low" },
  },
  {
    description: "Fast non-reasoning model with tool use",
    gatewayOrder: ["xai"],
    id: "xai/grok-4.1-fast-non-reasoning",
    name: "Grok 4.1 Fast",
    provider: "xai",
  },
];

export async function getCapabilities(): Promise<
  Record<string, ModelCapabilities>
> {
  const results = await Promise.all(
    chatModels.map(async (model) => {
      // This model is called directly through Z.AI, not through AI Gateway.
      // GLM-4.7-Flash supports function calling and thinking; it is text-only.
      if (model.provider === "zai") {
        return [model.id, { reasoning: true, tools: true, vision: false }];
      }

      try {
        const res = await fetch(
          `https://ai-gateway.vercel.sh/v1/models/${model.id}/endpoints`,
          { next: { revalidate: 86_400 } }
        );
        if (!res.ok) {
          return [model.id, { reasoning: false, tools: false, vision: false }];
        }

        const json = await res.json();
        const endpoints = json.data?.endpoints ?? [];
        const params = new Set(
          endpoints.flatMap(
            (e: { supported_parameters?: string[] }) =>
              e.supported_parameters ?? []
          )
        );
        const inputModalities = new Set(
          json.data?.architecture?.input_modalities ?? []
        );

        return [
          model.id,
          {
            reasoning: params.has("reasoning"),
            tools: params.has("tools"),
            vision: inputModalities.has("image"),
          },
        ];
      } catch {
        return [model.id, { reasoning: false, tools: false, vision: false }];
      }
    })
  );

  return Object.fromEntries(results);
}

export const isDemo = process.env.IS_DEMO === "1";

type GatewayModel = {
  id: string;
  name: string;
  type?: string;
  tags?: string[];
};

export type GatewayModelWithCapabilities = ChatModel & {
  capabilities: ModelCapabilities;
};

export async function getAllGatewayModels(): Promise<
  GatewayModelWithCapabilities[]
> {
  try {
    const res = await fetch("https://ai-gateway.vercel.sh/v1/models", {
      next: { revalidate: 86_400 },
    });
    if (!res.ok) {
      return [];
    }

    const json = await res.json();
    return (json.data ?? [])
      .filter((m: GatewayModel) => m.type === "language")
      .map((m: GatewayModel) => ({
        capabilities: {
          reasoning: m.tags?.includes("reasoning") ?? false,
          tools: m.tags?.includes("tool-use") ?? false,
          vision: m.tags?.includes("vision") ?? false,
        },
        description: "",
        id: m.id,
        name: m.name,
        provider: m.id.split("/")[0],
      }));
  } catch {
    return [];
  }
}

export function getActiveModels(): ChatModel[] {
  return chatModels;
}

export const allowedModelIds = new Set(chatModels.map((m) => m.id));

export const modelsByProvider = chatModels.reduce(
  (acc, model) => {
    if (!acc[model.provider]) {
      acc[model.provider] = [];
    }
    acc[model.provider].push(model);
    return acc;
  },
  {} as Record<string, ChatModel[]>
);

export type ModelAvailability = "healthy" | "impacted" | "unknown";

type GatewayEndpoint = {
  provider_name?: string;
  status?: number;
  uptime_last_15m?: number;
  uptime_last_1h?: number;
  latency_last_1h?: {
    p50?: number;
    p95?: number;
  };
};

const PROVIDER_IMPACTED_UPTIME_THRESHOLD = 99;
const PROVIDER_IMPACTED_P50_MS = 10_000;
const PROVIDER_IMPACTED_P95_MS = 30_000;

function isEndpointImpacted(endpoint: GatewayEndpoint) {
  return (
    (endpoint.status !== undefined && endpoint.status !== 0) ||
    (endpoint.uptime_last_15m !== undefined &&
      endpoint.uptime_last_15m < PROVIDER_IMPACTED_UPTIME_THRESHOLD) ||
    (endpoint.uptime_last_1h !== undefined &&
      endpoint.uptime_last_1h < PROVIDER_IMPACTED_UPTIME_THRESHOLD) ||
    (endpoint.latency_last_1h?.p50 !== undefined &&
      endpoint.latency_last_1h.p50 > PROVIDER_IMPACTED_P50_MS) ||
    (endpoint.latency_last_1h?.p95 !== undefined &&
      endpoint.latency_last_1h.p95 > PROVIDER_IMPACTED_P95_MS)
  );
}

export async function getModelAvailability(
  modelId: string
): Promise<ModelAvailability> {
  const model = chatModels.find((item) => item.id === modelId);

  // Z.AI availability is not represented in the AI Gateway endpoint API.
  if (!model || model.provider === "zai") {
    return "unknown";
  }

  try {
    const res = await fetch(
      `https://ai-gateway.vercel.sh/v1/models/${model.id}/endpoints`,
      { next: { revalidate: 60 } }
    );
    if (!res.ok) {
      return "unknown";
    }

    const json = await res.json();
    const endpoints = (json.data?.endpoints ?? []) as GatewayEndpoint[];

    if (endpoints.length === 0) {
      return "unknown";
    }

    return endpoints.some(isEndpointImpacted) ? "impacted" : "healthy";
  } catch {
    return "unknown";
  }
}
