import { generateDummyPassword } from "./db/utils";

export const isProductionEnvironment = process.env.NODE_ENV === "production";
export const isDevelopmentEnvironment = process.env.NODE_ENV === "development";
export const isTestEnvironment = Boolean(
  process.env.PLAYWRIGHT_TEST_BASE_URL ||
    process.env.PLAYWRIGHT ||
    process.env.CI_PLAYWRIGHT
);

export const guestRegex = /^guest-\d+$/;

export const DUMMY_PASSWORD = generateDummyPassword();

// Student-oriented starter prompts shown on the DZD Learn welcome screen.
export const suggestions = [
  "Explain Newton's three laws of motion with A/L-style examples",
  "Solve step by step: integrate x·e^x with respect to x",
  "ප්‍රභාසංශ්ලේෂණය සරලව පැහැදිලි කරන්න (O/L විද්‍යාව)",
  "Make me a 2-week revision timetable for O/L Mathematics",
];
