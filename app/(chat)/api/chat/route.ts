import { geolocation } from "@vercel/functions";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  isStepCount,
  type ModelMessage,
  smoothStream,
  streamText,
  toUIMessageStream,
  type UserContent,
} from "ai";
import { checkBotId } from "botid/server";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { auth } from "@/app/(auth)/auth";
import {
  DEFAULT_CHAT_MODEL,
  getChatModel,
  getModelCapabilities,
  resolveReasoningLevel,
} from "@/lib/ai/models";
import {
  type RequestHints,
  systemPrompt,
  voiceSystemPrompt,
} from "@/lib/ai/prompts";
import { getLanguageModel } from "@/lib/ai/providers";
import { describeError, routerErrorMessage } from "@/lib/ai/router";
import { createPrepareStep, MAX_STEPS } from "@/lib/ai/step-limits";
import { activeToolNames, resolveToolSettings } from "@/lib/ai/tool-groups";
import { isExamResourceRequest } from "@/lib/ai/tool-intent";
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
import { markStopped } from "@/lib/chat/stopped";
import { fallbackTitleFromText, titleTextFromParts } from "@/lib/chat/title";
import { isProductionEnvironment } from "@/lib/constants";
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessagesByChatId,
  saveChat,
  saveMessages,
  updateMessage,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { inlineDocumentAttachments } from "@/lib/documents/attachments";
import { ChatbotError } from "@/lib/errors";
import type { ChatMessage, WaitingStatusData } from "@/lib/types";
import { convertToUIMessages, generateUUID } from "@/lib/utils";
import { voiceMessagesForModel } from "@/lib/voice-message";
import { heardOfLastReply } from "@/lib/voice-speech";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

// Allow time for web research and provider retries.
export const maxDuration = 300;

/** A reply must have started by then, leaving time to finish and save. */
const ROUTING_DEADLINE_MS = 285_000;

const HEALTH_CHECK_DELAY_MS = 9000;

function isModelStreamActivity(chunk: { type: string }) {
  return !["start", "start-step", "finish-step", "finish", "raw"].includes(
    chunk.type
  );
}

/** The reply shape for this turn, next to the newest message. */
const SPOKEN_REMINDER = {
  deep: "(Voice call, thoughtful answer: think it through first. Then the spoken part in plain sentences: the main answer and the two or three most important points, each with a short reason or example, about eighty to one hundred and twenty words, ending with one question if it helps. If a plan, timetable, longer list or worked solution would help, add it after the spoken part as a written part for the chat, starting with a short ### heading. Only the spoken part is read aloud.)",
  quick:
    "(Voice call, quick answer: one to three short spoken sentences, plain words only. No lists, headings, symbols or formulas.)",
} as const;

/** Adds the voice-call reminder to the newest student message. */
function withSpokenReminder(
  messages: ModelMessage[],
  depth: keyof typeof SPOKEN_REMINDER
): ModelMessage[] {
  const last = messages.at(-1);
  if (last?.role !== "user") {
    return messages;
  }
  const reminder = SPOKEN_REMINDER[depth];
  const content: UserContent =
    typeof last.content === "string"
      ? `${last.content}\n\n${reminder}`
      : [...last.content, { text: reminder, type: "text" }];
  return [...messages.slice(0, -1), { ...last, content }];
}

