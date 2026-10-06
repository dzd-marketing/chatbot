/** A safe file name from a document title. */
export function fileNameFor(title: string, extension: string) {
  const base =
    Array.from(title)
      .map((character) => (character.charCodeAt(0) < 32 ? " " : character))
      .join("")
      // "A/L" -> "A-L"
      .replace(/[\\/]+/g, "-")
      .replace(/[:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "DZD Learn document";
  return `${base}.${extension}`;
}
