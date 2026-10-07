import type { ProviderOutputStopReason } from "@octant/contracts";

/**
 * The protocol strings that mean the output limit, across the wire shapes
 * that report one. A string that is not one of these is not a stop reason
 * Octant can say.
 */
const OUTPUT_LIMIT = new Set(["length", "max_tokens", "max_output_tokens", "max-tokens"]);

/** The protocol strings that mean a content filter stopped the reply. */
const CONTENT_FILTER = new Set(["content_filter", "content-filter"]);

/**
 * The normalized stop reason for a protocol string, or absent when the
 * runtime did not report one Octant understands. Callers leave the field off
 * the completed event in that case.
 */
export function outputStopReason(
  raw: string | null | undefined,
): ProviderOutputStopReason | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (OUTPUT_LIMIT.has(raw)) return "max-tokens";
  if (CONTENT_FILTER.has(raw)) return "content-filter";
  return undefined;
}
