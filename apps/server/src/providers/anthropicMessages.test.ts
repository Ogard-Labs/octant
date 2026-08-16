import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { decodeProviderFailure } from "@octant/contracts";
import {
  makeAnthropicCompatibleEndpoint,
  type AnthropicCompatibleFetch,
} from "./anthropicCompatibleEndpoint";
import { sendAnthropicMessagesTurn } from "./anthropicMessages";

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
});
