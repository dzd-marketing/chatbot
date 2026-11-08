/**
 * Explicit exam-resource requests should start with a real web search, not an
 * optional model decision. Keep this focused on resources the app can fetch.
 */
const EXAM_RESOURCE =
  /\b(?:past[\s-]*(?:exam(?:ination)?[\s-]*)?papers?|(?:exam(?:ination)?|model|question)\s+papers?|mark(?:ing)?[\s-]+schemes?|term[\s-]+tests?|syllab(?:us|i)|timetables?|download\s+(?:past\s+)?papers?)\b/i;

const RESOURCE_LOOKUP_INTENT =
  /\b(?:find|search|look\s+(?:up|for)|download|fetch|retrieve|get|send|share|give|provide|want|need|where|when|latest|current|official)\b/i;
const EXAM_YEAR = /\b(?:19|20)\d{2}\b/;
const NON_ENGLISH_EXAM_RESOURCE_REQUEST = /(?:ප්‍රශ්න\s*පත්‍ර|வினாத்தாள்|கேள்வித்தாள்)/u;

export function isExamResourceRequest(text: string) {
  const normalizedText = text.trim();
  if (NON_ENGLISH_EXAM_RESOURCE_REQUEST.test(normalizedText)) {
    return true;
  }
  return (
    EXAM_RESOURCE.test(normalizedText) &&
    (RESOURCE_LOOKUP_INTENT.test(normalizedText) ||
      EXAM_YEAR.test(normalizedText))
  );
}
