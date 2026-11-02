/**
 * Android embed mode.
 *
 * The TheStudent Android app opens the site in a WebView at
 * `/?app=android&theme=dark|light&q=<question>`. In that mode the site hides
 * its own chrome (the app draws its own top bar), keeps everything in one
 * column, and avoids anything a WebView can't do (new tabs, popups,
 * downloads). In a normal browser none of this runs.
 *
 * Detection happens once, before first paint, in EMBED_DETECT_SCRIPT (inlined
 * in the root layout's <head>). It sets `data-embed="android"` on <html>,
 * which the `embed:` Tailwind variant and the helpers below read. The flag is
 * kept in sessionStorage so it survives in-app navigation and reloads, where
 * the query string is gone.
 */

export const EMBED_SESSION_KEY = "thestudent-embed";
/** sessionStorage marker: this tab had an app SSO session (no secrets). */
export const EMBED_APP_SESSION_KEY = "thestudent-app-session";
const EMBED_VALUE = "android";

/**
 * Runs in <head> before React and next-themes. It must stay dependency-free
 * and ES5-safe. A valid `theme` param is written to next-themes' storage key
 * ("theme") and applied straight to <html>, so there is no light/dark flash.
 */
export const EMBED_DETECT_SCRIPT = `(function () {
  try {
    var root = document.documentElement;
    var params = new URLSearchParams(window.location.search);
    var embedded =
      params.get("app") === "${EMBED_VALUE}" ||
      / TheStudentAndroid\\//.test(navigator.userAgent || "") ||
      window.sessionStorage.getItem("${EMBED_SESSION_KEY}") === "${EMBED_VALUE}";
    if (!embedded) return;
    window.sessionStorage.setItem("${EMBED_SESSION_KEY}", "${EMBED_VALUE}");
    root.setAttribute("data-embed", "${EMBED_VALUE}");
    var theme = params.get("theme");
    if (theme === "dark" || theme === "light") {
      window.localStorage.setItem("theme", theme);
      root.classList.remove("light", "dark");
      root.classList.add(theme);
      root.style.colorScheme = theme;
    }
  } catch (error) {}
})();`;

/** True only inside the Android app's WebView (client-side). */
export function isAndroidEmbed(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset.embed === EMBED_VALUE
  );
}

export type EmbedTheme = "dark" | "light";

/**
 * Display hints from the app's legacy `window.__THESTUDENT_USER__` message.
 * This is a CLIENT claim: it only sets a display name and theme. It never
 * grants access or picks an account; the HttpOnly session cookie from
 * /api/app-auth is the only auth source (and its userId/email are ignored).
 */
export type StudentIdentity = {
  name: string;
  theme: EmbedTheme | null;
};

const CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/gu;

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/** Validates the `{ type: "THESTUDENT_USER", ... }` payload from the app. */
export function parseIdentity(value: unknown): StudentIdentity | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as Record<string, unknown>;
  if (data.type !== "THESTUDENT_USER") {
    return null;
  }
  if (data.source !== undefined && data.source !== EMBED_VALUE) {
    return null;
  }
  const name = cleanText(data.name, 60);
  const theme =
    data.theme === "dark" || data.theme === "light" ? data.theme : null;
  if (!(name || theme)) {
    return null;
  }
  return { name, theme };
}

/* ------------------------------------------------------------------------ */
/* Identity store: window.__THESTUDENT_USER__ at startup + postMessage.      */
/* ------------------------------------------------------------------------ */

declare global {
  interface Window {
    __THESTUDENT_USER__?: unknown;
  }
}

let currentIdentity: StudentIdentity | null = null;
const listeners = new Set<() => void>();
let listening = false;

function sameIdentity(a: StudentIdentity | null, b: StudentIdentity | null) {
  return a?.name === b?.name && a?.theme === b?.theme;
}

function setIdentity(next: StudentIdentity | null) {
  if (!next || sameIdentity(currentIdentity, next)) {
    return;
  }
  currentIdentity = next;
  for (const listener of listeners) {
    listener();
  }
}

function handleMessage(event: MessageEvent) {
  if (event.origin !== window.location.origin) {
    return;
  }
  if (event.data?.type !== "THESTUDENT_USER") {
    return;
  }
  setIdentity(parseIdentity(event.data));
}

function startListening() {
  if (listening || typeof window === "undefined" || !isAndroidEmbed()) {
    return;
  }
  listening = true;
  setIdentity(parseIdentity(window.__THESTUDENT_USER__));
  window.addEventListener("message", handleMessage);
  // The app injects twice ~700 ms apart; if the global landed between our
  // first read and the listener being attached, pick it up shortly after.
  window.setTimeout(
    () => setIdentity(parseIdentity(window.__THESTUDENT_USER__)),
    1500
  );
}

export function subscribeIdentity(listener: () => void) {
  startListening();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getIdentity(): StudentIdentity | null {
  return currentIdentity;
}

/* ------------------------------------------------------------------------ */
/* User-facing messages for things the WebView can't do.                     */
/* ------------------------------------------------------------------------ */

export const EMBED_DOWNLOAD_MESSAGE =
  "Downloads aren't available in the app yet. Open TheStudent in your browser to download.";
export const EMBED_LINK_COPIED_MESSAGE =
  "Link copied. Paste it in your browser to open it.";
export const EMBED_LINK_BLOCKED_MESSAGE =
  "This link opens outside the app. Open it in your browser.";
