import type { ProviderFailure } from "@octant/contracts";

// How a direct endpoint's refusal reads when a request outgrew the model's
// context window. The wire parsers word their failures with it and the host
// reads them back with it, so it sits apart from the host's retry policy: an
// endpoint reaches it without loading anything of the harness.

/**
 * How providers word a refusal that the model's context window is too small.
 * OpenAI reports `context_length_exceeded`, Anthropic says the "prompt is too
 * long", and OpenAI-compatible hosts answer a 400 or 413 with a comparable
 * sentence or code. One predicate reads every shape so a driver that surfaces
 * the provider's own text and one that normalizes it are recognised alike.
 */
const CONTEXT_OVERFLOW_MESSAGE =
  /context_length_exceeded|prompt is too long|context length|context window|context limit|maximum context|too many tokens|reduce the length of/i;

/** The sentence a driver substitutes when it recognizes an overflow body but keeps no raw text. */
export const CONTEXT_OVERFLOW_FAILURE_MESSAGE =
  "The provider rejected the request because it exceeded the model's context length.";

/**
 * Whether the endpoint refused a request because it outgrew the model's
 * context window. Unlike the retryable reasons this failure does not clear on
 * its own: sending the same request again fails the same way, so the recovery
 * is to shrink the request rather than to wait. Rate-limit and
 * unavailability failures are never overflow even when their text mentions a
 * window, because those do lift on their own.
 */
export function isContextOverflowFailure(failure: ProviderFailure): boolean {
  if (failure.category === "rate-limited" || failure.category === "unavailable") return false;
  if (failure.usageLimit !== undefined && failure.usageLimit.kind !== "temporary") return false;
  return (
    failure.message === CONTEXT_OVERFLOW_FAILURE_MESSAGE ||
    CONTEXT_OVERFLOW_MESSAGE.test(failure.message)
  );
}

/**
 * How refusals name the window they enforce. OpenAI, Azure and vLLM say "maximum
 * context length is N tokens", Anthropic "prompt is too long: X tokens > N
 * maximum", Mistral "model with N maximum context length", llama.cpp "available
 * context size (N tokens)"; the last pattern reads the sentence a driver
 * substitutes below, so the number survives a driver that keeps no raw text.
 */
const CONTEXT_WINDOW_IN_REFUSAL = [
  /maximum context length (?:is|of) ([\d,]+) tokens/i,
  /prompt is too long: [\d,]+ tokens? > ([\d,]+) maximum/i,
  /model with ([\d,]+) maximum context length/i,
  /available context size \(([\d,]+) tokens?\)/i,
  /context (?:length|window|limit) (?:is|of) ([\d,]+) tokens/i,
] as const;

// A figure outside these bounds is a misread (a request size, a status code),
// never a window worth learning.
const MIN_LEARNED_CONTEXT_WINDOW = 1_024;
const MAX_LEARNED_CONTEXT_WINDOW = 100_000_000;

/** The context window an overflow refusal names, or undefined when it names none Octant can read. */
export function contextWindowFromRefusal(text: string): number | undefined {
  for (const pattern of CONTEXT_WINDOW_IN_REFUSAL) {
    const digits = pattern.exec(text)?.[1]?.replaceAll(",", "");
    if (digits === undefined) continue;
    const value = Number(digits);
    if (
      Number.isSafeInteger(value) &&
      value >= MIN_LEARNED_CONTEXT_WINDOW &&
      value <= MAX_LEARNED_CONTEXT_WINDOW
    ) {
      return value;
    }
  }
  return undefined;
}

/** The overflow failure a rejection body that names a filled window becomes, or undefined if it is another error. */
export function contextOverflowFromBody(text: string): ProviderFailure | undefined {
  if (!CONTEXT_OVERFLOW_MESSAGE.test(text)) return undefined;
  const contextWindow = contextWindowFromRefusal(text);
  return {
    category: "provider-failed",
    message:
      contextWindow === undefined
        ? CONTEXT_OVERFLOW_FAILURE_MESSAGE
        : `The provider rejected the request because it exceeded the model's context length of ${contextWindow} tokens.`,
  };
}
