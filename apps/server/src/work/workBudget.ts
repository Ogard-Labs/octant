import type { WorkArtifactFormat } from "@octant/contracts/work-artifacts";

/**
 * Work mutation budgets. The server enforces input size, output size, and
 * parser time before and during every mutation; exhaustion fails closed as
 * `oversize` or `interrupted` rather than silently truncating content or
 * hanging the thread. Budgets are conservative defaults; slices C-F may
 * narrow them per format adapter but never widen them past these ceilings.
 */
export const MAX_WORK_INPUT_BYTES = 16 * 1024 * 1024;
export const MAX_WORK_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_WORK_DISPLAY_NAME_BYTES = 512;
export const WORK_PARSER_TIMEOUT_MS = 30_000;

const encoder = new TextEncoder();

export type WorkBudgetRejection = "oversize-input" | "oversize-output" | "oversize-display-name";

/**
 * Validate mutation input content against the input budget. Returns the
 * rejection code when the content exceeds the budget or is not valid UTF-8
 * (the renderer sends text; binary content arrives through format-specific
 * adapters in slices C-F).
 */
export function validateWorkInputBudget(content: string): WorkBudgetRejection | undefined {
  const bytes = encoder.encode(content);
  if (bytes.byteLength > MAX_WORK_INPUT_BYTES) return "oversize-input";
  return undefined;
}

export function validateWorkDisplayNameBudget(
  displayName: string,
): WorkBudgetRejection | undefined {
  if (encoder.encode(displayName).byteLength > MAX_WORK_DISPLAY_NAME_BYTES) {
    return "oversize-display-name";
  }
  return undefined;
}

export function validateWorkOutputBudget(byteLength: number): WorkBudgetRejection | undefined {
  if (byteLength > MAX_WORK_OUTPUT_BYTES) return "oversize-output";
  return undefined;
}

/**
 * Formats the slice B generic text adapter can produce and round-trip. Binary
 * formats (docx, xlsx, pptx, pdf, image) require format-specific adapters
 * (slices C-F) and fail closed as `unsupported` until those adapters land.
 */
export const WORK_TEXT_ADAPTER_FORMATS: ReadonlySet<WorkArtifactFormat> = new Set([
  "markdown",
  "csv",
  "markdown-deck",
]);
