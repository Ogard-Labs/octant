import type { ProviderFailure } from "@octant/contracts";
import {
  addNativeHarnessUsage,
  type NativeHarnessResponse,
  type NativeHarnessStreamEvent,
  type NativeHarnessUsage,
} from "../harness/nativeHarnessTransport";

/**
 * How a direct endpoint's request is sent again after a failure that usually
 * passes. The delays double from `baseDelayMs` up to `maxDelayMs` with a
 * little jitter so several sessions do not come back in the same instant; a
 * provider's own `Retry-After` replaces the local delay, capped so one header
 * cannot park a turn for an hour.
 */
export interface EndpointRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly retryAfterCapMs: number;
  readonly jitterRatio: number;
}

export const DEFAULT_ENDPOINT_RETRY_POLICY: EndpointRetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  retryAfterCapMs: 60_000,
  jitterRatio: 0.1,
};

/** The policy plus the two seams a test replaces so no real time passes. */
export interface EndpointRetryOptions extends Partial<EndpointRetryPolicy> {
  readonly random?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export type EndpointRetryReason =
  | "rate-limited"
  | "unavailable"
  | "stream-interrupted"
  | "empty-completion";

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
 * is to shrink the request (below) rather than to wait. Rate-limit and
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

/** The overflow failure a rejection body that names a filled window becomes, or undefined if it is another error. */
export function contextOverflowFromBody(text: string): ProviderFailure | undefined {
  if (!CONTEXT_OVERFLOW_MESSAGE.test(text)) return undefined;
  return { category: "provider-failed", message: CONTEXT_OVERFLOW_FAILURE_MESSAGE };
}

// The stream parsers report a stream that closed before its terminal event as
// a protocol failure with one of these sentences. The retry conformance test
// feeds each parser a truncated stream so a reworded message fails loudly.
const INTERRUPTED_STREAM_MESSAGE =
  /^The provider (?:stream ended without a (?:terminal|finish)|returned an empty response stream)/;

/**
 * Whether a failed request is worth sending again, and why. Rate limits and
 * transient unavailability (HTTP 408, 5xx, a refused or reset connection, an
 * idle stream) pass on their own; a rejected credential, an unsupported
 * endpoint, a malformed event, or a spent allowance does not.
 */
export function endpointRetryReason(failure: ProviderFailure): EndpointRetryReason | undefined {
  if (failure.usageLimit !== undefined && failure.usageLimit.kind !== "temporary") return undefined;
  switch (failure.category) {
    case "rate-limited":
      return "rate-limited";
    case "unavailable":
      return "unavailable";
    case "protocol":
      return INTERRUPTED_STREAM_MESSAGE.test(failure.message) ? "stream-interrupted" : undefined;
    default:
      return undefined;
  }
}

/** The wait before retry number `retryNumber` (1 is the first retry). */
export function endpointRetryDelayMs(input: {
  readonly retryNumber: number;
  readonly retryAfterMs?: number | undefined;
  readonly policy: EndpointRetryPolicy;
  readonly random: () => number;
}): number {
  const { policy } = input;
  if (input.retryAfterMs !== undefined) return Math.min(input.retryAfterMs, policy.retryAfterCapMs);
  const exponential = Math.min(
    policy.baseDelayMs * 2 ** Math.max(0, input.retryNumber - 1),
    policy.maxDelayMs,
  );
  const jitter = 1 + policy.jitterRatio * (2 * input.random() - 1);
  return Math.round(exponential * jitter);
}

// A failure that has used up its retries carries this mark out of the
// transport so the loop can tell "keeps failing" from "failed once, for good".
// A set rather than a field: the failure schema refuses unknown fields.
const exhausted = new WeakSet<object>();

export function isEndpointRetriesExhausted(error: unknown): boolean {
  return typeof error === "object" && error !== null && exhausted.has(error);
}

/**
 * Sends one model request through `attempt`, and sends it again while the
 * failure is retryable and nothing the user could see has streamed yet. Once
 * text has gone out a retry would show it twice, so the failure stands. Tool
 * calls only reach the loop with the settled response, never mid-stream, so
 * they do not count as output.
 *
 * Every retry is announced as a `retrying` event before its wait. What the
 * failed attempts cost is added to the usage of the ones after them, so the
 * turn's total includes every request the endpoint billed. A cancel ends the
 * wait at once and is never reported as a timeout.
 */
export async function sendWithEndpointRetry(input: {
  readonly signal: AbortSignal;
  readonly onEvent: (event: NativeHarnessStreamEvent) => void;
  readonly attempt: (stream: {
    readonly signal: AbortSignal;
    readonly onEvent: (event: NativeHarnessStreamEvent) => void;
  }) => Promise<NativeHarnessResponse>;
  readonly options?: EndpointRetryOptions | undefined;
}): Promise<NativeHarnessResponse> {
  const policy: EndpointRetryPolicy = { ...DEFAULT_ENDPOINT_RETRY_POLICY, ...input.options };
  const random = input.options?.random ?? Math.random;
  const sleep = input.options?.sleep ?? sleepUnlessCancelled;
  let billed: NativeHarnessUsage | undefined;

  for (let attemptNumber = 1; ; attemptNumber += 1) {
    const seen: { outputStarted: boolean; usage: NativeHarnessUsage | undefined } = {
      outputStarted: false,
      usage: undefined,
    };
    const priorBilled = billed;
    const onEvent = (event: NativeHarnessStreamEvent) => {
      if (event.kind === "text-delta" || event.kind === "reasoning-delta") {
        seen.outputStarted = true;
      }
      if (event.kind !== "usage") {
        input.onEvent(event);
        return;
      }
      const { kind: _kind, ...own } = event;
      seen.usage = own;
      input.onEvent({
        kind: "usage",
        ...(priorBilled === undefined ? own : addNativeHarnessUsage(priorBilled, own)),
      });
    };

    let failure: ProviderFailure;
    let reason: EndpointRetryReason;
    try {
      const response = await input.attempt({ signal: input.signal, onEvent });
      if (!isEmptyCompletion(response)) return withBilled(response, priorBilled);
      failure = {
        category: "provider-failed",
        message: "The provider returned an empty completion.",
      };
      reason = "empty-completion";
      seen.usage ??= response.usage;
    } catch (error) {
      if (input.signal.aborted || seen.outputStarted || !isProviderFailureShape(error)) throw error;
      const retryReason = endpointRetryReason(error);
      if (retryReason === undefined) throw error;
      failure = error;
      reason = retryReason;
    }
    if (seen.usage !== undefined) {
      billed = billed === undefined ? seen.usage : addNativeHarnessUsage(billed, seen.usage);
    }

    if (attemptNumber >= policy.maxAttempts) {
      exhausted.add(failure);
      throw failure;
    }
    const delayMs = endpointRetryDelayMs({
      retryNumber: attemptNumber,
      retryAfterMs: failure.retryAfterMs,
      policy,
      random,
    });
    input.onEvent({
      kind: "retrying",
      attempt: attemptNumber + 1,
      maxAttempts: policy.maxAttempts,
      delayMs,
      reason,
    });
    await sleep(delayMs, input.signal);
  }
}

function isEmptyCompletion(response: NativeHarnessResponse): boolean {
  return response.text.trim() === "" && response.toolCalls.length === 0;
}

function withBilled(
  response: NativeHarnessResponse,
  billed: NativeHarnessUsage | undefined,
): NativeHarnessResponse {
  if (billed === undefined) return response;
  return {
    ...response,
    usage: response.usage === undefined ? billed : addNativeHarnessUsage(billed, response.usage),
  };
}

function isProviderFailureShape(error: unknown): error is ProviderFailure {
  return typeof error === "object" && error !== null && "category" in error && "message" in error;
}

function sleepUnlessCancelled(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(interrupted());
      return;
    }
    const cancel = () => {
      clearTimeout(timer);
      reject(interrupted());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

function interrupted(): ProviderFailure {
  return { category: "interrupted", message: "The provider request was cancelled." };
}
