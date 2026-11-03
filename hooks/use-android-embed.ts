"use client";

import { useSyncExternalStore } from "react";
import {
  getIdentity,
  isAndroidEmbed,
  isInApp,
  type StudentIdentity,
  subscribeIdentity,
} from "@/lib/android-embed";

const noopSubscribe = () => () => {
  // The embed flag is set once before hydration and never changes.
};
const serverFalse = () => false;
const serverNull = () => null;

/** `true` inside the Android app's WebView. Always `false` on the server. */
export function useIsEmbedded(): boolean {
  return useSyncExternalStore(noopSubscribe, isAndroidEmbed, serverFalse);
}

/** `true` inside the Android app (any layout). Always `false` on the server. */
export function useIsInApp(): boolean {
  return useSyncExternalStore(noopSubscribe, isInApp, serverFalse);
}

/** The student the Android app says is signed in (display only). */
export function useEmbedIdentity(): StudentIdentity | null {
  return useSyncExternalStore(subscribeIdentity, getIdentity, serverNull);
}
