/**
 * Browser helpers for TheStudent Android app's WebView:
 *  - the injected bridge window.TheStudentAndroid (isAndroidApp,
 *    getSessionToken), and
 *  - the THESTUDENT_AUTH_HANDSHAKE message, captured from the very start of
 *    the page by HANDSHAKE_CAPTURE_SCRIPT (it can arrive before React loads).
 * Tokens found here are only *sent to our server*, which verifies them with
 * auth.php; nothing here grants access by itself.
 */

type AndroidBridge = {
  isAndroidApp?: () => boolean;
  getSessionToken?: () => unknown;
};

type HandshakeState = { token: string; info: string };

declare global {
  interface Window {
    __thestudentHandshake?: HandshakeState;
    TheStudentAndroid?: AndroidBridge;
  }
}

export const APP_TOKEN_PATTERN = /^[A-Fa-f0-9]{32,256}$/;
export const HANDSHAKE_TYPE = "THESTUDENT_AUTH_HANDSHAKE";
/** DOM event fired by the capture script when a valid handshake arrives. */
export const HANDSHAKE_EVENT = "thestudent:handshake";

/** Set on log out so the login screen doesn't sign straight back in. */
export const LOGGED_OUT_FLAG = "thestudent:logged-out";

/**
 * Inline <script> for the login page. Accepts the handshake as an object or
 * a JSON string, from this page's own origin or from native code (origin
 * ""), and remembers the latest token (non-enumerable, in memory only).
 */
export const HANDSHAKE_CAPTURE_SCRIPT = `(function(){try{
var re=${APP_TOKEN_PATTERN.toString()};
var st={token:"",info:"not received"};
Object.defineProperty(window,"__thestudentHandshake",{value:st,configurable:true});
window.addEventListener("message",function(e){
if(e.origin!==location.origin&&e.origin!=="")return;
var d=e.data;
if(typeof d==="string"){try{d=JSON.parse(d)}catch(_){return}}
if(!d||d.type!=="${HANDSHAKE_TYPE}")return;
var t=typeof d.token==="string"?d.token.trim():"";
if(!re.test(t)){st.info="received, invalid token ("+t.length+" chars)";return}
st.token=t;st.info="received";
window.dispatchEvent(new Event("${HANDSHAKE_EVENT}"));
});
}catch(_){}})();`;

export function isAndroidApp(): boolean {
  try {
    return window.TheStudentAndroid?.isAndroidApp?.() === true;
  } catch {
    return false;
  }
}

function bridgeToken(): string {
  try {
    const value = window.TheStudentAndroid?.getSessionToken?.();
    const token = typeof value === "string" ? value.trim() : "";
    return APP_TOKEN_PATTERN.test(token) ? token : "";
  } catch {
    return "";
  }
}

/** The app's bearer token (bridge first, then the handshake), or "". */
export function readAppToken(): string {
  return bridgeToken() || window.__thestudentHandshake?.token || "";
}

/** Waits up to `ms` for a token (the app may post the handshake late). */
export function waitForAppToken(ms: number): Promise<string> {
  const now = readAppToken();
  if (now) {
    return Promise.resolve(now);
  }
  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timer);
      window.removeEventListener(HANDSHAKE_EVENT, done);
      resolve(readAppToken());
    };
    const timer = window.setTimeout(done, ms);
    window.addEventListener(HANDSHAKE_EVENT, done);
  });
}

/** Android System WebView, or anything that looks like our app. */
export function looksLikeAppWebView(): boolean {
  return (
    /; wv\)|TheStudentAndroid/.test(navigator.userAgent) ||
    "TheStudentAndroid" in window
  );
}

/**
 * One line explaining why 1-tap login found no token, for the app
 * developer. Never includes the token itself, only its length/shape.
 */
export function describeAppBridge(): string {
  const parts: string[] = [`page ${window.location.origin}`];
  const bridge = window.TheStudentAndroid;

  if (bridge) {
    const kind = typeof bridge.getSessionToken;
    if (kind === "function") {
      let result: string;
      try {
        const value = bridge.getSessionToken?.();
        if (typeof value !== "string") {
          result = `returned ${value === null ? "null" : typeof value}`;
        } else if (value.trim() === "") {
          result = "returned an empty string";
        } else {
          const v = value.trim();
          result = `returned ${v.length} chars, ${/^[A-Fa-f0-9]+$/.test(v) ? "hex" : "not hex"}`;
        }
      } catch {
        result = "threw an error";
      }
      parts.push(`TheStudentAndroid found, getSessionToken() ${result}`);
    } else {
      parts.push(`TheStudentAndroid found, getSessionToken is ${kind}`);
    }
  } else {
    const similar = Object.getOwnPropertyNames(window)
      .filter(
        (k) => /thestudent|android|bridge/i.test(k) && !k.startsWith("__")
      )
      .slice(0, 5);
    parts.push(
      similar.length > 0
        ? `TheStudentAndroid missing (found: ${similar.join(", ")})`
        : "TheStudentAndroid missing"
    );
  }

  parts.push(
    `handshake ${window.__thestudentHandshake?.info ?? "listener not loaded"}`
  );
  return parts.join(" · ");
}
