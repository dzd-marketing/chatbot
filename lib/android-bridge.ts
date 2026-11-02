/**
 * Website -> Android app messages.
 *
 * The app injects `window.TheStudentBridge` only into the main frame of
 * ASSISTANT_WEB_ORIGIN. It carries notifications only; there are no events
 * that read or write credentials, and nothing secret is ever sent.
 */

import { isAndroidEmbed } from "./android-embed";

export const BRIDGE_MESSAGE_TYPES = [
  "SESSION_READY",
  "SESSION_EXPIRED",
  "NEW_CHAT",
  "CLOSE",
  "OPEN_PAPERS",
  "SHARE_TEXT",
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
 * Sends `{ type }` to the app when the bridge exists. Returns false when it
 * doesn't (normal browser, older app) or the type isn't allowed.
 */
export function postToApp(type: BridgeMessageType): boolean {
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
    bridge.postMessage(JSON.stringify({ type }));
    return true;
  } catch {
    return false;
  }
}
