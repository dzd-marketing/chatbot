"use client";

import { CalculatorIcon } from "lucide-react";
import { Shimmer } from "../ai-elements/shimmer";

type CalculationResult = {
  expression: string;
  result?: string;
  error?: string;
};

export function Calculation({
  expressions,
  results,
}: {
  expressions: string[];
  results?: CalculationResult[];
}) {
  if (!results) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <CalculatorIcon className="size-3.5" />
        <Shimmer as="span" duration={1}>
          Calculating…
        </Shimmer>
      </div>
    );
  }

  const rows: CalculationResult[] =
    results.length > 0
      ? results
      : expressions.map((expression) => ({ expression }));

  return (
    <div className="w-fit max-w-full rounded-xl border border-border/50 bg-card/60 px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
        <CalculatorIcon className="size-3" />
        Calculator
      </div>
      <div className="flex flex-col gap-0.5 font-mono text-[13px]">
        {rows.map((row, index) => (
          <div
            className="flex flex-wrap gap-x-2"
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
            key={index}
          >
            <span className="break-all text-muted-foreground">
              {row.expression}
            </span>
            {row.result === undefined ? null : (
              <span className="break-all font-semibold text-foreground">
                = {row.result}
              </span>
            )}
            {row.error ? (
              <span className="text-red-600 dark:text-red-400">
                ({row.error})
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
