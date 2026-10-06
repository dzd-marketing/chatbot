"use client";
import type { UseChatHelpers } from "@ai-sdk/react";
import { useCallback } from "react";
import type { Vote } from "@/lib/db/schema";
import { parseFeatureMessage } from "@/lib/study-features";
import type { ChatMessage } from "@/lib/types";
import { cn, sanitizeText } from "@/lib/utils";
import { isVoiceAudioPart } from "@/lib/voice-message";
import { MessageContent, MessageResponse } from "../ai-elements/message";
import { Shimmer } from "../ai-elements/shimmer";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "../ai-elements/tool";
import { Calculation } from "./calculation";
import { useDataStream } from "./data-stream-provider";
import { DocumentToolResult } from "./document";
import { DocumentPreview } from "./document-preview";
import { DzdActivity } from "./dzd-activity";
import { FileCards, FileCardsSkeleton } from "./file-cards";
import { Flashcards, FlashcardsSkeleton } from "./flashcards";
import { FollowUpSuggestions } from "./follow-up-suggestions";
import { DzdLogoMark } from "./icons";
import { MessageActions } from "./message-actions";
import { MessageReasoning } from "./message-reasoning";
import { PreviewAttachment } from "./preview-attachment";
import { Quiz, QuizSkeleton } from "./quiz";
import { StoppedNotice } from "./stopped-notice";
import { FeatureChip } from "./study-features";
import { VoiceMessage } from "./voice-message";
import { Weather } from "./weather";
import {
  isResearchPart,
  isWebToolPart,
  type ResearchPart,
  WebResearch,
} from "./web-research";

function WaitingText() {
  const { waitingStatus } = useDataStream();
  const waitingText = waitingStatus?.message ?? "Waiting...";

  return (
    <div className="flex min-h-[calc(15px*1.65)] min-w-0 items-center text-[15px] leading-[1.65]">
      <Shimmer
        as="span"
        className="font-medium whitespace-normal break-words"
        duration={1}
      >
        {waitingText}
      </Shimmer>
    </div>
  );
}

function ToolApprovalActions({
  addToolApprovalResponse,
  approvalId,
}: {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  approvalId: string;
}) {
  const handleDeny = useCallback(() => {
    addToolApprovalResponse({
      approved: false,
      id: approvalId,
      reason: "User denied weather lookup",
    });
  }, [addToolApprovalResponse, approvalId]);

  const handleAllow = useCallback(() => {
    addToolApprovalResponse({
      approved: true,
      id: approvalId,
    });
  }, [addToolApprovalResponse, approvalId]);

  return (
    <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
      <button
        className="rounded-md px-3 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
        onClick={handleDeny}
        type="button"
      >
        Deny
      </button>
      <button
        className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-sm transition-colors hover:bg-primary/90"
        onClick={handleAllow}
        type="button"
      >
        Allow
      </button>
    </div>
  );
}

