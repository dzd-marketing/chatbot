import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { isStepCount, streamText, tool } from "ai";
import { z } from "zod";
import { createGptOssFetch, prepareGptOssRequestBody } from "./gpt-oss";
import {
  createRoutedModel,
  type RouteCandidate,
  resetRouterState,
} from "./router";

const TEST_BASE_URL = "https://gpt-oss.test.invalid/v1";

function sseResponse(events: unknown[]) {
  const encoder = new TextEncoder();
  const chunks = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  chunks.push("data: [DONE]\n\n");
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } }
  );
}

test("prepares bounded requests and keeps the newest student question", () => {
  const messages = [
    { content: "TheStudent tutor instructions.", role: "system" },
    { content: "old question ".repeat(10_000), role: "user" },
    { content: "old answer", role: "assistant" },
    {
      content: `${"document text ".repeat(9000)}\nQuestion: what is the key idea?`,
      role: "user",
    },
  ];
  const body = prepareGptOssRequestBody(
    JSON.stringify({
      max_tokens: 16,
      messages,
      model: "client-selected-model",
      tools: [
        {
          function: {
            name: "webSearch",
            parameters: {
              properties: { query: { type: "string" } },
              required: ["query"],
              type: "object",
            },
          },
          type: "function",
        },
      ],
    }),
    { modelId: "gpt-oss-20b", reasoningLevel: "off" }
  );
  const request = JSON.parse(body);

  assert.equal(request.model, "gpt-oss-20b");
  assert.equal(request.reasoning_effort, "low");
  assert.equal(request.max_tokens, 512);
  assert.equal(request.messages[0].role, "system");
  assert.equal(request.messages.at(-1).role, "user");
  assert.match(
    request.messages.at(-1).content,
    /Question: what is the key idea\?/
  );
  assert.ok(!JSON.stringify(request.messages).includes("old question"));
  assert.equal(request.tools[0].function.name, "webSearch");
});

test("sends both private-Space headers and hides non-streaming reasoning", async () => {
  let seenHeaders: Headers | undefined;
  let seenBody: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = (_input, init) => {
    seenHeaders = new Headers(init?.headers);
    seenBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "A final student-facing answer.",
              reasoning_content: "private reasoning text",
              role: "assistant",
            },
          },
        ],
      })
    );
  };
  const fetcher = createGptOssFetch(
    {
      apiKey: "test-bridge-key",
      baseUrl: TEST_BASE_URL,
      modelId: "gpt-oss-20b",
      reasoningLevel: "medium",
    },
    fetchImpl
  );

  const response = await fetcher(`${TEST_BASE_URL}/chat/completions`, {
    body: JSON.stringify({
      max_tokens: 1024,
      messages: [{ content: "Hello", role: "user" }],
      model: "wrong-model",
    }),
    headers: { Authorization: "Bearer test-hf-read-token" },
    method: "POST",
  });
  const result = await response.json();

  assert.equal(seenHeaders?.get("authorization"), "Bearer test-hf-read-token");
  assert.equal(seenHeaders?.get("x-api-key"), "test-bridge-key");
  assert.equal(seenBody?.model, "gpt-oss-20b");
  assert.equal(seenBody?.reasoning_effort, "medium");
  assert.equal(
    result.choices[0].message.content,
    "A final student-facing answer."
  );
  assert.ok(!("reasoning_content" in result.choices[0].message));
});

