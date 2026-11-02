"use client";

import { useSession } from "next-auth/react";
import { useTheme } from "next-themes";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useEmbedIdentity, useIsEmbedded } from "@/hooks/use-android-embed";
import { postToApp } from "@/lib/android-bridge";
import {
  EMBED_APP_SESSION_KEY,
  EMBED_DOWNLOAD_MESSAGE,
  EMBED_LINK_BLOCKED_MESSAGE,
  EMBED_LINK_COPIED_MESSAGE,
} from "@/lib/android-embed";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
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
 * does nothing at all.
 */
export function AndroidEmbed() {
  const embedded = useIsEmbedded();
  const identity = useEmbedIdentity();
  const { setTheme } = useTheme();

  // Links, downloads and popups.
  useEffect(() => {
    if (!embedded) {
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
  }, [embedded]);

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
    if (!embedded || status === "loading") {
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
  }, [embedded, status, isAppSession]);

  // Re-check an app session periodically while the chat is visible, so an
  // account signed out in the app is noticed (the server asks TheStudent API).
  useEffect(() => {
    if (!(embedded && isAppSession)) {
      return;
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        update().catch(() => undefined);
      }
    }, SESSION_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [embedded, isAppSession, update]);

  return null;
}
