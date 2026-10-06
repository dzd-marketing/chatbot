import { geolocation } from "@vercel/functions";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  isStepCount,
  smoothStream,
  streamText,
  toUIMessageStream,
} from "ai";
import { checkBotId } from "botid/server";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { auth } from "@/app/(auth)/auth";
import { findChatModel, getAllCapabilities } from "@/lib/ai/available-models";
import {
  DZD_HISTORY_MESSAGES,
  type DzdStreamHooks,
  getDzdMaxTokens,
  isDzdModel,
} from "@/lib/ai/dzd";
import {
  chatModels,
  DEFAULT_CHAT_MODEL,
  getModelAvailability,
  resolveReasoningLevel,
} from "@/lib/ai/models";
import { isNvidiaModel, nvidiaErrorMessage } from "@/lib/ai/nvidia";
import { type RequestHints, systemPrompt } from "@/lib/ai/prompts";
import { getLanguageModel } from "@/lib/ai/providers";
import { createPrepareStep, MAX_STEPS } from "@/lib/ai/step-limits";
import { generateFollowUpSuggestions } from "@/lib/ai/suggestions";
import { activeToolNames, resolveToolSettings } from "@/lib/ai/tool-groups";
import { calculate } from "@/lib/ai/tools/calculate";
import { createDocument } from "@/lib/ai/tools/create-document";
import { editDocument } from "@/lib/ai/tools/edit-document";
import { getWeather } from "@/lib/ai/tools/get-weather";
import { readDocument } from "@/lib/ai/tools/read-document";
import { requestSuggestions } from "@/lib/ai/tools/request-suggestions";
import { shareFiles } from "@/lib/ai/tools/share-files";
import { createFlashcards, createQuiz } from "@/lib/ai/tools/study";
import { updateDocument } from "@/lib/ai/tools/update-document";
import { webFetch, webSearch } from "@/lib/ai/tools/web";
import { isProductionEnvironment, isTestEnvironment } from "@/lib/constants";
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessagesByChatId,
  saveChat,
  saveMessages,
  updateChatTitleById,
  updateMessage,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { inlineDocumentAttachments } from "@/lib/documents/attachments";
import { ChatbotError } from "@/lib/errors";
import type {
  ChatMessage,
  DzdActivityData,
  WaitingStatusData,
} from "@/lib/types";
import {
  convertToUIMessages,
  generateUUID,
  getTextFromMessage,
} from "@/lib/utils";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

// DZD Learn AI runs on CPU and may search the web first, so a reply can take
// a few minutes (its upstream limit is DZD_TIMEOUT_MS in lib/ai/dzd.ts).
export const maxDuration = 300;

const HEALTH_CHECK_DELAY_MS = 9000;

function isModelStreamActivity(chunk: { type: string }) {
  return !["start", "start-step", "finish-step", "finish", "raw"].includes(
    chunk.type
  );
}

/** The latest turns, starting with a user message. */
function recentHistory(messages: ChatMessage[], limit: number) {
  const recent = messages.slice(-limit);
  const firstUser = recent.findIndex((m) => m.role === "user");
  return firstUser > 0 ? recent.slice(firstUser) : recent;
}

function getStreamContext() {
  try {
    return createResumableStreamContext({ waitUntil: after });
  } catch {
    return null;
  }
}

export { getStreamContext };

