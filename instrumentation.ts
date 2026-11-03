import { OpenTelemetry } from "@ai-sdk/otel";
import { registerOTel } from "@vercel/otel";
import { registerTelemetry } from "ai";
import { parseSsoConfig } from "./lib/sso/config";

export function register() {
  registerOTel({ serviceName: "chatbot" });
  registerTelemetry(new OpenTelemetry());

  // Report a bad app SSO config at server start. /api/app-auth fails closed
  // (guest) until it is fixed; the rest of the site keeps working.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      parseSsoConfig();
    } catch (error) {
      console.error(
        `[app-auth] One-time-code app sign-in (/api/app-auth) is disabled; the token handshake is unaffected: ${error instanceof Error ? error.message : "invalid SSO config"}`
      );
    }
  }
}