function newUserMessageText(message: PostRequestBody["message"]) {
  if (!message) {
    return "";
  }
  return message.parts
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "data-voice") {
        return part.data.words.map((word) => word.text).join(" ");
      }
      return "";
    })
    .join("\n");
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
      selectedVisibilityType,
      tools: requestedTools,
      voice,
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

    // A stale client may submit a legacy model ID; the schema normalizes it
    // and the server always runs the automatic provider route.
    const chatModel = DEFAULT_CHAT_MODEL;

    // No message limits: students can chat as much as they need.

    const isToolApprovalFlow = Boolean(messages);

    const chat = await getChatById({ id });
    let messagesFromDb: DBMessage[] = [];

    if (chat) {
      if (chat.userId !== session.user.id) {
        return new ChatbotError("forbidden:chat").toResponse();
      }
      messagesFromDb = await getMessagesByChatId({ id });
    } else if (message?.role === "user") {
      await saveChat({
        id,
        title: fallbackTitleFromText(titleTextFromParts(message.parts)),
        userId: session.user.id,
        visibility: selectedVisibilityType,
      });
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

    const modelConfig = getChatModel(chatModel);
    const supportsTools = getModelCapabilities(chatModel).tools;
    // The student's Tools menu; older clients only send `webSearch`.
    // A voice conversation can't show quizzes, flashcards or documents.
    const toolSettings = resolveToolSettings({
      webSearch: webSearchRequested,
      ...requestedTools,
      // Reading whole web pages is too slow for a spoken answer.
      ...(voice ? { documents: false, study: false, webFetch: false } : {}),
    });
    // Fast (thinking off) or Thinking.
    // Voice conversations answer fast (someone is waiting), unless the
    // question needs thought (planning, advice, why...); the call says a
    // "let me think" line meanwhile.
    let reasoningLevel = resolveReasoningLevel(modelConfig, reasoning);
    if (voice) {
      reasoningLevel = voice.depth === "deep" ? "medium" : "off";
    }

    // Uploaded PDF / Word / text files become text the model can read.
    // Voice messages: the model reads the transcript, not the audio.
    // (The GPT-OSS fallback gets bounded context; see the router.)
    const convertedMessages = await convertToModelMessages(
      inlineDocumentAttachments(voiceMessagesForModel(uiMessages), {
        perDocumentChars: 60_000,
        totalChars: 120_000,
      })
    );
    // In a call, remind the model right next to the newest message that the
    // reply is spoken: earlier written answers in the chat pull the other way.
    const modelMessages = voice
      ? withSpokenReminder(convertedMessages, voice.depth ?? "quick")
      : convertedMessages;

    const stream = createUIMessageStream({
      execute: ({ writer: dataStream }) => {
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
          writeWaitingStatus("still-waiting", "Still working on it...");
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

        const enabledTools = supportsTools ? activeToolNames(toolSettings) : [];
        const requiredFirstTool =
          enabledTools.includes("webSearch") &&
          isExamResourceRequest(newUserMessageText(message))
            ? "webSearch"
            : undefined;
        // A voice call gets its own system prompt instead of the chat one:
        // the chat prompt asks for headings, lists, LaTeX and links.
        const interruptedAfter = voice
          ? heardOfLastReply(uiMessages, voice.interruptedAfterWords)
          : undefined;
        const instructions = voice
          ? voiceSystemPrompt({
              builtInWebSearch: false,
              calculator: toolSettings.calculator,
              interruptedAfter,
              language: voice.language,
              requestHints,
              supportsTools,
              webSearch: toolSettings.webSearch,
            })
          : systemPrompt({
              builtInWebSearch: false,
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
          // Voice replies are spoken, not animated: no pacing delay.
          ...(!voice && {
            experimental_transform: smoothStream({
              chunking: "word",
              delayInMs: 15,
            }),
          }),
          // Stop generating when the student presses Stop (or leaves), so
          // the partial reply is saved and no quota is wasted. With Redis
          // resumable streams, replies keep going so they can be resumed.
          ...(!process.env.REDIS_URL && {
            abortSignal: request.signal,
          }),
          instructions,
          // Busy models are handled by the router (next model, then up to
          // three timed retry rounds), so the SDK doesn't retry on top.
          maxRetries: 0,
          messages: modelMessages,
          model: getLanguageModel(chatModel, {
            deadline: startedAt + ROUTING_DEADLINE_MS,
            onEvent(event) {
              // Never names a model or provider.
              writeWaitingStatus(
                "still-waiting",
                event.type === "retry-wait"
                  ? "Lots of students are studying right now. Retrying..."
                  : "Still working on it..."
              );
            },
            // Voice: the quick model first, and less waiting on slow ones.
            purpose: voice ? "voice" : "chat",
            reasoningLevel,
          }),
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
          onFinish({ finishReason, stepNumber, toolCalls }) {
            if (
              requiredFirstTool ||
              finishReason === "length" ||
              toolCalls.length > 0
            ) {
              console.info("[chat-generation] completed", {
                finishReason,
                requestId: request.headers.get("x-vercel-id") ?? undefined,
                requiredFirstTool: requiredFirstTool ?? null,
                stepCount: stepNumber + 1,
                toolNames: toolCalls.map((call) => call.toolName),
              });
            }
          },
          // No limit on searches or page reads, only on time; the last
          // step always writes the answer.
          prepareStep: createPrepareStep({
            enabledTools,
            instructions,
            requiredFirstTool,
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
            // Without this, a failed reply only says "An error occurred.".
            onError(error) {
              console.error(`Chat reply failed: ${describeError(error)}`, {
                chatId: id,
                vercelId: request.headers.get("x-vercel-id"),
              });
              return routerErrorMessage(error);
            },
            // Some models always think, even in Fast mode; show it if so.
            sendReasoning: true,
            stream: result.stream,
          })
        );

        // Titles and follow-up suggestions are generated by /api/chat/finalize
        // after this answer is saved. Keep optional work off the reply stream so
        // the composer becomes ready as soon as the answer has finished.
      },
      generateId: generateUUID,
      onEnd: async ({ messages: endedMessages, isAborted }) => {
        // A stopped reply is saved as written so far, with a notice.
        const finishedMessages = isAborted
          ? endedMessages.map((endedMessage, index) =>
              index === endedMessages.length - 1 &&
              endedMessage.role === "assistant"
                ? { ...endedMessage, parts: markStopped(endedMessage.parts) }
                : endedMessage
            )
          : endedMessages;
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
        console.error(`Chat request failed: ${describeError(error)}`, {
          chatId: id,
          vercelId: request.headers.get("x-vercel-id"),
        });
        return routerErrorMessage(error);
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
