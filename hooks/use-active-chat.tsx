"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { usePathname } from "next/navigation";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import useSWR, { useSWRConfig } from "swr";
import { unstable_serialize } from "swr/infinite";
import { useLocalStorage } from "usehooks-ts";
import { useDataStream } from "@/components/chat/data-stream-provider";
import { getChatHistoryPaginationKey } from "@/components/chat/sidebar-history";
import { toast } from "@/components/chat/toast";
import type { VisibilityType } from "@/components/chat/visibility-selector";
import { useAutoResume } from "@/hooks/use-auto-resume";
import {
  DEFAULT_CHAT_MODEL,
  dzdLearnModel,
  type ReasoningLevel,
  reasoningLevels,
  resolveReasoningLevel,
} from "@/lib/ai/models";
import {
  resolveToolSettings,
  type ToolGroupId,
  type ToolSettings,
} from "@/lib/ai/tool-groups";
import { postToApp } from "@/lib/android-bridge";
import { isAndroidEmbed } from "@/lib/android-embed";
import { withStoppedReply } from "@/lib/chat/stopped";
import type { Vote } from "@/lib/db/schema";
import { ChatbotError } from "@/lib/errors";
import type { ChatMessage } from "@/lib/types";
import { fetcher, fetchWithErrorHandlers, generateUUID } from "@/lib/utils";

