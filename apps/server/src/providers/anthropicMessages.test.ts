import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { decodeProviderFailure } from "@octant/contracts";
import {
  makeAnthropicCompatibleEndpoint,
  type AnthropicCompatibleFetch,
} from "./anthropicCompatibleEndpoint";
import { sendAnthropicMessagesTurn, buildAnthropicMessagesBody } from "./anthropicMessages";

const instanceId = "anthropic-messages-test" as never;

function makeEndpoint(fetch: AnthropicCompatibleFetch) {
  return makeAnthropicCompatibleEndpoint({
    instanceId,
    configuration: {
      kind: "anthropic-compatible-http",
      baseUrl: "https://fixture.example/v1",
      authentication: "api-key",
      protocol: "messages",
      protocolVersion: "2023-06-01",
      manualModelIds: ["fixture-model" as never],
    },
    credentialResolver: { has: async () => true, resolve: async () => "fixture-secret" },
    fetch,
  });
}

function captureRequest(fetch: AnthropicCompatibleFetch) {
  let captured: { url: string; body: unknown } | undefined;
  const wrapped: AnthropicCompatibleFetch = async (url, init) => {
    const body = init?.body;
    captured = { url: String(url), body: typeof body === "string" ? JSON.parse(body) : body };
    return fetch(url, init);
  };
  return { fetch: wrapped, read: () => captured };
}

