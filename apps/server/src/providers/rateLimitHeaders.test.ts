import { describe, expect, it } from "vitest";
import { readAnthropicRateLimitBuckets, readOpenAiRateLimitBuckets } from "./rateLimitHeaders";

const now = Date.parse("2026-08-24T01:00:00.000Z");

describe("rate-limit response headers", () => {
  it("turns OpenAI-style duration resets into instants against the response time", () => {
    const headers = new Headers({
      "x-ratelimit-limit-requests": "5000",
      "x-ratelimit-remaining-requests": "4999",
      "x-ratelimit-reset-requests": "6m0s",
      "x-ratelimit-limit-tokens": "800000",
      "x-ratelimit-remaining-tokens": "799500",
      "x-ratelimit-reset-tokens": "1.5s",
    });

    expect(readOpenAiRateLimitBuckets(headers, now)).toEqual([
      { bucket: "requests", limit: 5000, remaining: 4999, resetsAt: "2026-08-24T01:06:00.000Z" },
      {
        bucket: "tokens",
        limit: 800_000,
        remaining: 799_500,
        resetsAt: "2026-08-24T01:00:01.500Z",
      },
    ]);
  });

  it("reads Anthropic's RFC 3339 resets and leaves the split token buckets out", () => {
    const headers = new Headers({
      "anthropic-ratelimit-requests-limit": "50",
      "anthropic-ratelimit-requests-remaining": "49",
      "anthropic-ratelimit-requests-reset": "2026-08-24T01:01:00Z",
      "anthropic-ratelimit-tokens-limit": "40000",
      "anthropic-ratelimit-tokens-remaining": "39000",
      "anthropic-ratelimit-input-tokens-limit": "30000",
      "anthropic-ratelimit-input-tokens-remaining": "29000",
    });

    expect(readAnthropicRateLimitBuckets(headers)).toEqual([
      { bucket: "requests", limit: 50, remaining: 49, resetsAt: "2026-08-24T01:01:00.000Z" },
      { bucket: "tokens", limit: 40_000, remaining: 39_000 },
    ]);
  });

  it("drops a bucket that contradicts itself instead of clamping it", () => {
    const headers = new Headers({
      "x-ratelimit-limit-requests": "10",
      "x-ratelimit-remaining-requests": "11",
      "x-ratelimit-limit-tokens": "0",
      "x-ratelimit-remaining-tokens": "0",
    });

    expect(readOpenAiRateLimitBuckets(headers, now)).toEqual([]);
  });

  it("keeps a bucket whose reset header is unreadable, without a reset instant", () => {
    const headers = new Headers({
      "x-ratelimit-limit-requests": "10",
      "x-ratelimit-remaining-requests": "3",
      "x-ratelimit-reset-requests": "soon",
    });

    expect(readOpenAiRateLimitBuckets(headers, now)).toEqual([
      { bucket: "requests", limit: 10, remaining: 3 },
    ]);
  });

  it("reports nothing for a response without rate-limit headers", () => {
    expect(
      readOpenAiRateLimitBuckets(new Headers({ "content-type": "text/event-stream" }), now),
    ).toEqual([]);
    expect(readAnthropicRateLimitBuckets(new Headers())).toEqual([]);
  });
});
