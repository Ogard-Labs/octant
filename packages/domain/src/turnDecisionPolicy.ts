import {
  FOLLOW_UP_BLOCK_LANGUAGE,
  MAX_TURN_DECISION_ASK_LENGTH,
  MAX_TURN_DECISION_OPTION_LENGTH,
  MAX_TURN_DECISION_OPTIONS,
  TURN_DECISION_BLOCK_LANGUAGE,
} from "@octant/contracts";

/**
 * What a finished Work or Code turn asked the person to decide: one short ask
 * and up to four options, exactly one recommended. An option is the text the
 * thread's next turn would carry; it names no action the host takes.
 */
export interface TurnDecision {
  readonly ask: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly recommended: boolean }>;
}

/**
 * The marker closes the reply, so only its tail is read: a long reply costs no
 * more to check than a short one, and a block quoted earlier in the text is
 * never mistaken for the ask.
 */
const TAIL_CHARACTERS = 4_096;

const CLOSING_FOLLOW_UPS = new RegExp(
  `\`\`\`${FOLLOW_UP_BLOCK_LANGUAGE}[^\\n]*\\n[\\s\\S]*?\`\`\`\\s*$`,
);
const CLOSING_DECISION = new RegExp(
  `\`\`\`${TURN_DECISION_BLOCK_LANGUAGE}[^\\n]*\\n([\\s\\S]*?)\`\`\`\\s*$`,
);

/**
 * The decision a normalized reply closes with, or undefined. The block must
 * be the last thing in the reply (a follow-up block may still come after it,
 * since both are asked for at the end). Anything the model did not state
 * clearly — no block, a block mid-reply, unreadable JSON, an ask past one
 * line, too many or too long options, or anything but exactly one
 * recommendation — raises nothing rather than a guessed decision.
 */
export function parseTurnDecision(reply: string): TurnDecision | undefined {
  const tail = reply.slice(-TAIL_CHARACTERS).replace(CLOSING_FOLLOW_UPS, "").trimEnd();
  const match = CLOSING_DECISION.exec(tail);
  if (match === null) return undefined;
  return readTurnDecisionBlock(match[1] ?? "");
}

/** The decision one block's body states, under the same rules as {@link parseTurnDecision}. */
export function readTurnDecisionBlock(body: string): TurnDecision | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as { readonly ask?: unknown; readonly options?: unknown };
  const ask = typeof record.ask === "string" ? record.ask.trim() : "";
  if (ask.length === 0 || ask.length > MAX_TURN_DECISION_ASK_LENGTH || /[\r\n]/.test(ask)) {
    return undefined;
  }
  if (
    !Array.isArray(record.options) ||
    record.options.length === 0 ||
    record.options.length > MAX_TURN_DECISION_OPTIONS
  ) {
    return undefined;
  }
  const options: Array<{ readonly label: string; readonly recommended: boolean }> = [];
  for (const entry of record.options as ReadonlyArray<unknown>) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const option = entry as { readonly label?: unknown; readonly recommended?: unknown };
    const label = typeof option.label === "string" ? option.label.trim() : "";
    if (
      label.length === 0 ||
      label.length > MAX_TURN_DECISION_OPTION_LENGTH ||
      /[\r\n]/.test(label)
    ) {
      return undefined;
    }
    if (option.recommended !== undefined && typeof option.recommended !== "boolean") {
      return undefined;
    }
    options.push({ label, recommended: option.recommended === true });
  }
  if (options.filter((option) => option.recommended).length !== 1) return undefined;
  if (new Set(options.map((option) => option.label)).size !== options.length) return undefined;
  return { ask, options };
}

/**
 * Whether a thread's decision is still open. It lasts from its turn's end
 * until the thread takes another turn (the asking turn is then no longer the
 * latest one that completed), or the person completes, snoozes, or archives
 * the thread. A turn that was interrupted or failed asked nothing.
 */
export function turnDecisionIsOpen(input: {
  readonly latestTurnCompleted: boolean;
  readonly archived: boolean;
  readonly completed: boolean;
  readonly snoozed: boolean;
}): boolean {
  return input.latestTurnCompleted && !input.archived && !input.completed && !input.snoozed;
}
