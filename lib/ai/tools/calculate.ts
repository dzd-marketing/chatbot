import "server-only";

import { tool } from "ai";
import { all, create } from "mathjs";
import { z } from "zod";

/**
 * Exact arithmetic for the AI (models often get numbers wrong): mathjs with
 * units, e.g. "9.81 m/s^2 * 2.5 kg", "5 km/h to m/s", "sqrt(2)*sin(30 deg)".
 * Functions that could run code or build huge results are disabled.
 */

const math = create(all, { number: "number", precision: 64 });
const evaluate = math.evaluate.bind(math);
const format = math.format.bind(math);

const DISABLED = [
  "import",
  "createUnit",
  "reviver",
  "evaluate",
  "parse",
  "compile",
  "simplify",
  "derivative",
  "resolve",
  "rationalize",
  "zeros",
  "ones",
  "identity",
  "range",
  "matrix",
  "sparse",
  "bignumber",
  "bigint",
  "fraction",
  "random",
  "randomInt",
  "pickRandom",
];

math.import(
  Object.fromEntries(
    DISABLED.map((name) => [
      name,
      () => {
        throw new Error(`${name} is not available`);
      },
    ])
  ),
  { override: true }
);

const MAX_EXPRESSION_CHARS = 300;

function calculateOne(expression: string) {
  const trimmed = expression.trim();
  if (!trimmed) {
    return { error: "Empty expression", expression };
  }
  if (trimmed.length > MAX_EXPRESSION_CHARS) {
    return { error: "Expression is too long", expression };
  }
  // ":" builds ranges (huge matrices); ";" and "=" define things.
  if (/[:;]|(^|[^=!<>])=(?!=)/.test(trimmed)) {
    return {
      error: "Only plain calculations are supported (no ranges or variables)",
      expression,
    };
  }
  try {
    const value = evaluate(trimmed);
    if (typeof value === "function" || value === undefined) {
      return { error: "That isn't a calculation", expression };
    }
    const result = format(value, { precision: 12 });
    if (result.length > 500) {
      return { error: "The result is too large to show", expression };
    }
    return { expression, result };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Invalid expression",
      expression,
    };
  }
}

export const calculate = tool({
  description:
    "Calculate exactly. Use it for any arithmetic beyond simple mental maths, scientific formulas and unit conversions, instead of computing in your head. Supports + - * / ^, sqrt, sin/cos/tan (use 'deg' for degrees, e.g. sin(30 deg)), log (natural), log10, exp, abs, round, factorial, pi, e, and units, e.g. '9.81 m/s^2 * 2.5 kg', '72 km/h to m/s', '(6.02e23 * 2.5) / 1000'. Several expressions can be done at once.",
  execute: ({ expressions }) => ({
    results: expressions.map(calculateOne),
  }),
  inputSchema: z.object({
    expressions: z
      .array(z.string().max(MAX_EXPRESSION_CHARS))
      .min(1)
      .max(10)
      .describe("Expressions to calculate, e.g. ['2.5 * 9.81', '5 cm to m']."),
  }),
});
