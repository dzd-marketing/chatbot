import type { ToolGroupId } from "@/lib/ai/tool-groups";

/**
 * Study features shown as cards on the welcome screen. Picking one puts a
 * chip in the message input; the message is sent as "<label>: <text>", so
 * the student sees what they asked for and the model knows which tool to
 * use (see the "Study feature requests" section of lib/ai/prompts.ts).
 */

export const studyFeatureIds = [
  "papers",
  "quiz",
  "flashcards",
  "summarize",
  "notes",
  "solve",
] as const;

export type StudyFeatureId = (typeof studyFeatureIds)[number];

export type StudyFeature = {
  id: StudyFeatureId;
  /** Chip and card title; also the message prefix. */
  label: string;
  /** Short line under the title on the card. */
  description: string;
  /** Example inputs, rotated in the empty input. */
  hints: readonly string[];
  /** Tool groups the feature needs (switched on when it's picked). */
  tools: readonly ToolGroupId[];
  /** Can be sent with only an attached file (no typed text). */
  attachmentOnly?: boolean;
};

export const studyFeatures: readonly StudyFeature[] = [
  {
    description: "Past papers & marking schemes",
    hints: [
      "e.g. 2023 A/L Physics paper with marking scheme…",
      "e.g. O/L Maths past papers, Sinhala medium…",
      "e.g. 2022 A/L Chemistry model paper…",
    ],
    id: "papers",
    label: "Download papers",
    tools: ["webSearch", "webFetch"],
  },
  {
    description: "Test yourself with MCQs",
    hints: [
      "Topic and number of questions, e.g. Acids and bases, 10…",
      "e.g. A/L Physics: Newton's laws, 5 hard questions…",
      "e.g. O/L History chapter 3, in Sinhala…",
    ],
    id: "quiz",
    label: "Create quiz",
    tools: ["study"],
  },
  {
    description: "Memorise key terms fast",
    hints: [
      "e.g. A/L Biology cell organelles…",
      "e.g. O/L Science: chemical formulas…",
      "e.g. English vocabulary for essays…",
    ],
    id: "flashcards",
    label: "Flashcards",
    tools: ["study"],
  },
  {
    attachmentOnly: true,
    description: "PDF, Word file or a link",
    hints: [
      "Attach a PDF or Word file, or paste a link…",
      "Add a focus, e.g. key points for revision…",
    ],
    id: "summarize",
    label: "Summarize document",
    tools: ["webFetch"],
  },
  {
    description: "Short notes to download",
    hints: [
      "e.g. Newton's laws, short notes for A/L…",
      "e.g. O/L Geography: climate of Sri Lanka…",
      "e.g. Photosynthesis notes in Sinhala…",
    ],
    id: "notes",
    label: "Study notes",
    tools: ["documents"],
  },
  {
    description: "Maths & science problems",
    hints: [
      "Type or paste the problem, e.g. Solve 2x² − 5x + 3 = 0…",
      "e.g. A car goes from 0 to 72 km/h in 8 s. Find a…",
      "e.g. Integrate x·eˣ with respect to x…",
    ],
    id: "solve",
    label: "Solve step by step",
    tools: ["calculator"],
  },
];

export const getStudyFeature = (id: StudyFeatureId) =>
  studyFeatures.find((feature) => feature.id === id);

/** The message text sent for a feature request. */
export function featureMessage(feature: StudyFeature, text: string) {
  const trimmed = text.trim();
  return trimmed ? `${feature.label}: ${trimmed}` : feature.label;
}

/** Splits a sent message back into its feature and the student's text. */
export function parseFeatureMessage(
  text: string
): { feature: StudyFeature; rest: string } | null {
  for (const feature of studyFeatures) {
    if (text === feature.label) {
      return { feature, rest: "" };
    }
    if (text.startsWith(`${feature.label}: `)) {
      return { feature, rest: text.slice(feature.label.length + 2) };
    }
  }
  return null;
}
