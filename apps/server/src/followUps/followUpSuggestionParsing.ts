import {
  FOLLOW_UP_BLOCK_LANGUAGE,
  MAX_FOLLOW_UP_NEXT_MESSAGE_LENGTH,
  MAX_NATIVE_HARNESS_FOLLOW_UPS,
  decodeNativeHarnessFollowUpSet,
  type FollowUpNextMessage,
  type NativeHarnessFollowUpSet,
  type NativeHarnessTurnId,
} from "@octant/contracts";

const FENCE = new RegExp(`\`\`\`${FOLLOW_UP_BLOCK_LANGUAGE}\\s*\\n([\\s\\S]*?)\`\`\``);

export interface ReplyFollowUps {
  /** Present when the block offered a task or a next message; its list may be empty. */
  readonly followUps: NativeHarnessFollowUpSet | undefined;
  readonly nextMessage: FollowUpNextMessage | undefined;
}

const NONE: ReplyFollowUps = { followUps: undefined, nextMessage: undefined };

/**
 * The follow-ups a reply ends with, if any. The fenced block is the model's
 * only channel for them, so a reply that carries none suggests nothing; a
 * malformed block is ignored rather than guessed at, because a suggestion
 * the model did not clearly make must not become a button. The predicted
 * next message stands on its own: an unreadable task list does not take it
 * away, and a prediction that is not one line a person would type is dropped
 * whole rather than cut mid-sentence.
 */
export function parseFollowUpSuggestions(input: {
  readonly text: string;
  readonly turnId: NativeHarnessTurnId;
  readonly uuid: () => string;
}): ReplyFollowUps {
  const match = FENCE.exec(input.text);
  if (match === null) return NONE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1] ?? "");
  } catch {
    return NONE;
  }
  if (typeof parsed !== "object" || parsed === null) return NONE;
  const block = parsed as { readonly suggestions?: unknown; readonly next?: unknown };
  const nextMessage = readNextMessage(block.next);
  const suggestions = readSuggestions(block.suggestions, input);
  if (suggestions === undefined) {
    return nextMessage === undefined
      ? NONE
      : { followUps: { turnId: input.turnId, suggestions: [] }, nextMessage };
  }
  return { followUps: suggestions, nextMessage };
}

function readNextMessage(raw: unknown): FollowUpNextMessage | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (text.length === 0 || text.length > MAX_FOLLOW_UP_NEXT_MESSAGE_LENGTH) return undefined;
  if (text.includes("\n")) return undefined;
  return text;
}

function readSuggestions(
  raw: unknown,
  input: { readonly turnId: NativeHarnessTurnId; readonly uuid: () => string },
): NativeHarnessFollowUpSet | undefined {
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
  if (suggestions.length === 0) return undefined;
  try {
    return decodeNativeHarnessFollowUpSet({ turnId: input.turnId, suggestions });
  } catch {
    return undefined;
  }
}