test("keeps structured app tool calls while filtering streamed reasoning", async () => {
  let sentBody: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = (_input, init) => {
    sentBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      sseResponse([
        {
          choices: [
            {
              delta: { reasoning_content: "private reasoning text" },
              index: 0,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    function: {
                      arguments: "",
                      name: "webSearch",
                    },
                    id: "call-web-search",
                    index: 0,
                    type: "function",
                  },
                ],
              },
              index: 0,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    function: { arguments: '{"query":"photosynthesis"}' },
                    index: 0,
                  },
                ],
              },
              index: 0,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
      ])
    );
  };
  const provider = createOpenAICompatible({
    apiKey: "test-hf-read-token",
    baseURL: TEST_BASE_URL,
    fetch: createGptOssFetch(
      {
        apiKey: "test-bridge-key",
        baseUrl: TEST_BASE_URL,
        modelId: "gpt-oss-20b",
        reasoningLevel: "low",
      },
      fetchImpl
    ),
    headers: { "X-API-Key": "test-bridge-key" },
    name: "gpt-oss-test",
  });
  const model = provider.chatModel("gpt-oss-20b");
  const result = await model.doStream({
    maxOutputTokens: 1024,
    prompt: [
      {
        content: [{ text: "Find photosynthesis resources.", type: "text" }],
        role: "user",
      },
    ],
    toolChoice: { toolName: "webSearch", type: "tool" },
    tools: [
      {
        description: "Search the web for relevant study sources.",
        inputSchema: {
          properties: { query: { type: "string" } },
          required: ["query"],
          type: "object",
        },
        name: "webSearch",
        type: "function",
      },
    ],
  });
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = result.stream.getReader();
  try {
    while (true) {
      // biome-ignore lint/performance/noAwaitInLoops: stream chunks must be read in order.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const toolCall = parts.find((part) => part.type === "tool-call");
  assert.ok(toolCall && toolCall.type === "tool-call");
  assert.equal(toolCall.toolName, "webSearch");
  const input =
    typeof toolCall.input === "string"
      ? JSON.parse(toolCall.input)
      : toolCall.input;
  assert.deepEqual(input, { query: "photosynthesis" });
  assert.ok(!parts.some((part) => part.type === "reasoning-delta"));
  assert.equal(sentBody?.model, "gpt-oss-20b");
  assert.equal(
    (sentBody?.tools as Array<{ function: { name: string } }>)[0].function.name,
    "webSearch"
  );
});

test("retries one empty length response with reduced history", async () => {
  resetRouterState();
  const usage: LanguageModelV4Usage = {
    inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 0, total: 0 },
    outputTokens: { reasoning: 0, text: 0, total: 0 },
  };
  const calls: LanguageModelV4CallOptions[] = [];
  let generationCount = 0;
  const model = {
    doStream: (options: LanguageModelV4CallOptions) => {
      calls.push(options);
      generationCount += 1;
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          if (generationCount === 1) {
            controller.enqueue({
              finishReason: { raw: "length", unified: "length" },
              type: "finish",
              usage,
            });
          } else {
            controller.enqueue({ id: "answer", type: "text-start" });
            controller.enqueue({
              delta: "A bounded retry worked.",
              id: "answer",
              type: "text-delta",
            });
            controller.enqueue({ id: "answer", type: "text-end" });
            controller.enqueue({
              finishReason: { raw: "stop", unified: "stop" },
              type: "finish",
              usage,
            });
          }
          controller.close();
        },
      });
      return Promise.resolve({ stream });
    },
    modelId: "gpt-oss-20b",
    provider: "gpt-oss-test",
    specificationVersion: "v4",
    supportedUrls: {},
  } as unknown as LanguageModelV4;
  const candidate: RouteCandidate = {
    create: () => model,
    id: "gpt-oss:test",
    kind: "gpt-oss",
    reasoning: { control: "effort", defaultLevel: "low" },
    tier: "gpt-oss",
    vision: false,
  };
  const routed = createRoutedModel({
    deadline: Date.now() + 10_000,
    firstOutputMs: { primary: 25, standard: 25 },
    plan: async () => [candidate],
    purpose: "chat",
    reasoningLevel: "medium",
    routeMode: "study",
    sleep: () => Promise.resolve(),
  });
  const result = await routed.doStream({
    maxOutputTokens: 1024,
    prompt: [
      { content: "The tutor's instructions.", role: "system" },
      { content: [{ text: "An older question.", type: "text" }], role: "user" },
      {
        content: [{ text: "An older answer.", type: "text" }],
        role: "assistant",
      },
      {
        content: [{ text: "The current question.", type: "text" }],
        role: "user",
      },
    ],
  });
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = result.stream.getReader();
  try {
    while (true) {
      // biome-ignore lint/performance/noAwaitInLoops: stream chunks must be read in order.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
    resetRouterState();
  }

  assert.equal(generationCount, 2);
  assert.equal(calls[1].maxOutputTokens, 1536);
  assert.match(JSON.stringify(calls[1].prompt), /The current question/);
  assert.ok(!JSON.stringify(calls[1].prompt).includes("An older question"));
  assert.ok(
    parts.some(
      (part) =>
        part.type === "text-delta" && part.delta === "A bounded retry worked."
    )
  );
});