function sse(events: ReadonlyArray<Record<string, unknown>>): Response {
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function fixture(response: Response): AnthropicCompatibleFetch {
  return async () => response;
}

describe("sendAnthropicMessagesTurn", () => {
  it("keeps screenshots inside their tool result when replaying observations", () => {
    const body = buildAnthropicMessagesBody({
      modelId: "fixture-model",
      prompt: "",
      history: [
        {
          role: "assistant",
          text: "",
          toolCalls: [{ toolCallId: "picture", toolName: "octant_computer", argumentsJson: "{}" }],
        },
        {
          role: "user",
          text: "",
          toolResults: [
            {
              toolCallId: "picture",
              resultJson: "{}",
              isError: false,
              images: [{ mimeType: "image/png", data: "AAAA" }],
            },
          ],
        },
      ],
    });
    expect(body.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "picture", name: "octant_computer", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "picture",
            content: [
              { type: "text", text: "{}" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            ],
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });
  it("sends max_tokens in the Messages request body", async () => {
    const { fetch, read } = captureRequest(
      fixture(
        sse([
          {
            type: "message_start",
            message: {
              id: "msg",
              type: "message",
              role: "assistant",
              content: [],
              model: "fixture-model",
              stop_reason: null,
              usage: { input_tokens: 2, output_tokens: 0 },
            },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 3 },
          },
          { type: "message_stop" },
        ]),
      ),
    );

    await Effect.runPromise(
      sendAnthropicMessagesTurn({
        endpoint: makeEndpoint(fetch),
        modelId: "fixture-model",
        history: [],
        prompt: "hi",
      }),
    );

    const body = read()?.body as Record<string, unknown>;
    expect(body.max_tokens).toBeTypeOf("number");
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it.each([
    ["max_tokens", "max-tokens"],
    ["refusal", "content-filter"],
  ] as const)("records a %s stop as %s and keeps the partial reply", async (raw, expected) => {
    const fetch = fixture(
      sse([
        {
          type: "message_start",
          message: {
            id: "msg",
            type: "message",
            role: "assistant",
            content: [],
            model: "fixture-model",
            stop_reason: null,
            usage: { input_tokens: 2, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: raw },
          usage: { output_tokens: 4 },
        },
        { type: "message_stop" },
      ]),
    );

    const result = await Effect.runPromise(
      sendAnthropicMessagesTurn({
        endpoint: makeEndpoint(fetch),
        modelId: "fixture-model",
        history: [],
        prompt: "hi",
      }),
    );

    expect(result.text).toBe("partial");
    expect(result.outputStopReason).toBe(expected);
  });

  it("accepts output-only usage on message_delta", async () => {
    const { fetch } = captureRequest(
      fixture(
        sse([
          {
            type: "message_start",
            message: {
              id: "msg",
              type: "message",
              role: "assistant",
              content: [],
              model: "fixture-model",
              stop_reason: null,
              usage: { input_tokens: 7, output_tokens: 0 },
            },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 5 },
          },
          { type: "message_stop" },
        ]),
      ),
    );

    const result = await Effect.runPromise(
      sendAnthropicMessagesTurn({
        endpoint: makeEndpoint(fetch),
        modelId: "fixture-model",
        history: [],
        prompt: "hi",
      }),
    );

    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 5 });
  });

  it("reads thinking deltas from delta.thinking", async () => {
    const { fetch } = captureRequest(
      fixture(
        sse([
          {
            type: "message_start",
            message: {
              id: "msg",
              type: "message",
              role: "assistant",
              content: [],
              model: "fixture-model",
              stop_reason: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "reasoning fragment" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ]),
      ),
    );

    const result = await Effect.runPromise(
      sendAnthropicMessagesTurn({
        endpoint: makeEndpoint(fetch),
        modelId: "fixture-model",
        history: [],
        prompt: "hi",
      }),
    );

    expect(result.reasoning).toBe("reasoning fragment");
  });

  it("treats refusal stop reason as a completed turn", async () => {
    const { fetch } = captureRequest(
      fixture(
        sse([
          {
            type: "message_start",
            message: {
              id: "msg",
              type: "message",
              role: "assistant",
              content: [],
              model: "fixture-model",
              stop_reason: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I can't" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ]),
      ),
    );

    const result = await Effect.runPromise(
      sendAnthropicMessagesTurn({
        endpoint: makeEndpoint(fetch),
        modelId: "fixture-model",
        history: [],
        prompt: "hi",
      }),
    );

    expect(result.terminal).toBe("completed");
    expect(result.text).toBe("I can't");
  });

  it("treats model_context_window_exceeded stop reason as a completed turn", async () => {
    const { fetch } = captureRequest(
      fixture(
        sse([
          {
            type: "message_start",
            message: {
              id: "msg",
              type: "message",
              role: "assistant",
              content: [],
              model: "fixture-model",
              stop_reason: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "model_context_window_exceeded" },
            usage: { output_tokens: 0 },
          },
          { type: "message_stop" },
        ]),
      ),
    );

    const result = await Effect.runPromise(
      sendAnthropicMessagesTurn({
        endpoint: makeEndpoint(fetch),
        modelId: "fixture-model",
        history: [],
        prompt: "hi",
      }),
    );

    expect(result.terminal).toBe("completed");
  });

  it("ignores fallback content block markers without deltas", async () => {
    const { fetch } = captureRequest(
      fixture(
        sse([
          {
            type: "message_start",
            message: {
              id: "msg",
              type: "message",
              role: "assistant",
              content: [],
              model: "fixture-model",
              stop_reason: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "fallback" } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "after fallback" },
          },
          { type: "content_block_stop", index: 1 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 2 },
          },
          { type: "message_stop" },
        ]),
      ),
    );

    const result = await Effect.runPromise(
      sendAnthropicMessagesTurn({
        endpoint: makeEndpoint(fetch),
        modelId: "fixture-model",
        history: [],
        prompt: "hi",
      }),
    );

    expect(result.text).toBe("after fallback");
    expect(result.terminal).toBe("completed");
  });

  it("maps overloaded_error SSE events to an unavailable failure", async () => {
    const { fetch } = captureRequest(
      fixture(
        sse([
          {
            type: "message_start",
            message: {
              id: "msg",
              type: "message",
              role: "assistant",
              content: [],
              model: "fixture-model",
              stop_reason: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
          },
        ]),
      ),
    );

    const error = await Effect.runPromise(
      Effect.catchAll(
        sendAnthropicMessagesTurn({
          endpoint: makeEndpoint(fetch),
          modelId: "fixture-model",
          history: [],
          prompt: "hi",
        }),
        (failure) => Effect.succeed(failure),
      ),
    );

    expect(decodeProviderFailure(error)).toMatchObject({ category: "unavailable" });
  });

  it("maps rate_limit_error SSE events to a rate-limited failure", async () => {
    const { fetch } = captureRequest(
      fixture(
        sse([
          {
            type: "message_start",
            message: {
              id: "msg",
              type: "message",
              role: "assistant",
              content: [],
              model: "fixture-model",
              stop_reason: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: "error",
            error: { type: "rate_limit_error", message: "Rate limit" },
          },
        ]),
      ),
    );

    const error = await Effect.runPromise(
      Effect.catchAll(
        sendAnthropicMessagesTurn({
          endpoint: makeEndpoint(fetch),
          modelId: "fixture-model",
          history: [],
          prompt: "hi",
        }),
        (failure) => Effect.succeed(failure),
      ),
    );

    expect(decodeProviderFailure(error)).toMatchObject({ category: "rate-limited" });
  });

  function usageStream(
    start: Record<string, unknown>,
    delta: Record<string, unknown>,
  ): AnthropicCompatibleFetch {
    return fixture(
      sse([
        {
          type: "message_start",
          message: {
            id: "msg",
            type: "message",
            role: "assistant",
            content: [],
            model: "fixture-model",
            stop_reason: null,
            usage: start,
          },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: delta },
        { type: "message_stop" },
      ]),
    );
  }

  function turn(fetch: AnthropicCompatibleFetch) {
    return sendAnthropicMessagesTurn({
      endpoint: makeEndpoint(fetch),
      modelId: "fixture-model",
      history: [],
      prompt: "hi",
    });
  }

  function usageOf(fetch: AnthropicCompatibleFetch) {
    return Effect.runPromise(turn(fetch));
  }

  it("counts cache reads and writes as input and reports them as their own buckets", async () => {
    const result = await usageOf(
      usageStream(
        {
          input_tokens: 12,
          output_tokens: 1,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 150,
          cache_creation: { ephemeral_5m_input_tokens: 150, ephemeral_1h_input_tokens: 0 },
          service_tier: "standard",
        },
        { output_tokens: 20 },
      ),
    );

    const expected = {
      inputTokens: 962,
      outputTokens: 20,
      cacheReadInputTokens: 800,
      cacheWriteInputTokens: 150,
    };
    expect(result.usage).toEqual(expected);
    expect(result.events.at(-1)).toMatchObject({ kind: "usage", ...expected });
  });

  it("keeps the opening cache figures when the closing usage reports only output", async () => {
    const result = await usageOf(
      usageStream(
        { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 95 },
        { output_tokens: 7 },
      ),
    );

    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 7, cacheReadInputTokens: 95 });
  });

  it("takes the closing cumulative cache figures when the endpoint restates them", async () => {
    const result = await usageOf(
      usageStream(
        { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0 },
        {
          input_tokens: 6,
          output_tokens: 7,
          cache_read_input_tokens: 90,
          cache_creation_input_tokens: 4,
        },
      ),
    );

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 7,
      cacheReadInputTokens: 90,
      cacheWriteInputTokens: 4,
    });
  });

  it("reports zero cache reads for an uncached response and nothing when the endpoint reports none", async () => {
    const uncached = await usageOf(
      usageStream(
        {
          input_tokens: 9,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        { output_tokens: 1 },
      ),
    );
    const silent = await usageOf(
      usageStream({ input_tokens: 9, output_tokens: 0 }, { output_tokens: 1 }),
    );

    expect(uncached.usage).toEqual({
      inputTokens: 9,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
    expect(silent.usage).toEqual({ inputTokens: 9, outputTokens: 1 });
  });

  it.each([
    ["a string cache read", { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: "8" }],
    [
      "a negative cache write",
      { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: -1 },
    ],
  ])("still rejects %s in the opening usage", async (_name, start) => {
    const failure = await Effect.runPromise(
      Effect.flip(turn(usageStream(start, { output_tokens: 1 }))),
    );

    expect(failure).toMatchObject({ category: "protocol" });
  });
});

/**
 * The prompt cache only pays off if the bytes before a breakpoint never
 * change. These check the layout the driver sends: a fixed breakpoint on the
 * system block, one breakpoint that moves to the newest stable message, and
 * nothing marked before it.
 */
describe("buildAnthropicMessagesBody cache layout", () => {
  it("marks the system block and only the newest stable history message", () => {
    const body = buildAnthropicMessagesBody({
      modelId: "fixture-model",
      prompt: "",
      system: "stable instructions",
      history: [
        { role: "user", text: "first question" },
        { role: "assistant", text: "first answer" },
        { role: "user", text: "second question" },
      ],
    });

    expect(body.system).toEqual([
      { type: "text", text: "stable instructions", cache_control: { type: "ephemeral" } },
    ]);
    expect(body.messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      {
        role: "user",
        content: [{ type: "text", text: "second question", cache_control: { type: "ephemeral" } }],
      },
    ]);
    expect(countCacheBreakpoints(body)).toBe(2);
    expect(countCacheBreakpoints(body)).toBeLessThanOrEqual(4);
  });

  it("moves the breakpoint to the newest message as the history grows", () => {
    const earlier = buildAnthropicMessagesBody({
      modelId: "fixture-model",
      prompt: "",
      history: [
        { role: "user", text: "first question" },
        { role: "assistant", text: "first answer" },
      ],
    });
    const grown = buildAnthropicMessagesBody({
      modelId: "fixture-model",
      prompt: "",
      history: [
        { role: "user", text: "first question" },
        { role: "assistant", text: "first answer" },
        { role: "user", text: "second question" },
      ],
    });

    // The newest message carries the breakpoint each time, never an earlier one.
    expect(markedMessageIndexes(earlier)).toEqual([1]);
    expect(markedMessageIndexes(grown)).toEqual([2]);
  });

  it("leaves the new prompt outside the cached prefix", () => {
    const body = buildAnthropicMessagesBody({
      modelId: "fixture-model",
      prompt: "the new question",
      system: "stable instructions",
      history: [{ role: "user", text: "first question" }],
    });

    expect(markedMessageIndexes(body)).toEqual([0]);
    expect(lastMessage(body)).toEqual({ role: "user", content: "the new question" });
    expect(countCacheBreakpoints(body)).toBe(2);
  });
});

function countCacheBreakpoints(value: unknown): number {
  return (JSON.stringify(value).match(/"cache_control"/g) ?? []).length;
}

/** Which history messages carry a breakpoint, in order. */
function markedMessageIndexes(body: Record<string, unknown>): number[] {
  const messages: unknown[] = Array.isArray(body.messages) ? body.messages : [];
  return messages.flatMap((message, index) =>
    JSON.stringify(message).includes('"cache_control"') ? [index] : [],
  );
}

function lastMessage(body: Record<string, unknown>): unknown {
  const messages: unknown[] = Array.isArray(body.messages) ? body.messages : [];
  return messages.at(-1);
}
