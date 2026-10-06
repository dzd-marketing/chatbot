"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import equal from "fast-deep-equal";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUpIcon,
  BrainIcon,
  EyeIcon,
  GlobeIcon,
  LockIcon,
  WrenchIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  type ChangeEvent,
  type Dispatch,
  memo,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useLocalStorage, useWindowSize } from "usehooks-ts";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import { useActiveChat } from "@/hooks/use-active-chat";
import { useChatModel, useChatModels } from "@/hooks/use-chat-models";
import {
  useVoiceRecorder,
  type VoiceLanguage,
  type VoiceResult,
} from "@/hooks/use-voice-recorder";
import {
  type ChatModel,
  DEFAULT_CHAT_MODEL,
  type ModelCapabilities,
} from "@/lib/ai/models";
import { withStoppedReply } from "@/lib/chat/stopped";
import { prepareImageForUpload } from "@/lib/image-compress";
import { isExternalUrl, PRIVACY_URL, TERMS_URL } from "@/lib/legal";
import { featureMessage, type StudyFeature } from "@/lib/study-features";
import type { Attachment, ChatMessage } from "@/lib/types";
import { cn, generateUUID } from "@/lib/utils";
import { audioExtension, normalizeAudioType } from "@/lib/voice-message";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "../ai-elements/prompt-input";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { AnimatedPlaceholder } from "./animated-placeholder";
import { ReasoningDropdown, ToolsDropdown } from "./composer-controls";
import { ComposerPlusMenu } from "./composer-plus-menu";
import { DzdLogoMark, PaperclipIcon } from "./icons";
import { PreviewAttachment } from "./preview-attachment";
import {
  type SlashCommand,
  SlashCommandMenu,
  slashCommands,
} from "./slash-commands";
import { FeatureChip, StudyFeatureCards } from "./study-features";
import type { VisibilityType } from "./visibility-selector";
import { MicButton, VoiceControls, VoicePanel } from "./voice-input";

/** Documents are read as text on the server (api/files/upload). */
const DOCUMENT_ACCEPT =
  ".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown";
const DOCUMENT_EXTENSIONS = /\.(pdf|docx|txt|md|markdown)$/i;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

const isImageFile = (file: File) =>
  file.type.startsWith("image/") ||
  /\.(jpe?g|png|webp|gif|heic|heif|bmp)$/i.test(file.name);

