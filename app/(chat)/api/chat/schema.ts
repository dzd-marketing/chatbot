import { z } from "zod";
import { reasoningLevels } from "@/lib/ai/models";

const textPartSchema = z.object({
  text: z.string().min(1).max(2000),
  type: z.enum(["text"]),
});

const filePartSchema = z.object({
  // text/plain: an uploaded PDF/Word/text file, already turned into text
  // by /api/files/upload (the original name is kept in `name`).
  mediaType: z.enum(["image/jpeg", "image/png", "text/plain"]),
  name: z.string().min(1).max(100),
  type: z.enum(["file"]),
  url: z.url(),
});

const partSchema = z.union([textPartSchema, filePartSchema]);

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
  selectedChatModel: z.string(),
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
  // Older clients only send this flag; web search stays on when omitted.
  webSearch: z.boolean().optional().default(true),
});

export type PostRequestBody = z.infer<typeof postRequestBodySchema>;
