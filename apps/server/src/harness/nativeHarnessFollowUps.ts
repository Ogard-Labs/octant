import {
  MAX_NATIVE_HARNESS_FOLLOW_UPS,
  decodeNativeHarnessFollowUpSet,
  type NativeHarnessFollowUpSet,
  type NativeHarnessTurnId,
} from "@octant/contracts";

const FENCE = /```octant-follow-ups\s*\n([\s\S]*?)```/;

/**
 * The follow-ups a reply ends with, if any. The fenced block is the lead's
 * only channel for them, so a reply that carries none suggests nothing; a
 * malformed block is ignored rather than guessed at, because a suggestion
 * the model did not clearly make must not become a button.
 */
export function parseNativeHarnessFollowUps(input: {
  readonly text: string;
  readonly turnId: NativeHarnessTurnId;
  readonly uuid: () => string;
}): NativeHarnessFollowUpSet | undefined {
  const match = FENCE.exec(input.text);
  if (match === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1] ?? "");
  } catch {
    return undefined;
  }
  const raw = (parsed as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(raw)) return undefined;
  const suggestions = raw
    .slice(0, MAX_NATIVE_HARNESS_FOLLOW_UPS)
    .map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      return {
        id: input.uuid(),
        title: typeof record.title === "string" ? record.title.trim().slice(0, 120) : "",
        prompt: typeof record.prompt === "string" ? record.prompt.trim().slice(0, 4_096) : "",
        target: record.target,
      };
    })
    .filter((entry) => entry.title.length > 0 && entry.prompt.length > 0);
  try {
    return decodeNativeHarnessFollowUpSet({ turnId: input.turnId, suggestions });
  } catch {
    return undefined;
  }
}

/** The reply without its follow-up block, for surfaces that render chips separately. */
export function stripNativeHarnessFollowUps(text: string): string {
  return text.replace(FENCE, "").trimEnd();
}
