const MAX_TITLE_LENGTH = 56;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function titleTextFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) => {
      if (!isRecord(part)) {
        return "";
      }

      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }

      if (part.type === "file" && typeof part.filename === "string") {
        return `File: ${part.filename}`;
      }

      if (part.type === "file" && part.mediaType === "audio") {
        return "Voice message";
      }

      return "";
    })
    .filter(Boolean)
    .join(" ")
    .trim();
}

function cleanTitleText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s>*#`-]+/, "")
    .trim();
}

function isGreeting(text: string): boolean {
  return /^(?:hi|hello|hey|good morning|good afternoon|good evening|thanks|thank you)[.!?,\s]*$/i.test(
    text.trim()
  );
}

function limitTitle(title: string): string {
  if (title.length <= MAX_TITLE_LENGTH) {
    return title;
  }

  const shortened = title.slice(0, MAX_TITLE_LENGTH + 1);
  const lastSpace = shortened.lastIndexOf(" ");
  return (
    lastSpace > 20
      ? shortened.slice(0, lastSpace)
      : shortened.slice(0, MAX_TITLE_LENGTH)
  ).trim();
}

export function fallbackTitleFromText(text: string): string {
  const cleaned = cleanTitleText(text);
  if (!cleaned || isGreeting(cleaned)) {
    return "New Conversation";
  }

  const words = cleaned.split(/\s+/u).filter(Boolean);
  const title = limitTitle(words.slice(0, 7).join(" "));
  return title
    ? title.charAt(0).toLocaleUpperCase() + title.slice(1)
    : "New Conversation";
}

export function normalizeGeneratedTitle(
  candidate: unknown,
  sourceText: string
): string {
  const generated =
    typeof candidate === "string"
      ? candidate
          .replace(/^(?:chat\s+)?title\s*:\s*/i, "")
          .replace(/^[#*"'“”\s]+|[#*"'“”\s]+$/g, "")
          .replace(/\s+/g, " ")
          .trim()
      : "";

  const generic =
    /^(?:new chat|new conversation|untitled(?: chat)?|chat)$/i.test(generated);
  if (
    !generated ||
    generated.length > 100 ||
    (generic && !isGreeting(sourceText))
  ) {
    return fallbackTitleFromText(sourceText);
  }

  return limitTitle(generated);
}
