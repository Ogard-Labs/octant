import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import type { CanvasMathBlock } from "@octant/contracts/canvas";

/**
 * Math blocks an agent is shown when it asks how to write one.
 *
 * Wire shape, not a branded block: describe returns these objects as-is. Each
 * source stays inside the subset the policy admits, so an agent copying one
 * learns the markup that draws rather than a command that is refused.
 */

/** One formula on its own line, named by a caption a screen reader reads first. */
export const bayesTheoremExample = {
  blockId: "bayes-theorem",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "math" as const,
  layout: "display" as const,
  source: "P(A \\mid B) = \\frac{P(B \\mid A)\\,P(A)}{P(B)}",
  caption: "Bayes' theorem",
} as const;

/** A short derivation set as aligned steps. */
export const queueingDerivationExample = {
  blockId: "queue-length",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "math" as const,
  layout: "display" as const,
  source:
    "\\begin{aligned} L &= \\lambda W \\\\ &= 120\\,\\text{req/s} \\times 0.25\\,\\text{s} \\\\ &= 30 \\end{aligned}",
  caption: "Requests in flight by Little's law",
} as const;

/** A sentence that carries its formulas inline, prose and markup in separate runs. */
export const amdahlParagraphExample = {
  blockId: "amdahl-limit",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "math" as const,
  layout: "inline" as const,
  runs: [
    { text: "With a parallel fraction " },
    { math: "p" },
    { text: " spread over " },
    { math: "s" },
    { text: " workers the speed-up is " },
    { math: "S = \\frac{1}{(1 - p) + p/s}" },
    { text: ", so at " },
    { math: "p = 0.9" },
    { text: " no number of workers passes " },
    { math: "10\\times" },
    { text: "." },
  ],
} as const;

export const mathExamples = [
  bayesTheoremExample,
  queueingDerivationExample,
  amdahlParagraphExample,
] as const;

function mathBlock(value: unknown): CanvasMathBlock {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "math") {
    throw new Error("Math example did not decode as a math block.");
  }
  return block;
}

export const mathExampleBlocks: ReadonlyArray<CanvasMathBlock> = mathExamples.map(mathBlock);
