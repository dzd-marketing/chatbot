"use client";

import { signOut } from "next-auth/react";
import { useTheme } from "next-themes";
import { useEffect } from "react";
import { toast } from "sonner";
import { useEmbedIdentity, useIsEmbedded } from "@/hooks/use-android-embed";
import {
  EMBED_ACCOUNT_KEY,
  EMBED_DOWNLOAD_MESSAGE,
  EMBED_LINK_BLOCKED_MESSAGE,
  EMBED_LINK_COPIED_MESSAGE,
} from "@/lib/android-embed";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

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

  // Shared phones: if a different student signs in to the app, drop the old
  // web session so they don't see the previous student's chats.
  const userId = identity?.userId;
  useEffect(() => {
    if (!(embedded && userId)) {
      return;
    }
    let previous: string | null = null;
    try {
      previous = window.localStorage.getItem(EMBED_ACCOUNT_KEY);
      window.localStorage.setItem(EMBED_ACCOUNT_KEY, userId);
    } catch {
      return;
    }
    if (previous && previous !== userId) {
      window.localStorage.removeItem("input");
      signOut({ redirect: false })
        .catch(() => {
          // Fall through to a fresh guest session either way.
        })
        .finally(() => {
          window.location.replace(
            `${BASE_PATH}/api/auth/guest?redirectUrl=${encodeURIComponent(`${BASE_PATH}/`)}`
          );
        });
    }
  }, [embedded, userId]);

  return null;
}