export async function POST(request: Request) {
  // The tool time budget (lib/ai/step-limits.ts) counts from here.
  const startedAt = Date.now();
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch {
    return new ChatbotError("bad_request:api").toResponse();
  }

  try {
    const {
      id,
      message,
      messages,
      reasoning,
      selectedChatModel,
      selectedVisibilityType,
      tools: requestedTools,
      webSearch: webSearchRequested,
    } = requestBody;

    const [botIdResult, session] = await Promise.all([
      checkBotId().catch(() => null),
      auth(),
    ]);

    if (botIdResult?.isBot) {
      return new ChatbotError("forbidden:api").toResponse();
    }

    if (!session?.user) {
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    // Curated models plus NVIDIA models discovered at runtime.
    const requestedModel = await findChatModel(selectedChatModel);
    const chatModel = requestedModel ? selectedChatModel : DEFAULT_CHAT_MODEL;

    // No message limits: students can chat as much as they need.

    const isToolApprovalFlow = Boolean(messages);

    const chat = await getChatById({ id });
    let messagesFromDb: DBMessage[] = [];
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      if (chat.userId !== session.user.id) {
        return new ChatbotError("forbidden:chat").toResponse();
      }
      messagesFromDb = await getMessagesByChatId({ id });
    } else if (message?.role === "user") {
      await saveChat({
        id,
        title: "New chat",
        userId: session.user.id,
        visibility: selectedVisibilityType,
      });
      titlePromise = generateTitleFromUserMessage({ message });
    }

    let uiMessages: ChatMessage[];

    if (isToolApprovalFlow && messages) {
      const dbMessages = convertToUIMessages(messagesFromDb);
      const approvalStates = new Map(
        messages.flatMap(
          (m) =>
            m.parts
              ?.filter(
                (p: Record<string, unknown>) =>
                  p.state === "approval-responded" ||
                  p.state === "output-denied"
              )
              .map((p: Record<string, unknown>) => [
                String(p.toolCallId ?? ""),
                p,
              ]) ?? []
        )
      );
      uiMessages = dbMessages.map((msg) => ({
        ...msg,
        parts: msg.parts.map((part) => {
          if (
            "toolCallId" in part &&
            approvalStates.has(String(part.toolCallId))
          ) {
            return { ...part, ...approvalStates.get(String(part.toolCallId)) };
          }
          return part;
        }),
      })) as ChatMessage[];
    } else {
      uiMessages = [
        ...convertToUIMessages(messagesFromDb),
        message as ChatMessage,
      ];
    }

    const { longitude, latitude, city, country } = geolocation(request);

    const requestHints: RequestHints = {
      city,
      country,
      latitude,
      longitude,
    };

    if (message?.role === "user") {
      await saveMessages({
        messages: [
          {
            attachments: [],
            chatId: id,
            createdAt: new Date(),
            id: message.id,
            parts: message.parts,
            role: "user",
          },
        ],
      });
    }

    const modelConfig =
      requestedModel ?? chatModels.find((m) => m.id === chatModel);
    const modelCapabilities = await getAllCapabilities();
    const capabilities = modelCapabilities[chatModel];
    const isReasoningModel = capabilities?.reasoning === true;
    const supportsTools = capabilities?.tools === true;
    // The student's Tools menu; older clients only send `webSearch`.
    const toolSettings = resolveToolSettings({
      webSearch: webSearchRequested,
      ...requestedTools,
    });
    const reasoningLevel = resolveReasoningLevel(modelConfig, reasoning);
    const isDzd = isDzdModel(chatModel);
    const builtInWebSearch = capabilities?.builtInWebSearch === true;

    // Uploaded PDF / Word / text files become text the model can read.
    // DZD Learn AI runs on CPU, so it gets a much smaller share.
    const modelMessages = await convertToModelMessages(
      inlineDocumentAttachments(
        isDzd ? recentHistory(uiMessages, DZD_HISTORY_MESSAGES) : uiMessages,
        isDzd
          ? { perDocumentChars: 8000, totalChars: 12_000 }
          : { perDocumentChars: 60_000, totalChars: 120_000 }
      )
    );

    const stream = createUIMessageStream({
      execute: async ({ writer: dataStream }) => {
        const modelName = modelConfig?.name ?? chatModel;
        let hasModelActivity = false;
        let healthCheckTimer: ReturnType<typeof setTimeout> | undefined;

        const clearHealthCheckTimer = () => {
          if (healthCheckTimer) {
            clearTimeout(healthCheckTimer);
          }
        };

        const writeWaitingStatus = (
          phase: WaitingStatusData["phase"],
          messageText: string
        ) => {
          if (hasModelActivity && phase !== "thinking") {
            return;
          }
          dataStream.write({
            data: {
              message: messageText,
              modelId: chatModel,
              modelName,
              phase,
            },
            transient: true,
            type: "data-waiting-status",
          });
        };

        writeWaitingStatus("waiting", "Waiting...");

        healthCheckTimer = setTimeout(() => {
          getModelAvailability(chatModel)
            .then((availability) => {
              if (availability === "impacted") {
                writeWaitingStatus(
                  "health",
                  `${modelName} may be slow or unavailable right now...`
                );
              } else {
                writeWaitingStatus("still-waiting", "Still waiting...");
              }
            })
            .catch(() => {
              writeWaitingStatus("still-waiting", "Still waiting...");
            });
        }, HEALTH_CHECK_DELAY_MS);

        const markModelActive = () => {
          if (hasModelActivity) {
            return;
          }
          hasModelActivity = true;
          clearHealthCheckTimer();
          writeWaitingStatus("thinking", "Thinking...");
        };

        const stopWaitingStatus = () => {
          hasModelActivity = true;
          clearHealthCheckTimer();
        };

        // DZD Learn AI: the Space's progress updates and tool telemetry are
        // shown as one data part, updated in place and saved with the reply.
        const dzdActivityId = generateUUID();
        const dzd: { activity: DzdActivityData | null } = { activity: null };

        const writeDzdActivity = () => {
          const { activity } = dzd;
          if (activity) {
            dataStream.write({
              data: { ...activity, progress: [...activity.progress] },
              id: dzdActivityId,
              type: "data-dzd-activity",
            });
          }
        };

        const dzdHooks: DzdStreamHooks = {
          onProgress(text) {
            markModelActive();
            dzd.activity ??= { progress: [], status: "running" };
            if (dzd.activity.progress.at(-1) === text) {
              return;
            }
            dzd.activity.progress = [...dzd.activity.progress, text].slice(-12);
            writeDzdActivity();
          },
          onTelemetry({ toolSteps, totalMs }) {
            dzd.activity ??= { progress: [], status: "running" };
            if (toolSteps) {
              dzd.activity.toolSteps = toolSteps;
            }
            if (totalMs !== undefined) {
              dzd.activity.totalMs = totalMs;
            }
          },
        };

        const enabledTools = supportsTools ? activeToolNames(toolSettings) : [];
        const instructions = systemPrompt({
          builtInWebSearch,
          calculator: toolSettings.calculator,
          documents: toolSettings.documents,
          pageReading: toolSettings.webFetch,
          requestHints,
          study: toolSettings.study,
          supportsTools,
          webSearch: toolSettings.webSearch,
        });

        const result = streamText({
          // Models without tool support get no tools at all (llama.cpp, for
          // one, rejects requests that include tools unless --jinja is set).
          // Otherwise, only the tools the student left on.
          activeTools: enabledTools,
          // Release text word by word at a steady pace, so the client's
          // word blur-in animation follows reading rhythm instead of bursts.
          experimental_transform: smoothStream({
            chunking: "word",
            delayInMs: 15,
          }),
          instructions,
          ...(isDzd && {
            // Stop the Space's work when the student stops or leaves.
            abortSignal: request.signal,
            maxOutputTokens: getDzdMaxTokens(),
          }),
          messages: modelMessages,
          model: getLanguageModel(chatModel, { dzd: dzdHooks }),
          onAbort() {
            stopWaitingStatus();
          },
          onChunk({ chunk }) {
            if (isModelStreamActivity(chunk)) {
              markModelActive();
            }
          },
          onEnd() {
            stopWaitingStatus();
          },
          onError() {
            stopWaitingStatus();
          },
          // No limit on searches or page reads, only on time; the last
          // step always writes the answer.
          prepareStep: createPrepareStep({
            enabledTools,
            instructions,
            startedAt,
          }),
          stopWhen: isStepCount(MAX_STEPS),
          telemetry: {
            functionId: "stream-text",
            isEnabled: isProductionEnvironment,
          },
          tools: {
            calculate,
            createDocument: createDocument({
              dataStream,
              modelId: chatModel,
              session,
            }),
            createFlashcards,
            createQuiz,
            editDocument: editDocument({ dataStream, session }),
            getWeather,
            readDocument,
            requestSuggestions: requestSuggestions({
              dataStream,
              modelId: chatModel,
              session,
            }),
            shareFiles,
            updateDocument: updateDocument({
              dataStream,
              modelId: chatModel,
              session,
            }),
            webFetch,
            webSearch,
          },
        });

        dataStream.merge(
          toUIMessageStream({
            // NVIDIA models have no reasoning control, but if one streams its
            // thinking, show it.
            sendReasoning:
              (isReasoningModel && reasoningLevel !== "off") ||
              isNvidiaModel(chatModel),
            stream: result.stream,
          })
        );

        const dzdActivityTask = isDzd
          ? (async () => {
              try {
                await result.finishReason;
              } catch {
                /* still mark the activity as finished */
              }
              const { activity } = dzd;
              const hasSteps =
                activity !== null &&
                (activity.progress.length > 0 ||
                  (activity.toolSteps?.length ?? 0) > 0);
              if (activity && hasSteps) {
                activity.status = "done";
                try {
                  writeDzdActivity();
                } catch {
                  /* the stream may already be closed */
                }
              }
            })()
          : Promise.resolve();

        // Follow-up suggestions: generated once the answer is complete and
        // written as a persisted data part on the same assistant message.
        const suggestionsTask = isTestEnvironment
          ? Promise.resolve()
          : (async () => {
              try {
                const [finishReason, answer] = await Promise.all([
                  result.finishReason,
                  result.text,
                ]);
                if (finishReason !== "stop" && finishReason !== "length") {
                  return;
                }
                const lastUserMessage =
                  message ?? uiMessages.findLast((m) => m.role === "user");
                const suggestions = await generateFollowUpSuggestions({
                  answer,
                  question: lastUserMessage
                    ? getTextFromMessage(lastUserMessage)
                    : "",
                });
                if (suggestions.length > 0) {
                  dataStream.write({
                    data: suggestions,
                    type: "data-suggestions",
                  });
                }
              } catch {
                /* suggestions are optional */
              }
            })();

        if (titlePromise) {
          try {
            const title = await titlePromise;
            dataStream.write({ data: title, type: "data-chat-title" });
            updateChatTitleById({ chatId: id, title });
          } catch {
            /* non-fatal */
          }
        }

        await Promise.all([dzdActivityTask, suggestionsTask]);
      },
      generateId: generateUUID,
      onEnd: async ({ messages: finishedMessages }) => {
        if (isToolApprovalFlow) {
          await Promise.all(
            finishedMessages.map(async (finishedMsg) => {
              const existingMsg = uiMessages.find(
                (m) => m.id === finishedMsg.id
              );
              if (existingMsg) {
                await updateMessage({
                  id: finishedMsg.id,
                  parts: finishedMsg.parts,
                });
                return;
              }

              await saveMessages({
                messages: [
                  {
                    attachments: [],
                    chatId: id,
                    createdAt: new Date(),
                    id: finishedMsg.id,
                    parts: finishedMsg.parts,
                    role: finishedMsg.role,
                  },
                ],
              });
            })
          );
        } else if (finishedMessages.length > 0) {
          await saveMessages({
            messages: finishedMessages.map((currentMessage) => ({
              attachments: [],
              chatId: id,
              createdAt: new Date(),
              id: currentMessage.id,
              parts: currentMessage.parts,
              role: currentMessage.role,
            })),
          });
        }
      },
      onError: (error) => {
        if (
          error instanceof Error &&
          error.message?.includes(
            "AI Gateway requires a valid credit card on file to service requests"
          )
        ) {
          return "AI Gateway requires a valid credit card on file to service requests. Please visit https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card to add a card and unlock your free credits.";
        }
        if (isNvidiaModel(chatModel)) {
          return nvidiaErrorMessage(error);
        }
        if (isDzd) {
          if (
            error instanceof Error &&
            error.message.includes("Missing HF_READ_TOKEN")
          ) {
            return "DZD Learn AI isn't set up on this server yet. Please choose another model for now.";
          }
          if (error instanceof Error && error.name === "DzdTimeoutError") {
            return "DZD Learn AI took too long to answer. Please try a shorter question, or choose another model.";
          }
          return "DZD Learn AI isn't responding right now. Its server may be waking up, so please try again in a minute or choose another model.";
        }
        return "Oops, an error occurred!";
      },
      originalMessages: isToolApprovalFlow ? uiMessages : undefined,
    });

    return createUIMessageStreamResponse({
      async consumeSseStream({ stream: sseStream }) {
        if (!process.env.REDIS_URL) {
          return;
        }
        try {
          const streamContext = getStreamContext();
          if (streamContext) {
            const streamId = generateId();
            await createStreamId({ chatId: id, streamId });
            await streamContext.createNewResumableStream(
              streamId,
              () => sseStream
            );
          }
        } catch {
          /* non-critical */
        }
      },
      stream,
    });
  } catch (error) {
    const vercelId = request.headers.get("x-vercel-id");

    if (error instanceof ChatbotError) {
      return error.toResponse();
    }

    if (
      error instanceof Error &&
      error.message?.includes(
        "AI Gateway requires a valid credit card on file to service requests"
      )
    ) {
      return new ChatbotError("bad_request:activate_gateway").toResponse();
    }

    console.error("Unhandled error in chat API:", error, { vercelId });
    return new ChatbotError("offline:chat").toResponse();
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatbotError("bad_request:api").toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const chat = await getChatById({ id });

  if (chat?.userId !== session.user.id) {
    return new ChatbotError("forbidden:chat").toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