function setCookie(name: string, value: string) {
  const maxAge = 60 * 60 * 24 * 365;
  // biome-ignore lint/suspicious/noDocumentCookie: needed for client-side cookie setting
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}`;
}

// Website legal pages open in a new tab; in-app placeholders stay in the tab.
const legalLinkProps = (url: string) =>
  isExternalUrl(url)
    ? { rel: "noopener noreferrer", target: "_blank" as const }
    : {};

// models.dev has no logo for our own model, so show the DZD mark instead.
function ProviderLogo({ provider }: { provider: string }) {
  if (provider === "dzd") {
    return <DzdLogoMark className="size-4" size={16} />;
  }
  return <ModelSelectorLogo provider={provider} />;
}

function PureMultimodalInput({
  chatId,
  input,
  setInput,
  status,
  stop,
  attachments,
  setAttachments,
  messages,
  setMessages,
  sendMessage,
  className,
  selectedModelId,
  onModelChange,
  editingMessage,
  onCancelEdit,
  isLoading,
}: {
  chatId: string;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  status: UseChatHelpers<ChatMessage>["status"];
  stop: () => void;
  attachments: Attachment[];
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  messages: UIMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  sendMessage:
    | UseChatHelpers<ChatMessage>["sendMessage"]
    | (() => Promise<void>);
  className?: string;
  selectedVisibilityType: VisibilityType;
  selectedModelId: string;
  onModelChange?: (modelId: string) => void;
  editingMessage?: ChatMessage | null;
  onCancelEdit?: () => void;
  isLoading?: boolean;
}) {
  const router = useRouter();
  const { setTheme, resolvedTheme } = useTheme();
  const { capabilities: modelCapabilities, model: currentModel } =
    useChatModel(selectedModelId);
  const hasVision = modelCapabilities?.vision ?? false;
  // Read inside the stable upload callback.
  const hasVisionRef = useRef(hasVision);
  hasVisionRef.current = hasVision;
  const modelNameRef = useRef("This model");
  modelNameRef.current = currentModel?.name ?? "This model";
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { width } = useWindowSize();
  const hasAutoFocused = useRef(false);
  useEffect(() => {
    if (!hasAutoFocused.current && width) {
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
        hasAutoFocused.current = true;
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [width]);

  const [localStorageInput, setLocalStorageInput] = useLocalStorage(
    "input",
    ""
  );

  useEffect(() => {
    if (textareaRef.current) {
      const domValue = textareaRef.current.value;
      const finalValue = domValue || localStorageInput || "";
      setInput(finalValue);
    }
  }, [localStorageInput, setInput]);

  useEffect(() => {
    setLocalStorageInput(input);
  }, [input, setLocalStorageInput]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadQueue, setUploadQueue] = useState<string[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);

  // Study feature picked from the welcome cards (shown as a chip).
  const [feature, setFeature] = useState<StudyFeature | null>(null);
  const { toolSettings, setToolEnabled } = useActiveChat();
  const handleFeatureSelect = useCallback(
    (picked: StudyFeature) => {
      setFeature(picked);
      // Make sure the tools the feature needs are switched on.
      for (const id of picked.tools) {
        if (!toolSettings[id]) {
          setToolEnabled(id, true);
        }
      }
      textareaRef.current?.focus();
    },
    [setToolEnabled, toolSettings]
  );
  const clearFeature = useCallback(() => {
    setFeature(null);
    textareaRef.current?.focus();
  }, []);

  const handleInput = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const val = event.target.value;
      setInput(val);

      if (val.startsWith("/") && !val.includes(" ")) {
        setSlashOpen(true);
        setSlashQuery(val.slice(1));
        setSlashIndex(0);
      } else {
        setSlashOpen(false);
      }
    },
    [setInput]
  );

  const handleSlashSelect = useCallback(
    (cmd: SlashCommand) => {
      setSlashOpen(false);
      setInput("");
      switch (cmd.action) {
        case "new":
          router.push("/");
          break;
        case "clear":
          setMessages(() => []);
          break;
        case "rename":
          toast("Rename is available from the sidebar chat menu.");
          break;
        case "model": {
          const modelBtn = document.querySelector<HTMLButtonElement>(
            "[data-testid='model-selector']"
          );
          modelBtn?.click();
          break;
        }
        case "theme":
          setTheme(resolvedTheme === "dark" ? "light" : "dark");
          break;
        case "delete":
          toast("Delete this chat?", {
            action: {
              label: "Delete",
              onClick: () => {
                fetch(
                  `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/chat?id=${chatId}`,
                  { method: "DELETE" }
                );
                router.push("/");
                toast.success("Chat deleted");
              },
            },
          });
          break;
        case "purge":
          toast("Delete all chats?", {
            action: {
              label: "Delete all",
              onClick: () => {
                fetch(
                  `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/history`,
                  {
                    method: "DELETE",
                  }
                );
                router.push("/");
                toast.success("All chats deleted");
              },
            },
          });
          break;
        default:
          break;
      }
    },
    [chatId, resolvedTheme, router, setInput, setMessages, setTheme]
  );

  /**
   * Sends the input, or `text` with `extraParts` (a voice message's
   * recording). `keepInput` leaves anything typed in the box.
   */
  const submitForm = useCallback(
    (
      options: {
        text?: string;
        extraParts?: ChatMessage["parts"];
        keepInput?: boolean;
      } = {}
    ) => {
      const text = options.text ?? input;
      window.history.pushState(
        {},
        "",
        `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/chat/${chatId}`
      );

      sendMessage({
        parts: [
          ...attachments.map((attachment) => ({
            mediaType: attachment.contentType,
            name: attachment.name,
            type: "file" as const,
            url: attachment.url,
          })),
          ...(options.extraParts ?? []),
          {
            text: feature ? featureMessage(feature, text) : text,
            type: "text",
          },
        ],
        role: "user",
      });

      setAttachments([]);
      setFeature(null);
      if (!options.keepInput) {
        setLocalStorageInput("");
        setInput("");
      }

      if (width && width > 768) {
        textareaRef.current?.focus();
      }
    },
    [
      input,
      feature,
      setInput,
      attachments,
      sendMessage,
      setAttachments,
      setLocalStorageInput,
      width,
      chatId,
    ]
  );

  const uploadFile = useCallback(async (original: File) => {
    let file: File = original;
    if (isImageFile(original)) {
      if (!hasVisionRef.current) {
        toast.error(
          `${modelNameRef.current} can't read images. Choose a model with the eye icon, or attach a PDF or Word file instead.`
        );
        return;
      }
      try {
        // Smaller, faster uploads; also converts WebP and similar to JPEG.
        file = await prepareImageForUpload(original);
      } catch {
        toast.error(
          `Couldn't open "${original.name}". Please use a JPEG or PNG image.`
        );
        return;
      }
    } else if (!DOCUMENT_EXTENSIONS.test(original.name)) {
      toast.error(
        `"${original.name}" isn't supported. Attach a PDF, Word (.docx) or text file${hasVisionRef.current ? ", or an image" : ""}.`
      );
      return;
    } else if (original.size > MAX_DOCUMENT_BYTES) {
      toast.error(
        `"${original.name}" is over 4 MB. Please upload a smaller file, or only the pages you need.`
      );
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/files/upload`,
        {
          body: formData,
          method: "POST",
        }
      );

      if (response.ok) {
        const data = await response.json();
        const { url, pathname, contentType } = data;

        return {
          contentType,
          name: pathname,
          url,
        };
      }
      const { error } = await response
        .json()
        .catch(() => ({ error: undefined }));
      toast.error(error || "Couldn't upload the file. Please try again.");
    } catch {
      toast.error("Failed to upload file, please try again!");
    }
  }, []);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []);
      // Allow choosing the same file again later.
      event.target.value = "";

      setUploadQueue(files.map((file) => file.name));

      try {
        const uploadPromises = files.map((file) => uploadFile(file));
        const uploadedAttachments = await Promise.all(uploadPromises);
        const successfullyUploadedAttachments = uploadedAttachments.filter(
          (attachment) => attachment !== undefined
        );

        setAttachments((currentAttachments) => [
          ...currentAttachments,
          ...successfullyUploadedAttachments,
        ]);
      } catch {
        toast.error("Failed to upload files");
      } finally {
        setUploadQueue([]);
      }
    },
    [setAttachments, uploadFile]
  );

  const handlePaste = useCallback(
    async (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) {
        return;
      }

      const imageItems = Array.from(items).filter((item) =>
        item.type.startsWith("image/")
      );

      if (imageItems.length === 0) {
        return;
      }

      event.preventDefault();

      setUploadQueue((prev) => [...prev, "Pasted image"]);

      try {
        const uploadPromises = imageItems
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null)
          .map((file) => uploadFile(file));

        const uploadedAttachments = await Promise.all(uploadPromises);
        const successfullyUploadedAttachments = uploadedAttachments.filter(
          (attachment) =>
            attachment !== undefined &&
            attachment.url !== undefined &&
            attachment.contentType !== undefined
        );

        setAttachments((curr) => [
          ...curr,
          ...(successfullyUploadedAttachments as Attachment[]),
        ]);
      } catch {
        toast.error("Failed to upload pasted image(s)");
      } finally {
        setUploadQueue([]);
      }
    },
    [setAttachments, uploadFile]
  );

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.addEventListener("paste", handlePaste);
    return () => textarea.removeEventListener("paste", handlePaste);
  }, [handlePaste]);

  const handleCancelEditMouseDown = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      onCancelEdit?.();
    },
    [onCancelEdit]
  );

  const handleSlashClose = useCallback(() => {
    setSlashOpen(false);
  }, []);

  // A feature like "Summarize document" can be sent with just a file.
  // Voice typing: the transcript is sent as soon as the student stops.
  const [voiceLanguage, setVoiceLanguage] = useLocalStorage<VoiceLanguage>(
    "dzd-voice-language",
    "en-IN"
  );
  // Uploads the recording, then sends it with its transcript. If the
  // upload fails, the transcript is sent as a text message instead.
  // While the recording uploads, the voice panel stays in its settling
  // ("Transcribing") state showing what was said.
  const [sendingTranscript, setSendingTranscript] = useState<string | null>(
    null
  );
  const sendVoiceMessage = useCallback(
    async (
      transcript: string,
      recording: NonNullable<VoiceResult["voice"]>
    ) => {
      setSendingTranscript(transcript);
      try {
        const type = normalizeAudioType(recording.mimeType) ?? "audio/webm";
        const formData = new FormData();
        formData.append(
          "file",
          new File([recording.blob], `voice-message.${audioExtension(type)}`, {
            type,
          })
        );
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/files/upload`,
          { body: formData, method: "POST" }
        );
        const result = (await response.json().catch(() => ({}))) as {
          url?: string;
          contentType?: string;
          pathname?: string;
          error?: string;
        };
        const mediaType = normalizeAudioType(result.contentType ?? "");
        if (!(response.ok && result.url && mediaType)) {
          throw new Error(result.error ?? "Upload failed", {
            cause: response.status,
          });
        }
        submitForm({
          extraParts: [
            {
              mediaType,
              name: result.pathname ?? "voice-message",
              type: "file",
              url: result.url,
            } as ChatMessage["parts"][number],
            { data: recording.data, type: "data-voice" },
          ],
          keepInput: true,
          text: transcript,
        });
      } catch (error) {
        console.warn("Voice message upload failed:", error);
        toast(
          "Couldn't upload the recording, so your message was sent as text."
        );
        submitForm({ keepInput: true, text: transcript });
      } finally {
        setSendingTranscript(null);
      }
    },
    [submitForm]
  );

  const handleVoiceFinish = useCallback(
    ({ text: transcript, voice: recording, recordingLost }: VoiceResult) => {
      if (!transcript) {
        toast("Didn't catch that. Tap the mic and try again.");
        return;
      }
      const busy = !(status === "ready" || status === "error");
      if (busy || uploadQueue.length > 0) {
        setInput([input.trim(), transcript].filter(Boolean).join(" "));
        toast("Your message is in the box, ready to send.");
        return;
      }
      if (recording) {
        // Sent as a voice message; anything typed stays in the box.
        sendVoiceMessage(transcript, recording);
        return;
      }
      if (recordingLost) {
        toast(
          "This browser couldn't record audio while listening, so your message was sent as text."
        );
      }
      submitForm({
        text: [input.trim(), transcript].filter(Boolean).join(" "),
      });
    },
    [input, sendVoiceMessage, setInput, status, submitForm, uploadQueue.length]
  );
  const handleVoiceError = useCallback((message: string) => {
    toast.error(message);
  }, []);
  const voice = useVoiceRecorder({
    lang: voiceLanguage,
    onError: handleVoiceError,
    onFinish: handleVoiceFinish,
  });
  const voiceActive = voice.state !== "idle" || sendingTranscript !== null;
  const startVoice = voice.start;
  const handlePlusAttach = useCallback(() => {
    fileInputRef.current?.click();
  }, []);
  const handleMicClick = useCallback(() => {
    setSlashOpen(false);
    textareaRef.current?.blur();
    startVoice();
  }, [startVoice]);

  const canSend =
    input.trim().length > 0 ||
    (attachments.length > 0 && (!feature || feature.attachmentOnly === true));

  const handlePromptSubmit = useCallback(() => {
    if (voiceActive) {
      return; // Enter while listening sends the voice message instead
    }
    if (input.startsWith("/")) {
      const query = input.slice(1).trim();
      const cmd = slashCommands.find((c) => c.name === query);
      if (cmd) {
        handleSlashSelect(cmd);
      }
      return;
    }
    if (!canSend) {
      return;
    }
    if (status === "ready" || status === "error") {
      submitForm();
    } else {
      toast.error("Please wait for the model to finish its response!");
    }
  }, [canSend, handleSlashSelect, input, status, submitForm, voiceActive]);

  const handleTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (voiceActive) {
        e.preventDefault();
        return;
      }
      if (slashOpen) {
        const filtered = slashCommands.filter((cmd) =>
          cmd.name.startsWith(slashQuery.toLowerCase())
        );
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashIndex((i) => Math.min(i + 1, filtered.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          if (filtered[slashIndex]) {
            handleSlashSelect(filtered[slashIndex]);
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashOpen(false);
          return;
        }
      }
      // Backspace in an empty input removes the feature chip.
      if (e.key === "Backspace" && feature && input.length === 0) {
        e.preventDefault();
        setFeature(null);
        return;
      }
      if (e.key === "Escape" && editingMessage && onCancelEdit) {
        e.preventDefault();
        onCancelEdit();
      }
    },
    [
      editingMessage,
      feature,
      handleSlashSelect,
      input.length,
      onCancelEdit,
      slashIndex,
      slashOpen,
      slashQuery,
      voiceActive,
    ]
  );

  // Empty chat: the input sits in the centred welcome column, followed by
  // the legal line and the starter suggestions.
  const isWelcome = !editingMessage && !isLoading && messages.length === 0;

  return (
    <div className={cn("relative flex w-full flex-col gap-4", className)}>
      {editingMessage && onCancelEdit ? (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>Editing message</span>
          <button
            className="rounded px-1.5 py-0.5 text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
            onMouseDown={handleCancelEditMouseDown}
            type="button"
          >
            Cancel
          </button>
        </div>
      ) : null}

      <input
        accept={hasVision ? `image/*,${DOCUMENT_ACCEPT}` : DOCUMENT_ACCEPT}
        className="pointer-events-none fixed -top-4 -left-4 size-0.5 opacity-0"
        multiple
        onChange={handleFileChange}
        ref={fileInputRef}
        tabIndex={-1}
        type="file"
      />

      <div className="relative">
        {slashOpen ? (
          <SlashCommandMenu
            onClose={handleSlashClose}
            onSelect={handleSlashSelect}
            query={slashQuery}
            selectedIndex={slashIndex}
          />
        ) : null}
      </div>

      <PromptInput
        className="dzd-gradient-border rounded-2xl [&>div]:rounded-2xl [&>div]:border [&>div]:border-border/30 [&>div]:bg-card/70 [&>div]:shadow-[var(--shadow-composer)] [&>div]:has-[[data-slot=input-group-control]:focus-visible]:border-border/30 [&>div]:has-[[data-slot=input-group-control]:focus-visible]:ring-0"
        onSubmit={handlePromptSubmit}
      >
        {feature && !editingMessage ? (
          <div className="flex w-full self-start px-3 pt-3">
            <FeatureChip feature={feature} onRemove={clearFeature} />
          </div>
        ) : null}
        {(attachments.length > 0 || uploadQueue.length > 0) && (
          <div
            className="flex w-full self-start flex-row gap-2 overflow-x-auto px-3 pt-3 no-scrollbar"
            data-testid="attachments-preview"
          >
            {attachments.map((attachment) => (
              <AttachmentPreviewItem
                attachment={attachment}
                fileInputRef={fileInputRef}
                key={attachment.url}
                setAttachments={setAttachments}
              />
            ))}

            {uploadQueue.map((filename) => (
              <PreviewAttachment
                attachment={{
                  contentType: "",
                  name: filename,
                  url: "",
                }}
                isUploading={true}
                key={filename}
              />
            ))}
          </div>
        )}
        <div className="relative flex w-full flex-1 flex-col">
          <AnimatePresence>
            {voiceActive ? (
              <VoicePanel
                getLevel={voice.getLevel}
                key="voice-panel"
                recording={voice.state === "listening"}
                startedAt={voice.startedAt}
                transcript={
                  sendingTranscript === null
                    ? voice.transcript
                    : { final: sendingTranscript, interim: "" }
                }
              />
            ) : null}
          </AnimatePresence>
          <PromptInputTextarea
            aria-hidden={voiceActive || undefined}
            aria-label={editingMessage ? "Edit your message" : "Message DZD AI"}
            className={cn(
              "min-h-24 w-full px-4 pt-3.5 pb-1.5 text-[14px] leading-relaxed transition-opacity duration-200 placeholder:text-muted-foreground/45",
              voiceActive && "pointer-events-none opacity-0"
            )}
            data-testid="multimodal-input"
            onChange={handleInput}
            onKeyDown={handleTextareaKeyDown}
            placeholder={editingMessage ? "Edit your message..." : ""}
            ref={textareaRef}
            value={input}
          />
          {!(editingMessage || voiceActive) && input.length === 0 ? (
            <AnimatedPlaceholder
              className="pointer-events-none absolute inset-x-0 top-0 select-none overflow-hidden px-4 pt-3.5 text-[14px] text-muted-foreground/55 leading-relaxed"
              hints={feature && !editingMessage ? feature.hints : undefined}
              key={feature?.id ?? "default"}
            />
          ) : null}
        </div>
        <PromptInputFooter className="px-3 pb-3">
          <AnimatePresence initial={false} mode="popLayout">
            {voiceActive ? (
              <motion.div
                animate={{ filter: "blur(0px)", opacity: 1 }}
                className="w-full"
                exit={{ filter: "blur(4px)", opacity: 0 }}
                initial={{ filter: "blur(4px)", opacity: 0 }}
                key="voice-controls"
                transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
              >
                <VoiceControls
                  lang={voiceLanguage}
                  onCancel={voice.cancel}
                  onLangChange={setVoiceLanguage}
                  onSend={voice.stop}
                  state={sendingTranscript === null ? voice.state : "sending"}
                />
              </motion.div>
            ) : (
              <motion.div
                animate={{ filter: "blur(0px)", opacity: 1 }}
                className="flex w-full items-center justify-between gap-1"
                exit={{ filter: "blur(4px)", opacity: 0 }}
                initial={{ filter: "blur(4px)", opacity: 0 }}
                key="composer-controls"
                transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
              >
                <PromptInputTools className="max-md:flex-1 max-md:gap-2">
                  {/* Phones: attachments, reasoning and tools live in "+". */}
                  <div className="flex md:hidden">
                    <ComposerPlusMenu
                      attachDisabled={status !== "ready"}
                      attachNote={
                        hasVision
                          ? "Images, PDF, Word or text"
                          : "PDF, Word or text (no images with this model)"
                      }
                      onAttach={handlePlusAttach}
                    />
                  </div>
                  <div className="hidden md:flex">
                    <AttachmentsButton
                      fileInputRef={fileInputRef}
                      selectedModelId={selectedModelId}
                      status={status}
                    />
                  </div>
                  <ModelSelectorCompact
                    onModelChange={onModelChange}
                    selectedModelId={selectedModelId}
                  />
                  <div className="hidden md:contents">
                    <ReasoningDropdown />
                    <ToolsDropdown />
                  </div>
                </PromptInputTools>

                <div className="flex items-center gap-1.5">
                  {voice.supported && !editingMessage ? (
                    <MicButton
                      disabled={
                        !(status === "ready" || status === "error") ||
                        uploadQueue.length > 0
                      }
                      onClick={handleMicClick}
                    />
                  ) : null}
                  {status === "submitted" || status === "streaming" ? (
                    <StopButton setMessages={setMessages} stop={stop} />
                  ) : (
                    <PromptInputSubmit
                      className={cn(
                        "h-7 w-7 rounded-xl transition-all duration-200 max-md:h-9 max-md:w-9 max-md:rounded-full",
                        canSend
                          ? "bg-primary text-primary-foreground hover:bg-primary/85 active:scale-95"
                          : "bg-muted text-muted-foreground/25 cursor-not-allowed"
                      )}
                      data-testid="send-button"
                      disabled={!canSend || uploadQueue.length > 0}
                      status={status}
                      variant="secondary"
                    >
                      <ArrowUpIcon className="size-4" />
                    </PromptInputSubmit>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </PromptInputFooter>
      </PromptInput>

      {isWelcome ? (
        <motion.p
          animate={{ opacity: 1 }}
          className="-mt-1 text-balance text-center text-[11.5px] text-muted-foreground/80 leading-relaxed"
          data-testid="welcome-legal"
          initial={{ opacity: 0 }}
          transition={{ delay: 0.5, duration: 0.5 }}
        >
          By using DZD Learn AI, you agree to our{" "}
          <a
            className="font-medium text-foreground/80 underline decoration-foreground/30 underline-offset-[3px] transition-colors hover:text-foreground hover:decoration-foreground/70"
            href={TERMS_URL}
            {...legalLinkProps(TERMS_URL)}
          >
            Terms
          </a>{" "}
          and{" "}
          <a
            className="font-medium text-foreground/80 underline decoration-foreground/30 underline-offset-[3px] transition-colors hover:text-foreground hover:decoration-foreground/70"
            href={PRIVACY_URL}
            {...legalLinkProps(PRIVACY_URL)}
          >
            Privacy Policy
          </a>
          .
        </motion.p>
      ) : null}

      {isWelcome ? (
        <StudyFeatureCards
          onSelect={handleFeatureSelect}
          selectedId={feature?.id}
        />
      ) : null}
    </div>
  );
}

export const MultimodalInput = memo(
  PureMultimodalInput,
  (prevProps, nextProps) => {
    if (prevProps.input !== nextProps.input) {
      return false;
    }
    if (prevProps.status !== nextProps.status) {
      return false;
    }
    if (!equal(prevProps.attachments, nextProps.attachments)) {
      return false;
    }
    if (prevProps.selectedVisibilityType !== nextProps.selectedVisibilityType) {
      return false;
    }
    if (prevProps.selectedModelId !== nextProps.selectedModelId) {
      return false;
    }
    if (prevProps.editingMessage !== nextProps.editingMessage) {
      return false;
    }
    if (prevProps.isLoading !== nextProps.isLoading) {
      return false;
    }
    if (prevProps.messages.length !== nextProps.messages.length) {
      return false;
    }

    return true;
  }
);

function PureAttachmentPreviewItem({
  attachment,
  fileInputRef,
  setAttachments,
}: {
  attachment: Attachment;
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
}) {
  const handleRemove = useCallback(() => {
    setAttachments((currentAttachments) =>
      currentAttachments.filter((a) => a.url !== attachment.url)
    );
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [attachment.url, fileInputRef, setAttachments]);

  return <PreviewAttachment attachment={attachment} onRemove={handleRemove} />;
}

const AttachmentPreviewItem = memo(PureAttachmentPreviewItem);

function PureAttachmentsButton({
  fileInputRef,
  status,
  selectedModelId,
}: {
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  status: UseChatHelpers<ChatMessage>["status"];
  selectedModelId: string;
}) {
  const { capabilities, model } = useChatModel(selectedModelId);
  const hasVision = capabilities?.vision ?? false;
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      fileInputRef.current?.click();
    },
    [fileInputRef]
  );

  const button = (
    <Button
      aria-label="Attach files"
      className="h-7 w-7 rounded-lg border border-border/40 p-1 text-foreground transition-colors hover:border-border hover:text-foreground"
      data-testid="attachments-button"
      disabled={status !== "ready"}
      onClick={handleClick}
      variant="ghost"
    >
      <PaperclipIcon size={14} style={{ height: 14, width: 14 }} />
    </Button>
  );

  // A disabled button gets no pointer events, so the tooltip is attached
  // to a wrapper.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{button}</span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        {hasVision
          ? "Attach images, PDF, Word or text files"
          : `Attach PDF, Word or text files. ${model?.name ?? "This model"} can't read images; choose a model with the eye icon for photos.`}
      </TooltipContent>
    </Tooltip>
  );
}

