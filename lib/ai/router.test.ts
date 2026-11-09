import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRoutePlan, PRIMARY_NVIDIA_MODEL } from "./router";

test("automatic provider order is NVIDIA, GPT-OSS, then Z.AI", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = new Map<string, string | undefined>();
  const testEnvNames = new Set([
    ...Object.keys(process.env).filter((name) =>
      /^NVIDIA_API_KEY(?:_?\d+)?$/.test(name)
    ),
    "NVIDIA_API_KEY",
    "NVIDIA_BASE_URL",
    "NVIDIA_HIDDEN_MODELS",
    "GPT_OSS_HF_TOKEN",
    "GPT_OSS_API_KEY",
    "GPT_OSS_DISABLED",
    "ZAI_API_KEY",
  ]);

  for (const name of testEnvNames) {
    originalEnv.set(name, process.env[name]);
    delete process.env[name];
  }

  try {
    process.env.NVIDIA_API_KEY = "test-nvidia-key";
    process.env.NVIDIA_BASE_URL = "https://nvidia.test.invalid/v1";
    process.env.NVIDIA_HIDDEN_MODELS = "";
    process.env.GPT_OSS_HF_TOKEN = "test-hf-read-token";
    process.env.GPT_OSS_API_KEY = "test-bridge-key";
    process.env.ZAI_API_KEY = "test-zai-key";
    globalThis.fetch = async () =>
      Response.json({
        data: [
          { id: "openai/gpt-oss-20b" },
          { id: "nvidia/nemotron-3-ultra-550b-a55b" },
          { id: "meta/llama-3.3-70b-instruct" },
        ],
      });

    const plan = await buildRoutePlan({
      needsVision: false,
      purpose: "chat",
    });

    assert.deepEqual(
      plan.map((candidate) => candidate.kind),
      ["nvidia", "nvidia", "nvidia", "gpt-oss", "zai"]
    );
    assert.equal(plan[0].id, `nvidia:${PRIMARY_NVIDIA_MODEL}`);
    assert.equal(plan[3].id, "gpt-oss:hf-space");
    assert.equal(plan[4].id, "zai:glm-4.7-flash");
    assert.ok(!plan.some((candidate) => candidate.id.startsWith("dzd:")));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
