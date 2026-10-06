import type { InferUITool, UIMessage } from "ai";
import { z } from "zod";
import type { ArtifactKind } from "@/components/chat/artifact";
import type { calculate } from "./ai/tools/calculate";
import type { createDocument } from "./ai/tools/create-document";
import type { getWeather } from "./ai/tools/get-weather";
import type { readDocument } from "./ai/tools/read-document";
import type { requestSuggestions } from "./ai/tools/request-suggestions";
import type { shareFiles } from "./ai/tools/share-files";
import type { createFlashcards, createQuiz } from "./ai/tools/study";
import type { updateDocument } from "./ai/tools/update-document";
import type { webFetch, webSearch } from "./ai/tools/web";
import type { Suggestion } from "./db/schema";

export const messageMetadataSchema = z.object({
  createdAt: z.string(),
});

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

type weatherTool = InferUITool<typeof getWeather>;
type createDocumentTool = InferUITool<ReturnType<typeof createDocument>>;
type updateDocumentTool = InferUITool<ReturnType<typeof updateDocument>>;
type requestSuggestionsTool = InferUITool<
  ReturnType<typeof requestSuggestions>
>;
type webSearchTool = InferUITool<typeof webSearch>;
type webFetchTool = InferUITool<typeof webFetch>;
type readDocumentTool = InferUITool<typeof readDocument>;
type shareFilesTool = InferUITool<typeof shareFiles>;
type calculateTool = InferUITool<typeof calculate>;
type createQuizTool = InferUITool<typeof createQuiz>;
type createFlashcardsTool = InferUITool<typeof createFlashcards>;

export type ChatTools = {
  getWeather: weatherTool;
  createDocument: createDocumentTool;
  updateDocument: updateDocumentTool;
  requestSuggestions: requestSuggestionsTool;
  webSearch: webSearchTool;
  webFetch: webFetchTool;
  readDocument: readDocumentTool;
  shareFiles: shareFilesTool;
  calculate: calculateTool;
  createQuiz: createQuizTool;
  createFlashcards: createFlashcardsTool;
};

export type WaitingStatusData = {
  phase: "waiting" | "still-waiting" | "health" | "thinking";
  message: string;
  modelId: string;
  modelName: string;
};

/**
 * DZD Learn AI's server-side work for one reply: live status lines from the
 * Space's `dzd_progress` chunks, then the optional tool-step telemetry.
 * Updated in place while streaming and saved with the message.
 */
export type DzdActivityData = {
  status: "running" | "done";
  progress: string[];
  toolSteps?: { tool: string; ms?: number }[];
  totalMs?: number;
};

export type CustomUIDataTypes = {
  textDelta: string;
  imageDelta: string;
  sheetDelta: string;
  codeDelta: string;
  suggestion: Suggestion;
  appendMessage: string;
  id: string;
  title: string;
  kind: ArtifactKind;
  clear: null;
  finish: null;
  "chat-title": string;
  "waiting-status": WaitingStatusData;
  /** Follow-up suggestions shown under the latest assistant reply. */
  suggestions: string[];
  "dzd-activity": DzdActivityData;
  /** The student stopped this reply (lib/chat/stopped.ts). */
  stopped: null;
};

export type ChatMessage = UIMessage<
  MessageMetadata,
  CustomUIDataTypes,
  ChatTools
>;

export type Attachment = {
  name: string;
  url: string;
  contentType: string;
};
