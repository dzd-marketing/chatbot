/**
 * Website <-> Android app messages.
 *
 * Web -> app: the app injects `window.TheStudentBridge` only into the main
 * frame of ASSISTANT_WEB_ORIGIN. It carries notifications and the chat list
 * (ids, titles, times); there are no events that read or write credentials,
 * and nothing secret (token, email, cookie) is ever sent.
 *
 * App -> web: JSON strings via `window.postMessage` or a `thestudent:bridge`
 * CustomEvent. Only REQUEST_HISTORY and OPEN_CHAT are acted on.
 */

import { isAndroidEmbed } from "./android-embed";

export const BRIDGE_MESSAGE_TYPES = [
  "SESSION_READY",
  "SESSION_EXPIRED",
  "NEW_CHAT",
  "CLOSE",
  "OPEN_PAPERS",
  "SHARE_TEXT",
  "CHAT_HISTORY",
] as const;

export type BridgeMessageType = (typeof BRIDGE_MESSAGE_TYPES)[number];

type TheStudentBridge = {
  postMessage: (message: string) => void;
  onmessage?: ((event: { data?: unknown }) => void) | null;
};

declare global {
  interface Window {
    TheStudentBridge?: TheStudentBridge;
  }
}

function getBridge(): TheStudentBridge | null {
  if (typeof window === "undefined" || !isAndroidEmbed()) {
    return null;
  }
  // Main frame only, matching where the app injects the bridge.
  if (window.top !== window) {
    return null;
  }
  const bridge = window.TheStudentBridge;
  return bridge && typeof bridge.postMessage === "function" ? bridge : null;
}

/**
 * Sends `{ type, ...payload }` to the app when the bridge exists. Returns
 * false when it doesn't (normal browser, older app) or the type isn't allowed.
 */
export function postToApp(
  type: BridgeMessageType,
  payload: Record<string, unknown> = {}
): boolean {
  if (!BRIDGE_MESSAGE_TYPES.includes(type)) {
    return false;
  }
  const bridge = getBridge();
  if (!bridge) {
    return false;
  }
  try {
    if (!bridge.onmessage) {
      // The app acknowledges with {"ok":true}; nothing to do with it.
      bridge.onmessage = () => undefined;
    }
    bridge.postMessage(JSON.stringify({ ...payload, type }));
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------ */
/* App -> web                                                                */
/* ------------------------------------------------------------------------ */

/** Chat ids the app may ask to open (our ids are UUIDs, which match). */
export const BRIDGE_CHAT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_INBOUND_LENGTH = 4096;

export type InboundBridgeMessage =
  | { type: "REQUEST_HISTORY" }
  | { type: "OPEN_CHAT"; chatId: string };

/**
 * Parses an app -> web message (a JSON string; a plain object is accepted
 * too). Anything other than a valid REQUEST_HISTORY / OPEN_CHAT is null.
 */
export function parseInboundMessage(raw: unknown): InboundBridgeMessage | null {
  let value = raw;
  if (typeof value === "string") {
    if (value.length > MAX_INBOUND_LENGTH) {
      return null;
    }
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as Record<string, unknown>;
  if (data.type === "REQUEST_HISTORY") {
    return { type: "REQUEST_HISTORY" };
  }
  if (
    data.type === "OPEN_CHAT" &&
    typeof data.chatId === "string" &&
    BRIDGE_CHAT_ID.test(data.chatId)
  ) {
    return { chatId: data.chatId, type: "OPEN_CHAT" };
  }
  return null;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Compact "2h ago" style label for the app's history drawer. */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return "";
  }
  const elapsed = Math.max(0, now - time);
  if (elapsed < MINUTE) {
    return "just now";
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)}m ago`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)}h ago`;
  }
  if (elapsed < WEEK) {
    return `${Math.floor(elapsed / DAY)}d ago`;
  }
  if (elapsed < 5 * WEEK) {
    return `${Math.floor(elapsed / WEEK)}w ago`;
  }
  const date = new Date(time);
  return date.toLocaleDateString("en", {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === new Date(now).getFullYear()
      ? {}
      : { year: "numeric" }),
  });
}