const PurePreviewMessage = ({
  addToolApprovalResponse,
  chatId,
  message,
  vote,
  isLoading,
  setMessages: _setMessages,
  regenerate: _regenerate,
  isReadonly,
  requiresScrollPadding: _requiresScrollPadding,
  onEdit,
  showSuggestions = false,
}: {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  chatId: string;
  message: ChatMessage;
  vote: Vote | undefined;
  isLoading: boolean;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  isReadonly: boolean;
  requiresScrollPadding: boolean;
  onEdit?: (message: ChatMessage) => void;
  /** Show follow-up chips (latest assistant reply, chat idle, not readonly). */
  showSuggestions?: boolean;
}) => {
  // A voice message: its recording plays in the voice card instead.
  const voiceAudio = message.parts.find(
    (part) => part.type === "file" && isVoiceAudioPart(part)
  );
  const voiceData = message.parts.find((part) => part.type === "data-voice");
  const isVoiceMessage = Boolean(voiceAudio && voiceData);
  const attachmentsFromMessage = message.parts.filter(
    (part): part is Extract<typeof part, { type: "file" }> =>
      part.type === "file" && !isVoiceAudioPart(part)
  );

  useDataStream();

  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  const hasAnyContent = message.parts?.some(
    (part) =>
      (part.type === "text" && part.text?.trim().length > 0) ||
      (part.type === "reasoning" &&
        "text" in part &&
        part.text?.trim().length > 0) ||
      part.type.startsWith("tool-") ||
      part.type === "data-dzd-activity" ||
      part.type === "data-stopped" ||
      part.type === "data-voice"
  );
  const isThinking = isAssistant && isLoading && !hasAnyContent;

  const attachments = attachmentsFromMessage.length > 0 && (
    <div
      className="flex flex-row justify-end gap-2"
      data-testid={"message-attachments"}
    >
      {attachmentsFromMessage.map((attachment) => (
        <PreviewAttachment
          attachment={{
            contentType: attachment.mediaType,
            // The chat input stores the original file name as `name`.
            name:
              attachment.filename ??
              (attachment as { name?: string }).name ??
              "file",
            url: attachment.url,
          }}
          key={attachment.url}
        />
      ))}
    </div>
  );

  const mergedReasoning = message.parts?.reduce(
    (acc, part) => {
      if (part.type === "reasoning" && part.text?.trim().length > 0) {
        return {
          isStreaming: "state" in part ? part.state === "streaming" : false,
          rendered: false,
          text: acc.text ? `${acc.text}\n\n${part.text}` : part.text,
        };
      }
      return acc;
    },
    { isStreaming: false, rendered: false, text: "" }
  ) ?? { isStreaming: false, rendered: false, text: "" };

  // When DZD AI used web tools, its reasoning and search/read steps are shown
  // together as one chain of thought, placed where the first of them occurs.
  const hasWebActivity = message.parts?.some(isWebToolPart) ?? false;
  const researchParts: ResearchPart[] = hasWebActivity
    ? message.parts.filter(isResearchPart)
    : [];
  const firstResearchIndex = hasWebActivity
    ? message.parts.findIndex(isResearchPart)
    : -1;
  const lastResearchIndex = hasWebActivity
    ? message.parts.findLastIndex(isResearchPart)
    : -1;
  const answerStarted =
    hasWebActivity &&
    message.parts
      .slice(lastResearchIndex + 1)
      .some((part) => part.type === "text" && part.text.trim().length > 0);

  // DZD Learn AI's own web research (progress from its server).
  const dzdActivityIndex =
    message.parts?.findLastIndex((part) => part.type === "data-dzd-activity") ??
    -1;
  const dzdAnswerStarted =
    dzdActivityIndex !== -1 &&
    message.parts
      .slice(dzdActivityIndex + 1)
      .some((part) => part.type === "text" && part.text.trim().length > 0);

  // One document per reply: older replies may contain duplicate
  // createDocument calls, so only the first working one is shown.
  const shownDocumentCallId = message.parts?.find(
    (part) =>
      part.type === "tool-createDocument" &&
      part.state !== "output-error" &&
      !(part.output && "error" in part.output)
  ) as { toolCallId?: string } | undefined;

  const parts = message.parts?.map((part, index) => {
    const { type } = part;
    const key = `message-${message.id}-part-${index}`;

    if (hasWebActivity && isResearchPart(part)) {
      return index === firstResearchIndex ? (
        <WebResearch
          answerStarted={answerStarted}
          isLoading={isLoading}
          key={key}
          parts={researchParts}
        />
      ) : null;
    }

    if (type === "data-dzd-activity") {
      return index === dzdActivityIndex ? (
        <DzdActivity
          answerStarted={dzdAnswerStarted}
          data={part.data}
          isLoading={isLoading}
          key={key}
        />
      ) : null;
    }

    if (type === "reasoning") {
      if (!mergedReasoning.rendered && mergedReasoning.text) {
        mergedReasoning.rendered = true;
        return (
          <MessageReasoning
            isLoading={isLoading || mergedReasoning.isStreaming}
            key={key}
            reasoning={mergedReasoning.text}
          />
        );
      }
      return null;
    }

    if (type === "data-stopped") {
      return <StoppedNotice key={key} />;
    }

    if (type === "data-voice") {
      if (!(voiceAudio && voiceAudio.type === "file")) {
        return null;
      }
      const textPart = message.parts.find((item) => item.type === "text");
      const featureRequest =
        textPart?.type === "text" ? parseFeatureMessage(textPart.text) : null;
      return (
        <div className="flex w-full flex-col items-end gap-2" key={key}>
          {featureRequest ? (
            <FeatureChip feature={featureRequest.feature} />
          ) : null}
          <VoiceMessage
            className="rounded-br-lg shadow-[var(--shadow-card)]"
            data={part.data}
            url={voiceAudio.url}
          />
        </div>
      );
    }

    if (type === "text") {
      if (isUser && isVoiceMessage) {
        return null; // the transcript is shown in the voice card
      }
      // A request made from a welcome-screen feature card.
      const featureRequest = isUser ? parseFeatureMessage(part.text) : null;
      if (featureRequest) {
        return (
          <MessageContent
            className="flex w-fit max-w-[min(80%,56ch)] flex-col items-start gap-2 overflow-hidden break-words rounded-2xl rounded-br-lg border border-border/30 bg-gradient-to-br from-secondary to-muted px-3.5 py-2.5 text-[15px] leading-[1.65] shadow-[var(--shadow-card)]"
            data-testid="message-content"
            key={key}
          >
            <FeatureChip feature={featureRequest.feature} />
            {featureRequest.rest ? (
              <MessageResponse isAnimating={false}>
                {sanitizeText(featureRequest.rest)}
              </MessageResponse>
            ) : null}
          </MessageContent>
        );
      }
      return (
        <MessageContent
          className={cn("text-[15px] leading-[1.65]", {
            "w-fit max-w-[min(80%,56ch)] overflow-hidden break-words rounded-2xl rounded-br-lg border border-border/30 bg-gradient-to-br from-secondary to-muted px-3.5 py-2 shadow-[var(--shadow-card)]":
              message.role === "user",
          })}
          data-testid="message-content"
          key={key}
        >
          <MessageResponse
            isAnimating={isAssistant && isLoading && part.state === "streaming"}
          >
            {sanitizeText(part.text)}
          </MessageResponse>
        </MessageContent>
      );
    }

    if (type === "tool-getWeather") {
      const { toolCallId, state } = part;
      const approvalId = (part as { approval?: { id: string } }).approval?.id;
      const isDenied =
        state === "output-denied" ||
        (state === "approval-responded" &&
          (part as { approval?: { approved?: boolean } }).approval?.approved ===
            false);
      const widthClass = "w-[min(100%,450px)]";

      if (state === "output-available") {
        return (
          <div className={widthClass} key={toolCallId}>
            <Weather weatherAtLocation={part.output} />
          </div>
        );
      }

      if (isDenied) {
        return (
          <div className={widthClass} key={toolCallId}>
            <Tool className="w-full" defaultOpen={true}>
              <ToolHeader state="output-denied" type="tool-getWeather" />
              <ToolContent>
                <div className="px-4 py-3 text-muted-foreground text-sm">
                  Weather lookup was denied.
                </div>
              </ToolContent>
            </Tool>
          </div>
        );
      }

      if (state === "approval-responded") {
        return (
          <div className={widthClass} key={toolCallId}>
            <Tool className="w-full" defaultOpen={true}>
              <ToolHeader state={state} type="tool-getWeather" />
              <ToolContent>
                <ToolInput input={part.input} />
              </ToolContent>
            </Tool>
          </div>
        );
      }

      return (
        <div className={widthClass} key={toolCallId}>
          <Tool className="w-full" defaultOpen={true}>
            <ToolHeader state={state} type="tool-getWeather" />
            <ToolContent>
              {(state === "input-available" ||
                state === "approval-requested") && (
                <ToolInput input={part.input} />
              )}
              {state === "approval-requested" && approvalId && (
                <ToolApprovalActions
                  addToolApprovalResponse={addToolApprovalResponse}
                  approvalId={approvalId}
                />
              )}
            </ToolContent>
          </Tool>
        </div>
      );
    }

    if (type === "tool-createDocument") {
      const { toolCallId } = part;

      if (
        shownDocumentCallId?.toolCallId !== undefined &&
        shownDocumentCallId.toolCallId !== toolCallId &&
        !(part.output && "error" in part.output)
      ) {
        return null;
      }

      if (part.output && "error" in part.output) {
        return (
          <div
            className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-500 dark:bg-red-950/50"
            key={toolCallId}
          >
            Error creating document: {String(part.output.error)}
          </div>
        );
      }

      return (
        <DocumentPreview
          isReadonly={isReadonly}
          key={toolCallId}
          result={part.output}
        />
      );
    }

    if (type === "tool-updateDocument") {
      const { toolCallId } = part;

      if (part.output && "error" in part.output) {
        return (
          <div
            className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-500 dark:bg-red-950/50"
            key={toolCallId}
          >
            Error updating document: {String(part.output.error)}
          </div>
        );
      }

      return (
        <div className="relative" key={toolCallId}>
          <DocumentPreview
            args={{ ...part.output, isUpdate: true }}
            isReadonly={isReadonly}
            result={part.output}
          />
        </div>
      );
    }

    if (type === "tool-requestSuggestions") {
      const { toolCallId, state } = part;

      return (
        <Tool
          className="w-[min(100%,450px)]"
          defaultOpen={true}
          key={toolCallId}
        >
          <ToolHeader state={state} type="tool-requestSuggestions" />
          <ToolContent>
            {state === "input-available" && <ToolInput input={part.input} />}
            {state === "output-available" && (
              <ToolOutput
                errorText={undefined}
                output={
                  "error" in part.output ? (
                    <div className="rounded border p-2 text-red-500">
                      Error: {String(part.output.error)}
                    </div>
                  ) : (
                    <DocumentToolResult
                      isReadonly={isReadonly}
                      result={part.output}
                      type="request-suggestions"
                    />
                  )
                }
              />
            )}
          </ToolContent>
        </Tool>
      );
    }

    if (type === "tool-createQuiz") {
      const { toolCallId, state } = part;
      if (state === "output-available") {
        // On an error the model fixes the quiz and calls the tool again.
        return "error" in part.output ? null : (
          <Quiz
            key={toolCallId}
            questions={part.input.questions}
            title={part.input.title}
          />
        );
      }
      if (state === "output-error" || !isLoading) {
        return null;
      }
      return (
        <QuizSkeleton
          count={part.input?.questions?.length ?? 0}
          key={toolCallId}
          title={part.input?.title}
        />
      );
    }

    if (type === "tool-createFlashcards") {
      const { toolCallId, state } = part;
      if (state === "output-available") {
        return (
          <Flashcards
            cards={part.input.cards}
            key={toolCallId}
            title={part.input.title}
          />
        );
      }
      if (state === "output-error" || !isLoading) {
        return null;
      }
      return (
        <FlashcardsSkeleton
          count={part.input?.cards?.length ?? 0}
          key={toolCallId}
          title={part.input?.title}
        />
      );
    }

    if (type === "tool-shareFiles") {
      const { toolCallId, state } = part;
      if (state === "output-available") {
        return <FileCards files={part.output.files} key={toolCallId} />;
      }
      if (state === "output-error" || !isLoading) {
        return null;
      }
      return (
        <FileCardsSkeleton
          key={toolCallId}
          titles={(part.input?.files ?? [])
            .map((file) => file?.title ?? "")
            .filter(Boolean)}
        />
      );
    }

    if (type === "tool-calculate") {
      const { toolCallId, state } = part;
      if (state === "output-available") {
        return (
          <Calculation
            expressions={part.input.expressions}
            key={toolCallId}
            results={part.output.results}
          />
        );
      }
      if (state === "output-error" || !isLoading) {
        return null;
      }
      return (
        <Calculation
          expressions={(part.input?.expressions ?? []).filter(
            (expression): expression is string => !!expression
          )}
          key={toolCallId}
        />
      );
    }

    return null;
  });

  const actions = !isReadonly && (
    <MessageActions
      chatId={chatId}
      isLoading={isLoading}
      key={`action-${message.id}`}
      message={message}
      onEdit={onEdit && !isVoiceMessage ? () => onEdit(message) : undefined}
      vote={vote}
    />
  );

  const followUps =
    isAssistant && showSuggestions && !isLoading && !isReadonly
      ? message.parts.findLast((part) => part.type === "data-suggestions")?.data
      : undefined;

  const content = isThinking ? (
    <WaitingText />
  ) : (
    <>
      {attachments}
      {parts}
      {actions}
      {followUps && followUps.length > 0 ? (
        <FollowUpSuggestions
          key={`follow-ups-${message.id}`}
          suggestions={followUps}
        />
      ) : null}
    </>
  );

  return (
    <div
      className={cn(
        "group/message w-full",
        !isAssistant && "animate-[fade-up_0.25s_cubic-bezier(0.22,1,0.36,1)]"
      )}
      data-role={message.role}
      data-testid={`message-${message.role}`}
    >
      <div
        className={cn(
          isUser ? "flex flex-col items-end gap-2" : "flex items-start gap-3"
        )}
      >
        {isAssistant && (
          <div className="flex h-[calc(15px*1.65)] shrink-0 items-center">
            <DzdLogoMark size={28} title="DZD AI" />
          </div>
        )}
        {isAssistant ? (
          <div className="flex min-w-0 flex-1 flex-col gap-2">{content}</div>
        ) : (
          content
        )}
      </div>
    </div>
  );
};

export const PreviewMessage = PurePreviewMessage;

export const ThinkingMessage = () => (
  <div
    className="group/message w-full"
    data-role="assistant"
    data-testid="message-assistant-loading"
  >
    <div className="flex items-start gap-3">
      <div className="flex h-[calc(15px*1.65)] shrink-0 items-center">
        <DzdLogoMark size={28} title="DZD AI" />
      </div>

      <WaitingText />
    </div>
  </div>
);
