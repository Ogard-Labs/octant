import type { OpenAiCompatibleProviderConfiguration, ProviderFailure } from "@octant/contracts";
import { Effect, Either } from "effect";
import { describe, expect, it, vi } from "vitest";
import { type CompatibleFetch, makeOpenAiCompatibleEndpoint } from "./openAiCompatibleEndpoint";
import { type ChatCompletionsTurnInput, sendChatCompletionsTurn } from "./openAiChatCompletions";

const encoder = new TextEncoder();
const configuration: OpenAiCompatibleProviderConfiguration = {
  kind: "openai-compatible-http",
  baseUrl: "https://provider.example/v1",
  authentication: "none",
  protocol: "chat-completions",
  manualModelIds: ["manual-model" as never],
};

function stream(...values: readonly (Record<string, unknown> | "[DONE]")[]): Response {
  const body = values
    .map((value) => `data: ${value === "[DONE]" ? value : JSON.stringify(value)}\n\n`)
    .join("");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage: Record<string, unknown> | null = null,
) {
  return {
    id: "chatcmpl_private",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    usage,
  };
}

function usage(inputTokens = 3, outputTokens = 2) {
  return {
    id: "chatcmpl_private",
    object: "chat.completion.chunk",
    choices: [],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

function input(
  fetch: ReturnType<typeof vi.fn>,
  overrides: Partial<ChatCompletionsTurnInput> = {},
): ChatCompletionsTurnInput {
  return {
    endpoint: makeOpenAiCompatibleEndpoint({
      instanceId: "019f64cf-7241-7000-8000-000000000001",
      configuration,
      fetch: fetch as CompatibleFetch,
      limits: { responseBodyBytes: 16_384 },
    }),
    modelId: "manual-model",
    history: [
      { role: "user", text: "first" },
      { role: "assistant", text: "answer" },
    ],
    prompt: "next",
    ...overrides,
  };
}

async function failureOf(effect: Effect.Effect<unknown, ProviderFailure>) {
  const either = await Effect.runPromise(Effect.either(effect));
  expect(Either.isLeft(either)).toBe(true);
  if (Either.isRight(either)) throw new Error("Expected a typed provider failure.");
  return either.left;
}

describe("sendChatCompletionsTurn", () => {
  it("sends only the complete local message history and compatible streaming fields", async () => {
    const fetch = vi.fn(async () =>
      stream(chunk({ role: "assistant" }), chunk({}, "stop"), "[DONE]"),
    );

    await Effect.runPromise(sendChatCompletionsTurn(input(fetch)));

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://provider.example/v1/chat/completions");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "manual-model",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "next" },
      ],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("normalizes text, finish, usage-before-DONE, and Octant sequence values", async () => {
    const observed = vi.fn();
    const fetch = vi.fn(async () =>
      stream(
        chunk({ role: "assistant", content: "Hello " }),
        chunk({ content: "world" }),
        chunk({}, "stop"),
        usage(),
        "[DONE]",
      ),
    );

    const result = await Effect.runPromise(
      sendChatCompletionsTurn(input(fetch, { sequenceStart: 7, onEvent: observed })),
    );

    expect(result).toMatchObject({
      protocol: "chat-completions",
      accepted: true,
      outputStarted: true,
      terminal: "completed",
      streaming: "supported",
      text: "Hello world",
      reasoning: "",
      usage: { inputTokens: 3, outputTokens: 2 },
      verifiedManualModelId: "manual-model",
    });
    expect(result.events).toEqual([
      { kind: "text-delta", sequence: 7, text: "Hello " },
      { kind: "text-delta", sequence: 8, text: "world" },
      { kind: "usage", sequence: 9, inputTokens: 3, outputTokens: 2 },
    ]);
    expect(observed.mock.calls.map(([event]) => event)).toEqual(result.events);
  });

  it("fails closed on standard refusal deltas without exposing refusal text", async () => {
    const fetch = vi.fn(async () =>
      stream(chunk({ role: "assistant", refusal: "private refusal" })),
    );

    const failure = await failureOf(sendChatCompletionsTurn(input(fetch)));

    expect(failure).toEqual({
      category: "provider-failed",
      message: "The provider refused the request.",
    });
    expect(JSON.stringify(failure)).not.toContain("private refusal");
  });

  it.each([
    ["length", "provider-failed"],
    ["content_filter", "provider-failed"],
    ["tool_calls", "protocol"],
    ["function_call", "unsupported"],
  ])("maps finish reason %s to a typed failure", async (finishReason, category) => {
    const fetch = vi.fn(async () => stream(chunk({}, finishReason), "[DONE]"));

    expect(await failureOf(sendChatCompletionsTurn(input(fetch)))).toMatchObject({ category });
  });

  it("rejects nonstandard reasoning and extension fields", async () => {
    const fetch = vi.fn(async () =>
      stream(chunk({ role: "assistant", reasoning_content: "secret" })),
    );

    const failure = await failureOf(sendChatCompletionsTurn(input(fetch)));

    expect(failure.category).toBe("protocol");
    expect(JSON.stringify(failure)).not.toContain("secret");
  });

  it("rejects nonstandard SSE event names", async () => {
    const fetch = vi.fn(
      async () => new Response(`event: provider.reasoning\ndata: ${JSON.stringify(chunk({}))}\n\n`),
    );

    expect(await failureOf(sendChatCompletionsTurn(input(fetch)))).toMatchObject({
      category: "protocol",
    });
  });

  it("rejects a completion identity change within one stream", async () => {
    const changed = { ...chunk({ content: "second" }), id: "chatcmpl_other" };
    const fetch = vi.fn(async () =>
      stream(chunk({ role: "assistant", content: "first" }), changed, chunk({}, "stop"), "[DONE]"),
    );

    expect(await failureOf(sendChatCompletionsTurn(input(fetch)))).toMatchObject({
      category: "protocol",
    });
  });

  it("rejects nested streaming logprobs instead of ignoring them", async () => {
    const withLogprobs = {
      ...chunk({ role: "assistant", content: "private token" }),
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "private token" },
          finish_reason: null,
          logprobs: { content: [{ token: "private token", logprob: -0.1 }] },
        },
      ],
    };
    const fetch = vi.fn(async () => stream(withLogprobs, chunk({}, "stop"), "[DONE]"));

    const failure = await failureOf(sendChatCompletionsTurn(input(fetch)));

    expect(failure).toMatchObject({ category: "protocol" });
    expect(JSON.stringify(failure)).not.toContain("private token");
  });

  it("cancels an in-flight stream as interruption", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              controller.abort();
            },
          }),
        ),
    );

    expect(
      await failureOf(sendChatCompletionsTurn(input(fetch, { signal: controller.signal }))),
    ).toEqual({ category: "interrupted", message: "The provider request was cancelled." });
  });

  it("retries once without streaming only for an exact stream unsupported rejection", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              message: "unsupported",
              type: "invalid_request_error",
              param: "stream",
              code: "unsupported_parameter",
            },
          },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: "chatcmpl_private",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Complete" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        }),
      );

    const result = await Effect.runPromise(sendChatCompletionsTurn(input(fetch)));

    expect(fetch).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String((fetch.mock.calls[1]![1] as RequestInit).body));
    expect(secondBody).toEqual({
      model: "manual-model",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "next" },
      ],
      stream: false,
    });
    expect(result).toMatchObject({
      text: "Complete",
      streaming: "unsupported",
      events: [
        { kind: "text-delta", sequence: 1, text: "Complete" },
        { kind: "usage", sequence: 2, inputTokens: 4, outputTokens: 1 },
      ],
    });
  });

  it("accepts standard null refusal and logprobs in a non-streaming completion", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              message: "unsupported",
              type: "invalid_request_error",
              param: "stream",
              code: "unsupported_parameter",
            },
          },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: "chatcmpl_private",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Complete", refusal: null },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        }),
      );

    await expect(Effect.runPromise(sendChatCompletionsTurn(input(fetch)))).resolves.toMatchObject({
      text: "Complete",
      streaming: "unsupported",
    });
  });

  it("emits no non-streaming text when later usage validation fails", async () => {
    const observed = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              message: "unsupported",
              type: "invalid_request_error",
              param: "stream",
              code: "unsupported_parameter",
            },
          },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: "chatcmpl_private",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "must stay atomic" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 999 },
        }),
      );

    await failureOf(sendChatCompletionsTurn(input(fetch, { onEvent: observed })));

    expect(observed).not.toHaveBeenCalled();
  });

  it("emits no non-streaming text when later event sequencing overflows", async () => {
    const observed = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              message: "unsupported",
              type: "invalid_request_error",
              param: "stream",
              code: "unsupported_parameter",
            },
          },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: "chatcmpl_private",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "must stay atomic" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        }),
      );

    await failureOf(
      sendChatCompletionsTurn(
        input(fetch, { sequenceStart: Number.MAX_SAFE_INTEGER, onEvent: observed }),
      ),
    );

    expect(observed).not.toHaveBeenCalled();
  });

  it.each([
    { code: "unsupported_parameter", param: "stream", extra: true },
    { code: "unsupported_parameter", param: "other" },
    { code: "invalid_parameter", param: "stream" },
  ])("does not retry a non-exact stream rejection %#", async (error) => {
    const fetch = vi.fn(async () =>
      Response.json(
        { error: { message: "rejected", type: "invalid_request_error", ...error } },
        { status: 400 },
      ),
    );

    await failureOf(sendChatCompletionsTurn(input(fetch)));

    expect(fetch).toHaveBeenCalledOnce();
  });

  it("never retries after output has started", async () => {
    const fetch = vi.fn(async () =>
      stream(chunk({ role: "assistant", content: "partial" }), chunk({}, "length")),
    );

    await failureOf(sendChatCompletionsTurn(input(fetch)));

    expect(fetch).toHaveBeenCalledOnce();
  });
});