const AttachmentsButton = memo(PureAttachmentsButton);

function ModelSelectorOption({
  capabilities,
  curated,
  model,
  onModelChange,
  selectedModelId,
  setOpen,
}: {
  capabilities: Record<string, ModelCapabilities> | undefined;
  curated: boolean;
  model: ChatModel;
  onModelChange?: (modelId: string) => void;
  selectedModelId: string;
  setOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const [logoProvider] = model.id.split("/");
  const maybeWithTooltip = (icon: ReactNode, label: string) => {
    if (!curated) {
      return icon;
    }

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{icon}</span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8}>
          {label}
        </TooltipContent>
      </Tooltip>
    );
  };
  const handleSelect = useCallback(() => {
    if (!curated) {
      return;
    }
    onModelChange?.(model.id);
    setCookie("chat-model", model.id);
    setOpen(false);
    setTimeout(() => {
      document
        .querySelector<HTMLTextAreaElement>("[data-testid='multimodal-input']")
        ?.focus();
    }, 50);
  }, [curated, model.id, onModelChange, setOpen]);

  const option = (
    <ModelSelectorItem
      aria-disabled={!curated}
      className={cn(
        "flex w-full transition-colors",
        model.id === selectedModelId &&
          "border-b border-dashed border-foreground/50",
        curated
          ? "data-[selected=true]:bg-muted data-[selected=true]:text-foreground"
          : "cursor-not-allowed opacity-40 data-[selected=true]:bg-transparent data-[selected=true]:opacity-60 data-[selected=true]:ring-1 data-[selected=true]:ring-muted-foreground/30 data-[selected=true]:ring-inset"
      )}
      keywords={[model.name, model.provider]}
      onSelect={handleSelect}
      value={model.id}
    >
      <ProviderLogo provider={logoProvider} />
      <ModelSelectorName>{model.name}</ModelSelectorName>
      {model.provider === "nvidia" ? (
        <span className="shrink-0 rounded border border-border/50 px-1 py-px font-medium text-[9px] text-muted-foreground uppercase tracking-wide">
          NVIDIA
        </span>
      ) : null}
      <div className="ml-auto flex items-center gap-2 text-foreground/70">
        {capabilities?.[model.id]?.tools
          ? maybeWithTooltip(
              <WrenchIcon className="size-3.5" />,
              "Supports tool use"
            )
          : null}
        {capabilities?.[model.id]?.builtInWebSearch
          ? maybeWithTooltip(
              <GlobeIcon className="size-3.5" />,
              "Built-in web search"
            )
          : null}
        {capabilities?.[model.id]?.vision
          ? maybeWithTooltip(
              <EyeIcon className="size-3.5" />,
              "Supports vision"
            )
          : null}
        {capabilities?.[model.id]?.reasoning
          ? maybeWithTooltip(
              <BrainIcon className="size-3.5" />,
              "Supports reasoning"
            )
          : null}
        {!curated && <LockIcon className="size-3 text-muted-foreground/50" />}
      </div>
    </ModelSelectorItem>
  );

  if (curated) {
    return option;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="w-full cursor-not-allowed">{option}</div>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        This model is not available in the demo.
      </TooltipContent>
    </Tooltip>
  );
}

