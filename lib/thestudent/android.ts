/**
 * Browser helpers for the bridge TheStudent Android app injects into its
 * WebView (window.TheStudentAndroid). Absent in normal browsers.
 */

type AndroidBridge = {
  isAndroidApp?: () => boolean;
  getSessionToken?: () => string;
};

declare global {
  interface Window {
    TheStudentAndroid?: AndroidBridge;
  }
}

export const APP_TOKEN_PATTERN = /^[A-Fa-f0-9]{32,256}$/;
export const HANDSHAKE_TYPE = "THESTUDENT_AUTH_HANDSHAKE";

/** Set on log out so the login screen doesn't sign straight back in. */
export const LOGGED_OUT_FLAG = "thestudent:logged-out";

export function isAndroidApp(): boolean {
  try {
    return window.TheStudentAndroid?.isAndroidApp?.() === true;
  } catch {
    return false;
  }
}

/** The app's bearer token, or "" (not in the app / not signed in). */
export function readAppToken(): string {
  try {
    const token = window.TheStudentAndroid?.getSessionToken?.();
    return typeof token === "string" && APP_TOKEN_PATTERN.test(token.trim())
      ? token.trim()
      : "";
  } catch {
    return "";
  }
}
