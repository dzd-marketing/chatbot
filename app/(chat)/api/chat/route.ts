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
import type { DzdStreamHooks } from "@/lib/ai/dzd";
import {
  DZD_LEARN_MODEL_ID,
  dzdLearnCapabilities,
  dzdLearnModel,
  resolveReasoningLevel,
} from "@/lib/ai/models";
import {
  openCodeSessionKey as makeOpenCodeSessionKey,
  resetOpenCodeSessionsForChats,
} from "@/lib/ai/opencode";
import {
  type RequestHints,
  systemPrompt,
  voiceSystemPrompt,
} from "@/lib/ai/prompts";
import { getLanguageModel } from "@/lib/ai/providers";
import { describeError, routerErrorMessage } from "@/lib/ai/router";
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
import { markStopped } from "@/lib/chat/stopped";
import { fallbackTitleFromText, titleTextFromParts } from "@/lib/chat/title";
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
import { voiceMessagesForModel } from "@/lib/voice-message";
import { heardOfLastReply } from "@/lib/voice-speech";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

// Replies may browse the web for a few minutes, and the last-resort model
// runs on CPU (see lib/ai/router.ts and lib/ai/dzd.ts).
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

    // Always TheStudent AI: the model behind each reply is picked on the
    // server (lib/ai/router.ts). A model id sent by an older client is
    // ignored.
    const chatModel = DZD_LEARN_MODEL_ID;

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
        title: fallbackTitleFromText(titleTextFromParts(message.parts)),
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

    const modelConfig = dzdLearnModel;
    const supportsTools = dzdLearnCapabilities.tools;
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
    // (The CPU fallback model gets a shorter version; see the router.)
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

        // TheStudent AI: the Space's progress updates and tool telemetry are
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
        // A voice call gets its own system prompt instead of the chat one:
        // the chat prompt asks for headings, lists, LaTeX and links.
        const interruptedAfter = voice
          ? heardOfLastReply(uiMessages, voice.interruptedAfterWords)
          : undefined;
        const voiceInstructions = (builtInWebSearch: boolean) =>
          voice
            ? voiceSystemPrompt({
                builtInWebSearch,
                calculator: toolSettings.calculator,
                interruptedAfter,
                language: voice.language,
                requestHints,
                supportsTools: builtInWebSearch ? false : supportsTools,
                webSearch: toolSettings.webSearch,
              })
            : null;
        const instructions =
          voiceInstructions(false) ??
          systemPrompt({
            builtInWebSearch: false,
            calculator: toolSettings.calculator,
            documents: toolSettings.documents,
            pageReading: toolSettings.webFetch,
            requestHints,
            study: toolSettings.study,
            supportsTools,
            webSearch: toolSettings.webSearch,
          });
        // If the reply falls back to TheStudent's own model: it searches the web on
        // its own server and has none of the website's tools.
        const dzdInstructions =
          voiceInstructions(true) ??
          systemPrompt({
            builtInWebSearch: true,
            calculator: false,
            documents: false,
            pageReading: false,
            requestHints,
            study: false,
            supportsTools: false,
            webSearch: toolSettings.webSearch,
          });
        // The private OpenCode Space uses a hardened no-tools tutor agent.
        // Don't let this fallback claim it can use tools from the website.
        const openCodeInstructions = voice
          ? voiceSystemPrompt({
              builtInWebSearch: false,
              calculator: false,
              interruptedAfter,
              language: voice.language,
              requestHints,
              supportsTools: false,
              webSearch: false,
            })
          : systemPrompt({
              builtInWebSearch: false,
              calculator: false,
              documents: false,
              pageReading: false,
              requestHints,
              study: false,
              supportsTools: false,
              webSearch: false,
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
            dzdHooks,
            dzdInstructions,
            onEvent(event) {
              // Never names a model or provider.
              writeWaitingStatus(
                "still-waiting",
                event.type === "retry-wait"
                  ? "Lots of students are studying right now. Retrying..."
                  : "Still working on it..."
              );
            },
            openCodeInstructions,
            openCodeSessionKey: makeOpenCodeSessionKey(id),
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

        // Only writes when the reply came from TheStudent's own model.
        const dzdActivityTask = (async () => {
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
        })();

        // Follow-up suggestions: generated once the answer is complete and
        // written as a persisted data part on the same assistant message.
        // Not in voice conversations: the call waits for the reply to end.
        const suggestionsTask =
          isTestEnvironment || voice
            ? Promise.resolve()
            : (async () => {
                try {
                  const [finishReason, answer] = await Promise.all([
                    result.finishReason,
                    result.text,
                  ]);
                  if (
                    request.signal.aborted ||
                    (finishReason !== "stop" && finishReason !== "length")
                  ) {
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
            await updateChatTitleById({ chatId: id, title });
          } catch {
            /* non-fatal */
          }
        }

        await Promise.all([dzdActivityTask, suggestionsTask]);
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

  try {
    await resetOpenCodeSessionsForChats([id]);
  } catch {
    // Don't report a successful deletion while the private Space still has
    // a session mapped to this chat.
    return new ChatbotError("offline:history").toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
