"use client";

import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useTheme } from "next-themes";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  useEmbedIdentity,
  useIsEmbedded,
  useIsInApp,
} from "@/hooks/use-android-embed";
import {
  BRIDGE_CHAT_ID,
  formatRelativeTime,
  parseInboundMessage,
  postToApp,
} from "@/lib/android-bridge";
import {
  EMBED_APP_SESSION_KEY,
  EMBED_DOWNLOAD_MESSAGE,
  EMBED_LINK_BLOCKED_MESSAGE,
  EMBED_LINK_COPIED_MESSAGE,
} from "@/lib/android-embed";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const MAX_HISTORY_CHATS = 50;

type HistoryResponse = {
  chats?: { id: string; title: string; updatedAt: string }[];
  origin?: string | null;
};

/**
 * Reads the signed-in user's chats from the server (the HttpOnly session
 * cookie decides whose) and hands them to the app, but only when the page
 * runs on the configured production origin.
 */
async function sendHistoryToApp() {
  const response = await fetch(`${BASE_PATH}/api/app-history`, {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    return;
  }
  const data = (await response.json()) as HistoryResponse;
  if (!data.origin || data.origin !== window.location.origin) {
    return;
  }
  const chats = (data.chats ?? [])
    .filter((chat) => BRIDGE_CHAT_ID.test(chat.id))
    .slice(0, MAX_HISTORY_CHATS)
    .map((chat) => ({
      id: chat.id,
      title: chat.title,
      updatedAt: formatRelativeTime(chat.updatedAt),
    }));
  postToApp("CHAT_HISTORY", { chats });
}

/** How often an app session is re-checked while the chat is open. */
const SESSION_RECHECK_MS = 5 * 60 * 1000;

function readFlag(key: string) {
  try {
    return window.sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    if (on) {
      window.sessionStorage.setItem(key, "1");
    } else {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Storage unavailable: the bridge messages are best-effort.
  }
}

function isDownloadUrl(url: URL) {
  return (
    url.protocol === "blob:" ||
    url.protocol === "data:" ||
    (url.origin === window.location.origin &&
      url.pathname.startsWith(`${BASE_PATH}/api/files/download`))
  );
}

/** External links can't open in the WebView: copy them instead. */
function handOffExternal(href: string) {
  if (!navigator.clipboard?.writeText) {
    toast.message(EMBED_LINK_BLOCKED_MESSAGE);
    return;
  }
  navigator.clipboard
    .writeText(href)
    .then(() => toast.message(EMBED_LINK_COPIED_MESSAGE))
    .catch(() => toast.message(EMBED_LINK_BLOCKED_MESSAGE));
}

/**
 * Applies one policy to every navigation attempt:
 * same-origin pages open in place, downloads and external links don't.
 * Returns true when the navigation was handled (caller should cancel it).
 */
function routeInsideApp(rawUrl: string, opensNewWindow: boolean): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl, window.location.href);
  } catch {
    return true;
  }
  if (isDownloadUrl(url)) {
    toast.message(EMBED_DOWNLOAD_MESSAGE);
    return true;
  }
  if (url.origin === window.location.origin) {
    if (opensNewWindow) {
      window.location.assign(url.href);
      return true;
    }
    return false;
  }
  handOffExternal(url.href);
  return true;
}

function handleDocumentClick(event: MouseEvent) {
  if (event.defaultPrevented) {
    return;
  }
  const { target } = event;
  if (!(target instanceof Element)) {
    return;
  }
  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) {
    return;
  }
  if (anchor.hasAttribute("download")) {
    event.preventDefault();
    event.stopPropagation();
    toast.message(EMBED_DOWNLOAD_MESSAGE);
    return;
  }
  const opensNewWindow = Boolean(anchor.target) && anchor.target !== "_self";
  if (routeInsideApp(anchor.href, opensNewWindow)) {
    event.preventDefault();
    event.stopPropagation();
  }
}

/**
 * Mounted once in the root layout. Renders nothing; in a normal browser it
 * does nothing at all. Bridge, links and session messages work whenever the
 * page runs in the app (embed layout or the full site with header and
 * sidebar); the app's theme hint applies to the embed layout only.
 */