type ActiveChatContextValue = {
  chatId: string;
  messages: ChatMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  sendMessage: UseChatHelpers<ChatMessage>["sendMessage"];
  status: UseChatHelpers<ChatMessage>["status"];
  stop: UseChatHelpers<ChatMessage>["stop"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  visibilityType: VisibilityType;
  isReadonly: boolean;
  isLoading: boolean;
  votes: Vote[] | undefined;
  currentModelId: string;
  showCreditCardAlert: boolean;
  setShowCreditCardAlert: Dispatch<SetStateAction<boolean>>;
  /** Student's Web search toggle. On by default. */
  /** The composer's Tools menu (lib/ai/tool-groups.ts). */
  toolSettings: ToolSettings;
  setToolEnabled: (id: ToolGroupId, enabled: boolean) => void;
  /** Reasoning level resolved for the current model (undefined = no control). */
  reasoningLevel: ReasoningLevel | undefined;
  setReasoningLevel: (level: ReasoningLevel) => void;
};

const ActiveChatContext = createContext<ActiveChatContextValue | null>(null);

function extractChatId(pathname: string): string | null {
  const match = pathname.match(/\/chat\/([^/]+)/);
  return match ? match[1] : null;
}

export function ActiveChatProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { setDataStream, setWaitingStatus } = useDataStream();
  const { mutate } = useSWRConfig();

  const chatIdFromUrl = extractChatId(pathname);
  const isNewChat = !chatIdFromUrl;
  const newChatIdRef = useRef(generateUUID());
  const announcedChatsRef = useRef(new Set<string>());
  const prevPathnameRef = useRef(pathname);

  if (isNewChat && prevPathnameRef.current !== pathname) {
    newChatIdRef.current = generateUUID();
  }
  prevPathnameRef.current = pathname;

  const chatId = chatIdFromUrl ?? newChatIdRef.current;

  // One assistant, TheStudent AI; the server picks the model for each reply.
  const currentModelId = DEFAULT_CHAT_MODEL;

  const [input, setInput] = useState("");
  const [showCreditCardAlert, setShowCreditCardAlert] = useState(false);

  // Composer preferences, remembered across chats on this device.
  // initializeWithValue: false keeps SSR and the first client render in sync.
  const [storedTools, setStoredTools] = useLocalStorage<Partial<
    Record<ToolGroupId, boolean>
  > | null>("dzd-tools", null, { initializeWithValue: false });
  // Before the Tools menu, only web search could be switched.
  const [legacyWebSearch] = useLocalStorage("dzd-web-search", true, {
    initializeWithValue: false,
  });
  const toolSettings = useMemo(
    () =>
      resolveToolSettings({
        webSearch: legacyWebSearch !== false,
        ...storedTools,
      }),
    [legacyWebSearch, storedTools]
  );
  const setToolEnabled = useCallback(
    (id: ToolGroupId, enabled: boolean) => {
      setStoredTools((previous) => ({
        ...toolSettings,
        ...previous,
        [id]: enabled,
      }));
    },
    [setStoredTools, toolSettings]
  );
  const [storedReasoning, setReasoningLevel] =
    useLocalStorage<ReasoningLevel | null>("dzd-reasoning", null, {
      initializeWithValue: false,
    });
  const reasoningPreference = reasoningLevels.includes(
    storedReasoning as ReasoningLevel
  )
    ? (storedReasoning as ReasoningLevel)
    : undefined;
  const reasoningLevel = resolveReasoningLevel(
    dzdLearnModel,
    reasoningPreference
  );

  const toolSettingsRef = useRef(toolSettings);
  const reasoningLevelRef = useRef(reasoningLevel);
  useEffect(() => {
    toolSettingsRef.current = toolSettings;
    reasoningLevelRef.current = reasoningLevel;
  }, [toolSettings, reasoningLevel]);

  const setMessagesRef = useRef<
    UseChatHelpers<ChatMessage>["setMessages"] | null
  >(null);

  const { data: chatData, isLoading } = useSWR(
    isNewChat
      ? null
      : `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/messages?chatId=${chatId}`,
    fetcher,
    { revalidateOnFocus: false }
  );

  const initialMessages: ChatMessage[] = isNewChat
    ? []
    : (chatData?.messages ?? []);
  const visibility: VisibilityType = isNewChat
    ? "private"
    : (chatData?.visibility ?? "private");

  const {
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
    regenerate,
    resumeStream,
    addToolApprovalResponse,
  } = useChat<ChatMessage>({
    generateId: generateUUID,
    id: chatId,
    messages: initialMessages,
    onData: (dataPart) => {
      if (dataPart.type === "data-waiting-status") {
        setWaitingStatus(dataPart.data);
        return;
      }
      setDataStream((ds) => (ds ? [...ds, dataPart] : []));
    },
    onError: (error) => {
      if (error.message?.includes("AI Gateway requires a valid credit card")) {
        setShowCreditCardAlert(true);
      } else if (error instanceof ChatbotError) {
        toast({ description: error.message, type: "error" });
      } else {
        toast({
          description: error.message || "Oops, an error occurred!",
          type: "error",
        });
      }
    },
    onFinish: ({ isAbort, messages: finishedMessages }) => {
      // Android app: the first reply of a new conversation tells the native
      // history drawer to refresh (once per conversation).
      if (isAndroidEmbed()) {
        const userMessages = finishedMessages.filter(
          (item) => item.role === "user"
        );
        const [firstUserMessage] = userMessages;
        if (
          userMessages.length === 1 &&
          firstUserMessage &&
          !announcedChatsRef.current.has(firstUserMessage.id)
        ) {
          announcedChatsRef.current.add(firstUserMessage.id);
          postToApp("NEW_CHAT");
        }
      }
      // The Stop button marks the reply at once; mark it again after the
      // stream's last update in case that update replaced it.
      if (isAbort) {
        setMessagesRef.current?.((current) =>
          withStoppedReply(current, generateUUID)
        );
      }
      mutate(unstable_serialize(getChatHistoryPaginationKey));
    },
    sendAutomaticallyWhen: ({ messages: currentMessages }) => {
      const lastMessage = currentMessages.at(-1);
      return (
        lastMessage?.parts?.some(
          (part) =>
            "state" in part &&
            part.state === "approval-responded" &&
            "approval" in part &&
            (part.approval as { approved?: boolean })?.approved === true
        ) ?? false
      );
    },
    transport: new DefaultChatTransport({
      api: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/chat`,
      fetch: fetchWithErrorHandlers,
      prepareSendMessagesRequest(request) {
        const lastMessage = request.messages.at(-1);
        const isToolApprovalContinuation =
          lastMessage?.role !== "user" ||
          request.messages.some((msg) =>
            msg.parts?.some((part) => {
              const { state } = part as { state?: string };
              return (
                state === "approval-responded" || state === "output-denied"
              );
            })
          );

        return {
          body: {
            id: request.id,
            ...(isToolApprovalContinuation
              ? { messages: request.messages }
              : { message: lastMessage }),
            selectedChatModel: DEFAULT_CHAT_MODEL,
            selectedVisibilityType: visibility,
            tools: toolSettingsRef.current,
            webSearch: toolSettingsRef.current.webSearch,
            ...(reasoningLevelRef.current && {
              reasoning: reasoningLevelRef.current,
            }),
            ...request.body,
          },
        };
      },
    }),
  });
  setMessagesRef.current = setMessages;

  useEffect(() => {
    if (status === "submitted" || status === "ready" || status === "error") {
      setWaitingStatus(undefined);
    }
  }, [status, setWaitingStatus]);

  const loadedChatIds = useRef(new Set<string>());

  if (isNewChat && !loadedChatIds.current.has(newChatIdRef.current)) {
    loadedChatIds.current.add(newChatIdRef.current);
  }

  useEffect(() => {
    if (loadedChatIds.current.has(chatId)) {
      return;
    }
    if (chatData?.messages) {
      loadedChatIds.current.add(chatId);
      setMessages(chatData.messages);
    }
  }, [chatId, chatData?.messages, setMessages]);

  const prevChatIdRef = useRef(chatId);
  useEffect(() => {
    if (prevChatIdRef.current !== chatId) {
      prevChatIdRef.current = chatId;
      if (isNewChat) {
        setMessages([]);
      }
    }
  }, [chatId, isNewChat, setMessages]);

  const hasAppendedQueryRef = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const query = params.get("query");
    if (query && !hasAppendedQueryRef.current) {
      hasAppendedQueryRef.current = true;
      window.history.replaceState(
        {},
        "",
        `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/chat/${chatId}`
      );
      sendMessage({
        parts: [{ text: query, type: "text" }],
        role: "user" as const,
      });
    }
  }, [sendMessage, chatId]);

  // Android app: `?q=` prefills the composer (never auto-sends), then is
  // removed from the address so a reload doesn't prefill it again.
  const hasPrefilledRef = useRef(false);
  useEffect(() => {
    if (hasPrefilledRef.current || !isAndroidEmbed()) {
      return;
    }
    hasPrefilledRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const question = params.get("q")?.trim();
    if (!question) {
      return;
    }
    setInput(question.slice(0, 4000));
    params.delete("q");
    const search = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`
    );
  }, []);

  useAutoResume({
    autoResume: !isNewChat && !!chatData,
    initialMessages,
    resumeStream,
    setMessages,
  });

  const isReadonly = isNewChat ? false : (chatData?.isReadonly ?? false);

  const { data: votes } = useSWR<Vote[]>(
    !isReadonly && messages.length >= 2
      ? `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/vote?chatId=${chatId}`
      : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  const value = useMemo<ActiveChatContextValue>(
    () => ({
      addToolApprovalResponse,
      chatId,
      currentModelId,
      input,
      isLoading: !isNewChat && isLoading,
      isReadonly,
      messages,
      reasoningLevel,
      regenerate,
      sendMessage,
      setInput,
      setMessages,
      setReasoningLevel,
      setShowCreditCardAlert,
      setToolEnabled,
      showCreditCardAlert,
      status,
      stop,
      toolSettings,
      visibilityType: visibility,
      votes,
    }),
    [
      chatId,
      messages,
      setMessages,
      sendMessage,
      status,
      stop,
      regenerate,
      addToolApprovalResponse,
      input,
      visibility,
      isReadonly,
      isNewChat,
      isLoading,
      votes,
      showCreditCardAlert,
      toolSettings,
      setToolEnabled,
      reasoningLevel,
      setReasoningLevel,
    ]
  );

  return (
    <ActiveChatContext.Provider value={value}>
      {children}
    </ActiveChatContext.Provider>
  );
}

export function useActiveChat() {
  const context = useContext(ActiveChatContext);
  if (!context) {
    throw new Error("useActiveChat must be used within ActiveChatProvider");
  }
  return context;
}
