import { MAX_PROVIDER_TOOL_RESULT_BYTES } from "@octant/contracts";

/**
 * A tool result as the provider receives it: JSON, and never larger than the
 * encoders accept. A result that would be larger is replaced by a truncated
 * preview that says so, so the model learns the call ran and reads what fits
 * rather than the whole turn failing on an oversized answer.
 */
export function boundedToolResultJson(result: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(result === undefined ? null : result);
  } catch {
    json = JSON.stringify({ error: "tool-result-unserializable" });
  }
  if (json.length <= MAX_PROVIDER_TOOL_RESULT_BYTES) return json;
  const preview = json.slice(0, PREVIEW_LENGTH);
  return JSON.stringify({
    error: "tool-result-too-large",
    truncated: true,
    originalBytes: json.length,
    preview,
  });
}

const PREVIEW_LENGTH = 48_000;