export function AndroidEmbed() {
  const embedded = useIsEmbedded();
  const inApp = useIsInApp();
  const identity = useEmbedIdentity();
  const { setTheme } = useTheme();
  const router = useRouter();

  // App -> web: REQUEST_HISTORY and OPEN_CHAT, from window.postMessage (JSON
  // string, same origin or the app's native channel) or a
  // `thestudent:bridge` CustomEvent (JSON string in `detail`).
  useEffect(() => {
    if (!inApp) {
      return;
    }
    let inFlight = false;
    let again = false;
    const requestHistory = () => {
      if (inFlight) {
        // Answer again after the current request, with fresher data.
        again = true;
        return;
      }
      inFlight = true;
      again = false;
      sendHistoryToApp()
        .catch(() => {
          // Offline or signed out: the app keeps its current list.
        })
        .finally(() => {
          inFlight = false;
          if (again) {
            requestHistory();
          }
        });
    };
    const openChat = (chatId: string) => {
      const path = `/chat/${chatId}`;
      if (window.location.pathname !== `${BASE_PATH}${path}`) {
        // Client-side navigation: loads the conversation in place.
        router.push(path);
      }
    };
    const handle = (raw: unknown) => {
      const message = parseInboundMessage(raw);
      if (message?.type === "REQUEST_HISTORY") {
        requestHistory();
      } else if (message?.type === "OPEN_CHAT") {
        openChat(message.chatId);
      }
    };
    const onMessage = (event: MessageEvent) => {
      // Same-origin page messages, or "" for the app's native postWebMessage.
      if (event.origin !== window.location.origin && event.origin !== "") {
        return;
      }
      handle(event.data);
    };
    const onBridgeEvent = (event: Event) => {
      if (event instanceof CustomEvent) {
        handle(event.detail);
      }
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("thestudent:bridge", onBridgeEvent);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("thestudent:bridge", onBridgeEvent);
    };
  }, [inApp, router]);

  // Links, downloads and popups.
  useEffect(() => {
    if (!inApp) {
      return;
    }
    document.addEventListener("click", handleDocumentClick, true);
    const originalOpen = window.open;
    window.open = ((url?: string | URL) => {
      if (url) {
        routeInsideApp(String(url), true);
      } else {
        toast.message(EMBED_DOWNLOAD_MESSAGE);
      }
      return null;
    }) as typeof window.open;
    return () => {
      document.removeEventListener("click", handleDocumentClick, true);
      window.open = originalOpen;
    };
  }, [inApp]);

  // Theme from the app's identity payload (the URL theme is applied pre-paint).
  const identityTheme = identity?.theme;
  useEffect(() => {
    if (embedded && identityTheme) {
      setTheme(identityTheme);
    }
  }, [embedded, identityTheme, setTheme]);

  // Session <-> app. The HttpOnly cookie set by /api/app-auth is the only
  // auth source; the page just tells the app when that session is ready or
  // has expired (e.g. the account was signed out in the app).
  const { data: session, status, update } = useSession();
  const isAppSession =
    status === "authenticated" && session?.user?.appSession === true;
  const readyPostedRef = useRef(false);

  useEffect(() => {
    if (!inApp || status === "loading") {
      return;
    }
    if (isAppSession) {
      writeFlag(EMBED_APP_SESSION_KEY, true);
      if (!readyPostedRef.current) {
        readyPostedRef.current = true;
        postToApp("SESSION_READY");
      }
      return;
    }
    readyPostedRef.current = false;
    if (readFlag(EMBED_APP_SESSION_KEY)) {
      writeFlag(EMBED_APP_SESSION_KEY, false);
      // After a failed hand-off (/?auth=guest) the app already knows.
      const failedHandOff =
        new URLSearchParams(window.location.search).get("auth") === "guest";
      if (!failedHandOff) {
        postToApp("SESSION_EXPIRED");
      }
    }
  }, [inApp, status, isAppSession]);

  // Re-check an app session periodically while the chat is visible, so an
  // account signed out in the app is noticed (the server asks TheStudent API).
  useEffect(() => {
    if (!(inApp && isAppSession)) {
      return;
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        update().catch(() => undefined);
      }
    }, SESSION_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [inApp, isAppSession, update]);

  return null;
}
