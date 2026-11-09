import { z } from "zod";
import {
  ACCEPTED_CHAT_MODEL_IDS,
  DEFAULT_CHAT_MODEL,
  reasoningLevels,
} from "@/lib/ai/models";
import {
  MAX_VOICE_MS,
  MAX_VOICE_WORDS,
  VOICE_AUDIO_TYPES,
} from "@/lib/voice-message";

const textPartSchema = z.object({
  text: z.string().min(1).max(2000),
  type: z.enum(["text"]),
});

const filePartSchema = z.object({
  // text/plain: an uploaded PDF/Word/text file, already turned into text
  // by /api/files/upload (the original name is kept in `name`).
  // audio/*: a voice message recording (lib/voice-message.ts).
  mediaType: z.enum([
    "image/jpeg",
    "image/png",
    "text/plain",
    ...VOICE_AUDIO_TYPES,
  ]),
  name: z.string().min(1).max(100),
  type: z.enum(["file"]),
  url: z.url(),
});

// A voice message's words and timings (shown with the recording).
const voicePartSchema = z.object({
  data: z.object({
    duration: z
      .number()
      .min(0)
      .max(MAX_VOICE_MS + 60_000),
    words: z
      .array(
        z.object({
          start: z.number().min(0),
          text: z.string().min(1).max(100),
        })
      )
      .max(MAX_VOICE_WORDS),
  }),
  id: z.string().max(100).optional(),
  type: z.enum(["data-voice"]),
});

const partSchema = z.union([textPartSchema, filePartSchema, voicePartSchema]);

const userMessageSchema = z.object({
  id: z.uuid(),
  parts: z.array(partSchema),
  role: z.enum(["user"]),
});

const toolApprovalMessageSchema = z.object({
  id: z.string(),
  parts: z.array(z.record(z.string(), z.unknown())),
  role: z.enum(["user", "assistant"]),
});

export const postRequestBodySchema = z.object({
  id: z.uuid(),
  message: userMessageSchema.optional(),
  messages: z.array(toolApprovalMessageSchema).optional(),
  reasoning: z.enum(reasoningLevels).optional(),
  // Accept legacy ids from already-open clients, but the route always uses Auto.
  // Arbitrary provider or underlying model ids are never passed to the router.
  selectedChatModel: z
    .enum(ACCEPTED_CHAT_MODEL_IDS)
    .transform(() => DEFAULT_CHAT_MODEL)
    .default(DEFAULT_CHAT_MODEL),
  selectedVisibilityType: z.enum(["public", "private"]),
  // The Tools menu (lib/ai/tool-groups.ts). Missing tools stay on.
  tools: z
    .object({
      calculator: z.boolean().optional(),
      documents: z.boolean().optional(),
      study: z.boolean().optional(),
      weather: z.boolean().optional(),
      webFetch: z.boolean().optional(),
      webSearch: z.boolean().optional(),
    })
    .optional(),
  // Sent from a voice conversation: replies are spoken aloud, in this
  // language (components/chat/voice-call.tsx).
  voice: z
    .object({
      // "deep": the question needs thought (planning, advice, why...):
      // the model thinks first and gives a fuller answer (lib/voice-depth).
      depth: z.enum(["quick", "deep"]).optional(),
      // The student cut the last spoken reply short after hearing this
      // many of its words (0 = none), so the model doesn't assume they
      // heard it all. A count, not text: the words come from the saved
      // reply, so nothing from the browser goes into the instructions.
      interruptedAfterWords: z.number().int().min(0).max(2000).optional(),
      language: z.enum(["en-IN", "si-LK", "ta-LK"]),
    })
    .optional(),
  // Older clients only send this flag; web search stays on when omitted.
  webSearch: z.boolean().optional().default(true),
});

export type PostRequestBody = z.infer<typeof postRequestBodySchema>;