function PureModelSelectorCompact({
  selectedModelId,
  onModelChange,
}: {
  selectedModelId: string;
  onModelChange?: (modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Selectable models: the curated list plus NVIDIA models discovered by
  // the server (/api/models "extraModels").
  const {
    capabilities,
    demoModels: dynamicModels,
    models: availableModels,
  } = useChatModels();
  const lookupModels = dynamicModels
    ? [...availableModels, ...dynamicModels]
    : availableModels;

  const selectedModel =
    lookupModels.find((m: ChatModel) => m.id === selectedModelId) ??
    lookupModels.find((m: ChatModel) => m.id === DEFAULT_CHAT_MODEL) ??
    lookupModels[0];
  const [provider] = selectedModel.id.split("/");

  return (
    <ModelSelector onOpenChange={setOpen} open={open}>
      <ModelSelectorTrigger asChild>
        <Button
          className="h-7 min-w-0 max-w-[200px] justify-between gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground max-md:h-9 max-md:max-w-full max-md:shrink max-md:rounded-full max-md:bg-foreground/[0.04] max-md:px-3 max-md:text-[13px] max-md:text-foreground/80"
          data-testid="model-selector"
          variant="ghost"
        >
          {provider ? <ProviderLogo provider={provider} /> : null}
          <ModelSelectorName>{selectedModel.name}</ModelSelectorName>
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent commandDefaultValue={selectedModel.id}>
        <ModelSelectorInput placeholder="Search models..." />
        <ModelSelectorList>
          {(() => {
            const curatedIds = new Set(availableModels.map((m) => m.id));
            // One alphabetical list of everything the student can pick.
            const sortedAvailable = [...availableModels].sort((a, b) =>
              a.name.localeCompare(b.name, undefined, {
                numeric: true,
                sensitivity: "base",
              })
            );
            const allModels = dynamicModels
              ? [
                  ...sortedAvailable,
                  ...dynamicModels.filter((m) => !curatedIds.has(m.id)),
                ]
              : sortedAvailable;

            const grouped: Record<
              string,
              { model: ChatModel; curated: boolean }[]
            > = {};
            for (const model of allModels) {
              const key = curatedIds.has(model.id)
                ? "_available"
                : model.provider;
              if (!grouped[key]) {
                grouped[key] = [];
              }
              grouped[key].push({ curated: curatedIds.has(model.id), model });
            }

            const sortedKeys = Object.keys(grouped).sort((a, b) => {
              if (a === "_available") {
                return -1;
              }
              if (b === "_available") {
                return 1;
              }
              return a.localeCompare(b);
            });

            const providerNames: Record<string, string> = {
              alibaba: "Alibaba",
              anthropic: "Anthropic",
              "arcee-ai": "Arcee AI",
              bytedance: "ByteDance",
              cohere: "Cohere",
              deepseek: "DeepSeek",
              google: "Google",
              inception: "Inception",
              kwaipilot: "Kwaipilot",
              meituan: "Meituan",
              meta: "Meta",
              minimax: "MiniMax",
              mistral: "Mistral",
              moonshotai: "Moonshot",
              morph: "Morph",
              nvidia: "Nvidia",
              openai: "OpenAI",
              perplexity: "Perplexity",
              "prime-intellect": "Prime Intellect",
              xai: "xAI",
              xiaomi: "Xiaomi",
              zai: "Zai",
            };

            return sortedKeys.map((key) => (
              <ModelSelectorGroup
                heading={
                  key === "_available"
                    ? "Available"
                    : (providerNames[key] ?? key)
                }
                key={key}
              >
                {grouped[key].map(({ model, curated }) => (
                  <ModelSelectorOption
                    capabilities={capabilities}
                    curated={curated}
                    key={model.id}
                    model={model}
                    onModelChange={onModelChange}
                    selectedModelId={selectedModel.id}
                    setOpen={setOpen}
                  />
                ))}
              </ModelSelectorGroup>
            ));
          })()}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}

const ModelSelectorCompact = memo(PureModelSelectorCompact);

/**
 * Shown while DZD AI is answering: a red stop square inside a spinning
 * ring. Stopping keeps what was written and adds a "stopped" notice.
 */
function PureStopButton({
  stop,
  setMessages,
}: {
  stop: () => void;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
}) {
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      stop();
      setMessages((messages) => withStoppedReply(messages, generateUUID));
    },
    [setMessages, stop]
  );

  return (
    <button
      aria-label="Stop generating"
      className="group relative grid size-8 shrink-0 cursor-pointer place-items-center rounded-full max-md:size-9 bg-red-500/10 text-red-500 transition-[background-color,transform] duration-200 hover:bg-red-500/18 active:scale-90 dark:bg-red-500/15 dark:hover:bg-red-500/25"
      data-testid="stop-button"
      onClick={handleClick}
      title="Stop generating"
      type="button"
    >
      <svg
        aria-hidden="true"
        className="absolute inset-0 size-full animate-spin [animation-duration:1.1s] motion-reduce:animate-none"
        fill="none"
        viewBox="0 0 32 32"
      >
        <circle
          cx="16"
          cy="16"
          r="14"
          stroke="currentColor"
          strokeOpacity="0.2"
          strokeWidth="2"
        />
        <circle
          cx="16"
          cy="16"
          r="14"
          stroke="currentColor"
          strokeDasharray="24 64"
          strokeLinecap="round"
          strokeWidth="2"
        />
      </svg>
      <span className="size-2.5 rounded-[3px] bg-current transition-transform duration-200 group-hover:scale-110" />
    </button>
  );
}

const StopButton = memo(PureStopButton);
