import assert from "node:assert/strict";
import { test } from "node:test";
import { postRequestBodySchema } from "@/app/(chat)/api/chat/schema";
import { ACCEPTED_CHAT_MODEL_IDS, DEFAULT_CHAT_MODEL } from "./models";

test("normalizes current and legacy chat choices to Auto", () => {
  const id = "00000000-0000-4000-8000-000000000000";

  for (const selectedChatModel of ACCEPTED_CHAT_MODEL_IDS) {
    const result = postRequestBodySchema.parse({
      id,
      selectedChatModel,
      selectedVisibilityType: "private",
    });
    assert.equal(result.selectedChatModel, DEFAULT_CHAT_MODEL);
  }
});
