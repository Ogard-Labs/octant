import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import type { CanvasComparisonMatrixBlock } from "@octant/contracts/canvas";

/**
 * Comparison matrices an agent is shown when it asks how to draw one.
 *
 * Wire shape, not a branded block: describe returns these objects as-is. The
 * readings are the author's judgement written down, so each example carries a
 * note where a score needs its reason, and a recommendation the author states
 * rather than one the scores imply.
 */

/** An architecture decision: weighted criteria, 1-to-5 scores, a glyph row, and a text row. */
export const stateStoreDecisionExample = {
  blockId: "state-store-decision",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "comparison-matrix" as const,
  options: [
    { optionId: "sqlite", label: "SQLite", detail: "One file per host" },
    { optionId: "postgres", label: "Postgres", detail: "Managed server" },
    { optionId: "journal-files", label: "Journal files", detail: "Append-only JSON" },
  ],
  criteria: [
    { criterionId: "durability", label: "Crash safety", weight: 3 },
    {
      criterionId: "operations",
      label: "Operational cost",
      weight: 2,
      prefer: "lower" as const,
      detail: "What a person has to run and watch",
    },
    { criterionId: "queries", label: "Ad-hoc queries", weight: 1 },
    { criterionId: "offline", label: "Works offline", weight: 2 },
    { criterionId: "licence", label: "Licence" },
  ],
  cells: [
    { criterionId: "durability", optionId: "sqlite", score: 5, note: "WAL with synchronous=FULL" },
    { criterionId: "durability", optionId: "postgres", score: 5 },
    {
      criterionId: "durability",
      optionId: "journal-files",
      score: 3,
      note: "Needs our own fsync and torn-write recovery",
    },
    { criterionId: "operations", optionId: "sqlite", score: 1 },
    { criterionId: "operations", optionId: "postgres", score: 4 },
    { criterionId: "operations", optionId: "journal-files", score: 2 },
    { criterionId: "queries", optionId: "sqlite", score: 4 },
    { criterionId: "queries", optionId: "postgres", score: 5 },
    { criterionId: "queries", optionId: "journal-files", score: 1 },
    { criterionId: "offline", optionId: "sqlite", glyph: "yes" as const },
    {
      criterionId: "offline",
      optionId: "postgres",
      glyph: "partial" as const,
      note: "Only with a local server",
    },
    { criterionId: "offline", optionId: "journal-files", glyph: "yes" as const },
    { criterionId: "licence", optionId: "sqlite", text: "Public domain" },
    { criterionId: "licence", optionId: "postgres", text: "PostgreSQL" },
    { criterionId: "licence", optionId: "journal-files", text: "Ours" },
  ],
  scoreRange: { min: 1, max: 5 },
  recommendedOptionId: "sqlite",
  recommendation:
    "A local-first host has no server to run, and SQLite gives the journal crash safety without one.",
} as const;

/** A feature comparison read entirely in yes, partial, and no. */
export const editorFeaturesExample = {
  blockId: "editor-features",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "comparison-matrix" as const,
  options: [
    { optionId: "monaco", label: "Monaco" },
    { optionId: "codemirror", label: "CodeMirror 6" },
    { optionId: "textarea", label: "Plain textarea" },
  ],
  criteria: [
    { criterionId: "syntax", label: "Syntax highlighting" },
    { criterionId: "mobile", label: "Touch editing", weight: 2 },
    { criterionId: "size", label: "Small bundle", weight: 2 },
  ],
  cells: [
    { criterionId: "syntax", optionId: "monaco", glyph: "yes" as const },
    { criterionId: "syntax", optionId: "codemirror", glyph: "yes" as const },
    { criterionId: "syntax", optionId: "textarea", glyph: "no" as const },
    { criterionId: "mobile", optionId: "monaco", glyph: "no" as const },
    { criterionId: "mobile", optionId: "codemirror", glyph: "yes" as const },
    { criterionId: "mobile", optionId: "textarea", glyph: "yes" as const },
    { criterionId: "size", optionId: "monaco", glyph: "no" as const },
    {
      criterionId: "size",
      optionId: "codemirror",
      glyph: "partial" as const,
      note: "Grows with each language package",
    },
    { criterionId: "size", optionId: "textarea", glyph: "yes" as const },
  ],
} as const;

export const comparisonMatrixExamples = [stateStoreDecisionExample, editorFeaturesExample] as const;

function comparisonMatrixBlock(value: unknown): CanvasComparisonMatrixBlock {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "comparison-matrix") {
    throw new Error("Comparison matrix example did not decode as a comparison matrix block.");
  }
  return block;
}

export const comparisonMatrixExampleBlocks: ReadonlyArray<CanvasComparisonMatrixBlock> =
  comparisonMatrixExamples.map(comparisonMatrixBlock);