test("runs webSearch then webFetch as app-owned structured tools", async () => {
  const toolCallResponse = (id: string, name: string, argumentsJson: string) =>
    sseResponse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  function: { arguments: "", name },
                  id,
                  index: 0,
                  type: "function",
                },
              ],
            },
            index: 0,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  function: { arguments: argumentsJson },
                  index: 0,
                },
              ],
            },
            index: 0,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
    ]);
  const responses = [
    toolCallResponse(
      "call-web-search",
      "webSearch",
      '{"query":"photosynthesis"}'
    ),
    toolCallResponse(
      "call-web-fetch",
      "webFetch",
      '{"url":"https://example.edu/photosynthesis"}'
    ),
    sseResponse([
      {
        choices: [
          {
            delta: { content: "Photosynthesis uses sunlight to make food." },
            index: 0,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
    ]),
  ];
  const requestBodies: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestBodies.push(body);
    const response = responses.shift();
    assert.ok(response, "the model should finish after two app tool calls");
    return Promise.resolve(response);
  };
  const provider = createOpenAICompatible({
    apiKey: "test-hf-read-token",
    baseURL: TEST_BASE_URL,
    fetch: createGptOssFetch(
      {
        apiKey: "test-bridge-key",
        baseUrl: TEST_BASE_URL,
        modelId: "gpt-oss-20b",
        reasoningLevel: "low",
      },
      fetchImpl
    ),
    headers: { "X-API-Key": "test-bridge-key" },
    name: "gpt-oss-tool-chain-test",
  });
  const model = provider.chatModel("gpt-oss-20b");
  const candidate: RouteCandidate = {
    create: () => model,
    id: "gpt-oss:tool-chain-test",
    kind: "gpt-oss",
    reasoning: { control: "effort", defaultLevel: "low" },
    tier: "gpt-oss",
    vision: false,
  };
  const routed = createRoutedModel({
    deadline: Date.now() + 10_000,
    firstOutputMs: { primary: 1000, standard: 1000 },
    plan: () => Promise.resolve([candidate]),
    purpose: "chat",
    reasoningLevel: "low",
    routeMode: "study",
    sleep: () => Promise.resolve(),
  });
  const toolExecutions: string[] = [];
  try {
    const result = streamText({
      maxRetries: 0,
      model: routed,
      prompt: "Find a reliable page that explains photosynthesis.",
      stopWhen: isStepCount(4),
      tools: {
        webFetch: tool({
          description: "Read a page found by webSearch.",
          execute: ({ url }) => {
            toolExecutions.push(`webFetch:${url}`);
            return {
              text: "Plants use light energy to turn water and carbon dioxide into sugars.",
            };
          },
          inputSchema: z.object({ url: z.string().url() }),
        }),
        webSearch: tool({
          description: "Find a relevant study source.",
          execute: ({ query }) => {
            toolExecutions.push(`webSearch:${query}`);
            return { url: "https://example.edu/photosynthesis" };
          },
          inputSchema: z.object({ query: z.string() }),
        }),
      },
    });
    const answer = await result.text;

    assert.equal(answer, "Photosynthesis uses sunlight to make food.");
    assert.deepEqual(toolExecutions, [
      "webSearch:photosynthesis",
      "webFetch:https://example.edu/photosynthesis",
    ]);
    assert.equal(requestBodies.length, 3);
    const secondMessages = requestBodies[1].messages as Array<{
      role: string;
      tool_call_id?: string;
      tool_calls?: Array<{ function: { name: string } }>;
    }>;
    assert.ok(
      secondMessages.some(
        (message) =>
          message.role === "assistant" &&
          message.tool_calls?.some((call) => call.function.name === "webSearch")
      )
    );
    assert.ok(
      secondMessages.some(
        (message) =>
          message.role === "tool" && message.tool_call_id === "call-web-search"
      )
    );
    const thirdMessages = requestBodies[2].messages as Array<{
      name?: string;
      role: string;
      tool_calls?: Array<{ function: { name: string } }>;
    }>;
    assert.ok(
      thirdMessages.some(
        (message) =>
          message.role === "assistant" &&
          message.tool_calls?.some((call) => call.function.name === "webFetch")
      )
    );
    assert.ok(
      !answer.includes('{"query":"photosynthesis"}') &&
        !answer.includes('{"url":"https://example.edu/photosynthesis"}')
    );
  } finally {
    resetRouterState();
  }
});
