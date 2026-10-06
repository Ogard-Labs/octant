import type { ProviderFailure } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import type { NativeHarnessResponse } from "../harness/nativeHarnessTransport";
import {
  DEFAULT_ENDPOINT_RETRY_POLICY,
  endpointRetryDelayMs,
  endpointRetryReason,
  isEndpointRetriesExhausted,
  sendWithEndpointRetry,
} from "./endpointRetry";

const failure = (category: ProviderFailure["category"], message = "failed."): ProviderFailure => ({
  category,
  message,
});

describe("which endpoint failures are worth retrying", () => {
  it.each([
    [failure("rate-limited"), "rate-limited"],
    [failure("unavailable"), "unavailable"],
    [
      failure("protocol", "The provider stream ended without a terminal completion."),
      "stream-interrupted",
    ],
    [
      failure("protocol", "The provider stream ended without a terminal event."),
      "stream-interrupted",
    ],
    [
      failure("protocol", "The provider stream ended without a terminal response."),
      "stream-interrupted",
    ],
    [
      failure("protocol", "The provider stream ended without a finish reason."),
      "stream-interrupted",
    ],
  ] as const)("retries %j", (input, reason) => {
    expect(endpointRetryReason(input)).toBe(reason);
  });

  it.each([
    failure("unauthenticated"),
    failure("unauthorized"),
    failure("unsupported"),
    failure("invalid-configuration"),
    failure("interrupted"),
    failure("provider-failed"),
    failure("protocol", "The provider stream contained an invalid Chat Completions event."),
    { ...failure("rate-limited"), usageLimit: { kind: "billing" } },
    { ...failure("rate-limited"), usageLimit: { kind: "exhausted" } },
  ] as const)("does not retry %j", (input) => {
    expect(endpointRetryReason(input)).toBeUndefined();
  });

  it("retries a rate limit that lifts on its own", () => {
    expect(
      endpointRetryReason({ ...failure("rate-limited"), usageLimit: { kind: "temporary" } }),
    ).toBe("rate-limited");
  });
});

describe("how long a retry waits", () => {
  const policy = DEFAULT_ENDPOINT_RETRY_POLICY;
  const delay = (retryNumber: number, random = 0.5, retryAfterMs?: number) =>
    endpointRetryDelayMs({ retryNumber, retryAfterMs, policy, random: () => random });

  it("doubles from half a second and stops growing at ten", () => {
    expect([1, 2, 3, 4, 5, 6].map((retry) => delay(retry))).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 10_000,
    ]);
  });

  it("spreads each wait by about a tenth either way", () => {
    expect(delay(3, 0)).toBe(1_800);
    expect(delay(3, 1)).toBe(2_200);
  });

  it("uses the provider's Retry-After instead, capped at a minute", () => {
    expect(delay(1, 0.5, 7_000)).toBe(7_000);
    expect(delay(1, 0.5, 600_000)).toBe(60_000);
  });
});

describe("sending a request again", () => {
  const answer: NativeHarnessResponse = { text: "done", toolCalls: [] };
  const instant = { sleep: async () => undefined, random: () => 0.5 };

  it("marks the failure it gives up on so the loop can tell it kept failing", async () => {
    const spent = failure("unavailable", "The provider request failed with HTTP 503.");
    const error = await sendWithEndpointRetry({
      signal: new AbortController().signal,
      onEvent: () => undefined,
      attempt: async () => {
        throw spent;
      },
      options: { ...instant, maxAttempts: 3 },
    }).catch((caught: unknown) => caught);

    expect(error).toBe(spent);
    expect(isEndpointRetriesExhausted(error)).toBe(true);
    expect(isEndpointRetriesExhausted(failure("unavailable"))).toBe(false);
  });

  it("does not mark a failure that was never retried", async () => {
    const refused = failure("unauthenticated");
    const error = await sendWithEndpointRetry({
      signal: new AbortController().signal,
      onEvent: () => undefined,
      attempt: async () => {
        throw refused;
      },
      options: instant,
    }).catch((caught: unknown) => caught);

    expect(isEndpointRetriesExhausted(error)).toBe(false);
  });

  it("adds what failed attempts billed to the usage it reports", async () => {
    const reported: Array<{ inputTokens: number; outputTokens: number }> = [];
    let calls = 0;
    const response = await sendWithEndpointRetry({
      signal: new AbortController().signal,
      onEvent: (event) => {
        if (event.kind === "usage") reported.push(event);
      },
      attempt: async (stream) => {
        calls += 1;
        stream.onEvent({ kind: "usage", inputTokens: calls * 10, outputTokens: calls });
        if (calls < 3) throw failure("unavailable");
        return { ...answer, usage: { inputTokens: 30, outputTokens: 3 } };
      },
      options: instant,
    });

    expect(reported).toEqual([
      { kind: "usage", inputTokens: 10, outputTokens: 1 },
      { kind: "usage", inputTokens: 30, outputTokens: 3 },
      { kind: "usage", inputTokens: 60, outputTokens: 6 },
    ]);
    expect(response.usage).toEqual({ inputTokens: 60, outputTokens: 6 });
  });

  it("adds every usage bucket a failed attempt billed and leaves unreported ones absent", async () => {
    let calls = 0;
    const response = await sendWithEndpointRetry({
      signal: new AbortController().signal,
      onEvent: () => undefined,
      attempt: async (stream) => {
        calls += 1;
        if (calls === 1) {
          stream.onEvent({
            kind: "usage",
            inputTokens: 100,
            outputTokens: 10,
            cacheReadInputTokens: 60,
            reasoningTokens: 4,
          });
          throw failure("unavailable");
        }
        return {
          ...answer,
          usage: { inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 50 },
        };
      },
      options: instant,
    });

    expect(response.usage).toEqual({
      inputTokens: 300,
      outputTokens: 30,
      cacheReadInputTokens: 110,
      reasoningTokens: 4,
    });
  });

  it("ends a backoff wait the moment the request is cancelled", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const started = Date.now();
    const outcome = sendWithEndpointRetry({
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event.kind);
        if (event.kind === "retrying") controller.abort();
      },
      attempt: async () => {
        throw failure("unavailable");
      },
      options: { baseDelayMs: 60_000, maxDelayMs: 60_000, random: () => 0.5 },
    });

    await expect(outcome).rejects.toMatchObject({ category: "interrupted" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(events).toEqual(["retrying"]);
  });
});
