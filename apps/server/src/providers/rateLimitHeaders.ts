import type { UtcTimestamp } from "@octant/contracts";

/**
 * A quota bucket read from the headers of a response Octant already received.
 * Nothing here comes from a request made to learn limits; the provider volunteered
 * the numbers alongside the generation it was asked for.
 */
export interface ObservedRateLimitBucket {
  readonly bucket: "requests" | "tokens";
  readonly limit: number;
  readonly remaining: number;
  readonly resetsAt?: UtcTimestamp;
}

/** Resets further out than this are treated as malformed rather than believed. */
const MAX_RESET_MS = 7 * 24 * 3_600_000;

/**
 * Reads the `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` headers
 * that OpenAI-compatible and Azure AI Foundry endpoints attach to accepted
 * responses. The reset header is a duration such as `6m0s`, `1s`, or `120ms`,
 * converted to an instant against `now` at read time because a duration is
 * meaningless once the response is no longer fresh.
 */
export function readOpenAiRateLimitBuckets(
  headers: Headers,
  now: number,
): ReadonlyArray<ObservedRateLimitBucket> {
  return buckets((bucket) => ({
    limit: headers.get(`x-ratelimit-limit-${bucket}`),
    remaining: headers.get(`x-ratelimit-remaining-${bucket}`),
    resetsAt: resetFromDuration(headers.get(`x-ratelimit-reset-${bucket}`), now),
  }));
}

/**
 * Reads the `anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset}`
 * headers of the Messages API. Only the combined token bucket is read; the
 * separate input and output token buckets have no home on
 * `ProviderServiceLimits` and are left out rather than folded into a number
 * the provider did not report.
 */
export function readAnthropicRateLimitBuckets(
  headers: Headers,
): ReadonlyArray<ObservedRateLimitBucket> {
  return buckets((bucket) => ({
    limit: headers.get(`anthropic-ratelimit-${bucket}-limit`),
    remaining: headers.get(`anthropic-ratelimit-${bucket}-remaining`),
    resetsAt: resetFromInstant(headers.get(`anthropic-ratelimit-${bucket}-reset`)),
  }));
}

interface RawBucket {
  readonly limit: string | null;
  readonly remaining: string | null;
  readonly resetsAt: UtcTimestamp | undefined;
}

function buckets(
  read: (bucket: ObservedRateLimitBucket["bucket"]) => RawBucket,
): ReadonlyArray<ObservedRateLimitBucket> {
  const observed: ObservedRateLimitBucket[] = [];
  for (const bucket of ["requests", "tokens"] as const) {
    const raw = read(bucket);
    const limit = count(raw.limit);
    const remaining = count(raw.remaining);
    // A pair that contradicts itself (remaining above limit, or a zero limit)
    // is dropped whole: clamping would present a number the provider never
    // sent as if it had.
    if (limit === undefined || remaining === undefined || limit <= 0 || remaining > limit) {
      continue;
    }
    observed.push({
      bucket,
      limit,
      remaining,
      ...(raw.resetsAt === undefined ? {} : { resetsAt: raw.resetsAt }),
    });
  }
  return observed;
}

function count(value: string | null): number | undefined {
  if (value === null || !/^\d{1,15}$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function resetFromDuration(value: string | null, now: number): UtcTimestamp | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (text.length === 0 || !/^(\d+(?:\.\d+)?(?:ms|h|m|s))+$/.test(text)) return undefined;
  let milliseconds = 0;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    const amount = Number(match[1]);
    switch (match[2]) {
      case "h":
        milliseconds += amount * 3_600_000;
        break;
      case "m":
        milliseconds += amount * 60_000;
        break;
      case "s":
        milliseconds += amount * 1_000;
        break;
      default:
        milliseconds += amount;
    }
  }
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > MAX_RESET_MS) {
    return undefined;
  }
  return instant(now + Math.round(milliseconds));
}

function resetFromInstant(value: string | null): UtcTimestamp | undefined {
  if (value === null) return undefined;
  const parsed = Date.parse(value.trim());
  return Number.isNaN(parsed) ? undefined : instant(parsed);
}

function instant(milliseconds: number): UtcTimestamp | undefined {
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : (date.toISOString() as UtcTimestamp);
}
