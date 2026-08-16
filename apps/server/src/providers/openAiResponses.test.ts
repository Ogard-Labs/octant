import type { OpenAiCompatibleProviderConfiguration, ProviderFailure } from "@octant/contracts";
import { Effect, Either } from "effect";
import { describe, expect, it, vi } from "vitest";
import { type CompatibleFetch, makeOpenAiCompatibleEndpoint } from "./openAiCompatibleEndpoint";
import { type ResponsesTurnInput, sendResponsesTurn } from "./openAiResponses";

const encoder = new TextEncoder();
const configuration: OpenAiCompatibleProviderConfiguration = {
  kind: "openai-compatible-http",
  baseUrl: "https://provider.example/v1",
  authentication: "none",
  protocol: "responses",
  manualModelIds: ["manual-model" as never],
};

function sse(...events: readonly Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
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

function responseState(
  status: "in_progress" | "completed" | "failed" | "incomplete",
  usage: Record<string, unknown> | null = null,
) {
  return { id: "resp_private", object: "response", status, usage };
}

function created(sequenceNumber: number) {
  return {
    type: "response.created",
    sequence_number: sequenceNumber,
    response: responseState("in_progress"),
  };
}

function completed(sequenceNumber: number, usage: Record<string, unknown> | null = null) {
  return {
    type: "response.completed",
    sequence_number: sequenceNumber,
    response: responseState("completed", usage),
  };
}

function input(
  fetch: ReturnType<typeof vi.fn>,
  overrides: Partial<ResponsesTurnInput> = {},
): ResponsesTurnInput {
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

describe("sendResponsesTurn", () => {
  it("disables provider storage and sends only normalized complete local history", async () => {
    const fetch = vi.fn(async () =>
      sse(created(10), completed(20, { input_tokens: 3, output_tokens: 2, total_tokens: 5 })),
    );

    await Effect.runPromise(sendResponsesTurn(input(fetch)));

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://provider.example/v1/responses");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "manual-model",
      input: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "next" },
      ],
      stream: true,
      store: false,
    });
    expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual([
      "input",
      "model",
      "store",
      "stream",
    ]);
    expect(JSON.parse(String(init.body))).not.toHaveProperty("previous_response_id");
  });

  it("normalizes text, reasoning, usage, and completion with independent sequences", async () => {
    const observed = vi.fn();
    const fetch = vi.fn(async () =>
      sse(
        created(4),
        {
          type: "response.output_item.added",
          sequence_number: 9,
          output_index: 0,
          item: {
            id: "msg_private",
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        },
        {
          type: "response.output_text.delta",
          sequence_number: 12,
          item_id: "msg_private",
          output_index: 0,
          content_index: 0,
          delta: "Hello ",
          logprobs: [],
        },
        {
          type: "response.output_item.added",
          sequence_number: 19,
          output_index: 1,
          item: {
            id: "reason_private",
            type: "reasoning",
            status: "in_progress",
            summary: [],
            content: [],
          },
        },
        {
          type: "response.reasoning_text.delta",
          sequence_number: 20,
          item_id: "reason_private",
          output_index: 1,
          content_index: 0,
          delta: "Think",
        },
        {
          type: "response.output_text.delta",
          sequence_number: 21,
          item_id: "msg_private",
          output_index: 0,
          content_index: 0,
          delta: "world",
          logprobs: [],
        },
        {
          type: "response.output_text.done",
          sequence_number: 22,
          item_id: "msg_private",
          output_index: 0,
          content_index: 0,
          text: "Hello world",
          logprobs: [],
        },
        {
          type: "response.reasoning_text.done",
          sequence_number: 23,
          item_id: "reason_private",
          output_index: 1,
          content_index: 0,
          text: "Think",
        },
        {
          type: "response.output_item.done",
          sequence_number: 24,
          output_index: 0,
          item: {
            id: "msg_private",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Hello world", annotations: [] }],
          },
        },
        {
          type: "response.output_item.done",
          sequence_number: 25,
          output_index: 1,
          item: {
            id: "reason_private",
            type: "reasoning",
            status: "completed",
            summary: [],
            content: [{ type: "reasoning_text", text: "Think" }],
          },
        },
        {
          type: "response.completed",
          sequence_number: 30,
          response: responseState("completed", {
            input_tokens: 7,
            output_tokens: 5,
            total_tokens: 12,
          }),
        },
      ),
    );

    const result = await Effect.runPromise(
      sendResponsesTurn(input(fetch, { sequenceStart: 41, onEvent: observed })),
    );

    expect(result).toEqual({
      protocol: "responses",
      accepted: true,
      outputStarted: true,
      terminal: "completed",
      text: "Hello world",
      reasoning: "Think",
      usage: { inputTokens: 7, outputTokens: 5 },
      events: [
        { kind: "text-delta", sequence: 41, text: "Hello " },
        { kind: "reasoning-delta", sequence: 42, text: "Think" },
        { kind: "text-delta", sequence: 43, text: "world" },
        { kind: "usage", sequence: 44, inputTokens: 7, outputTokens: 5 },
      ],
      toolCalls: [],
      verifiedManualModelId: "manual-model",
    });
    expect(observed.mock.calls.map(([event]) => event)).toEqual(result.events);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("rejects duplicate or out-of-order provider sequences", async () => {
    const fetch = vi.fn(async () =>
      sse(created(2), {
        type: "response.in_progress",
        sequence_number: 2,
        response: responseState("in_progress"),
      }),
    );

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream sequence was invalid.",
    });
  });

  it("rejects invalid event envelopes and unknown event types without leaking payloads", async () => {
    const fetch = vi.fn(async () =>
      sse({
        type: "response.future_private_event",
        sequence_number: 1,
        secret: "provider-private-payload",
      }),
    );

    const failure = await failureOf(sendResponsesTurn(input(fetch)));
    expect(failure).toEqual({
      category: "protocol",
      message: "The provider stream contained an unsupported event.",
    });
    expect(JSON.stringify(failure)).not.toContain("provider-private-payload");
  });

  it.each([
    [
      "provider-native tool output",
      { type: "response.file_search_call.completed", sequence_number: 2, query: "private" },
      { category: "unsupported", message: "The provider attempted an unsupported tool call." },
    ],
    [
      "refusal",
      { type: "response.refusal.delta", sequence_number: 2, delta: "private refusal" },
      { category: "provider-failed", message: "The provider refused the request." },
    ],
    [
      "failed terminal response",
      {
        type: "response.failed",
        sequence_number: 2,
        response: {
          ...responseState("failed"),
          error: { code: "private_code", message: "private failure" },
        },
      },
      { category: "provider-failed", message: "The provider failed to complete the response." },
    ],
    [
      "incomplete terminal response",
      {
        type: "response.incomplete",
        sequence_number: 2,
        response: {
          ...responseState("incomplete"),
          incomplete_details: { reason: "private reason" },
        },
      },
      { category: "provider-failed", message: "The provider returned an incomplete response." },
    ],
  ])("maps %s to a sanitized failure", async (_name, event, expected) => {
    const fetch = vi.fn(async () => sse(created(1), event));

    const failure = await failureOf(sendResponsesTurn(input(fetch)));
    expect(failure).toEqual(expected);
    expect(JSON.stringify(failure)).not.toContain("private");
  });

  it("treats cancellation as interruption and does not verify the manual model", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              streamController.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "response.created", sequence_number: 1, response: {} })}\n\n`,
                ),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    const turn = failureOf(sendResponsesTurn(input(fetch, { signal: controller.signal })));

    controller.abort();

    await expect(turn).resolves.toMatchObject({ category: "interrupted" });
    expect(cancelled).toBe(true);
  });

  it("requires a successful terminal response and never treats [DONE] as completion", async () => {
    const fetch = vi.fn(
      async () => new Response(`data: ${JSON.stringify(created(1))}\n\ndata: [DONE]\n\n`),
    );

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream ended without a terminal response.",
    });
  });

  it("does not let [DONE] hide frames after a terminal response", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          [
            `data: ${JSON.stringify(created(1))}`,
            `data: ${JSON.stringify(completed(2))}`,
            "data: [DONE]",
            `data: ${JSON.stringify({ type: "response.future_event", sequence_number: 3 })}`,
            "",
          ].join("\n\n"),
        ),
    );

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream continued after its terminal response.",
    });
  });

  it.each([400, 422])(
    "preserves generic status %s failures without guessing the parameter",
    async (status) => {
      const fetch = vi.fn(async () =>
        Response.json(
          {
            error: {
              message: "private model failure",
              type: "invalid_request_error",
              param: "model",
              code: "invalid_parameter",
            },
          },
          { status },
        ),
      );

      const failure = await failureOf(sendResponsesTurn(input(fetch)));

      expect(failure).toEqual({
        category: "provider-failed",
        message: `The provider request failed with HTTP ${status}.`,
      });
      expect(JSON.stringify(failure)).not.toContain("private model failure");
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([400, 422])(
    "does not retry when a strict status %s error identifies the store parameter",
    async (status) => {
      const fetch = vi.fn(async () =>
        Response.json(
          {
            error: {
              message: "private store rejection",
              type: "invalid_request_error",
              param: "store",
              code: "unsupported_parameter",
            },
          },
          { status },
        ),
      );

      const failure = await failureOf(sendResponsesTurn(input(fetch)));

      expect(failure).toEqual({
        category: "unsupported",
        message: "The provider does not support requests with storage disabled.",
      });
      expect(JSON.stringify(failure)).not.toContain("private store rejection");
      expect(fetch).toHaveBeenCalledOnce();
      const [, request] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(request.body))).toMatchObject({
        store: false,
      });
    },
  );

  it.each([404, 405, 501])(
    "reports pre-acceptance route status %s as sanitized attempt metadata",
    async (status) => {
      const observed = vi.fn();
      const fetch = vi.fn(async () => new Response(null, { status }));

      await failureOf(sendResponsesTurn(input(fetch, { onAttemptFailure: observed })));

      expect(observed).toHaveBeenCalledWith({
        accepted: false,
        outputStarted: false,
        httpStatus: status,
        failure: {
          category: "unsupported",
          message: "The provider does not support this endpoint.",
        },
      });
    },
  );

  it.each([400, 422])(
    "keeps store:false rejection status %s distinct from route rejection",
    async (status) => {
      const observed = vi.fn();
      const fetch = vi.fn(async () =>
        Response.json(
          {
            error: {
              message: "private store rejection",
              type: "invalid_request_error",
              param: "store",
              code: "unsupported_parameter",
            },
          },
          { status },
        ),
      );

      await failureOf(sendResponsesTurn(input(fetch, { onAttemptFailure: observed })));

      expect(observed).toHaveBeenCalledWith({
        accepted: false,
        outputStarted: false,
        httpStatus: status,
        failure: {
          category: "unsupported",
          message: "The provider does not support requests with storage disabled.",
        },
      });
      expect(JSON.stringify(observed.mock.calls)).not.toContain("private store rejection");
    },
  );

  it("reports accepted partial output when a Responses stream fails", async () => {
    const observed = vi.fn();
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        {
          type: "response.output_item.added",
          sequence_number: 2,
          output_index: 0,
          item: {
            id: "msg_private",
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        },
        {
          type: "response.output_text.delta",
          sequence_number: 3,
          item_id: "msg_private",
          output_index: 0,
          content_index: 0,
          delta: "partial",
          logprobs: [],
        },
      ),
    );

    await failureOf(sendResponsesTurn(input(fetch, { onAttemptFailure: observed })));

    expect(observed).toHaveBeenCalledWith({
      accepted: true,
      outputStarted: true,
      failure: {
        category: "protocol",
        message: "The provider stream ended without a terminal response.",
      },
    });
  });

  it("does not retain rejection status when the same Effect is run again", async () => {
    const observed = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockRejectedValueOnce(new Error("private network failure"));
    const effect = sendResponsesTurn(input(fetch, { onAttemptFailure: observed }));

    await failureOf(effect);
    await failureOf(effect);

    expect(observed.mock.calls[0]?.[0]).toMatchObject({ httpStatus: 404 });
    expect(observed.mock.calls[1]?.[0]).toEqual({
      accepted: false,
      outputStarted: false,
      failure: {
        category: "unavailable",
        message: "The provider endpoint could not be reached.",
      },
    });
    expect(JSON.stringify(observed.mock.calls)).not.toContain("private network failure");
  });

  it("rejects a store-looking error with extra raw fields as a generic failure", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          error: {
            message: "private store rejection",
            type: "invalid_request_error",
            param: "store",
            code: "unsupported_parameter",
            private_detail: "must not escape",
          },
        },
        { status: 400 },
      ),
    );

    const failure = await failureOf(sendResponsesTurn(input(fetch)));

    expect(failure).toEqual({
      category: "provider-failed",
      message: "The provider request failed with HTTP 400.",
    });
    expect(JSON.stringify(failure)).not.toContain("private");
  });

  it("preserves a bounded rejected-response body overflow failure", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("x".repeat(65)));
              controller.close();
            },
          }),
          { status: 400 },
        ),
    );
    const endpoint = makeOpenAiCompatibleEndpoint({
      instanceId: "019f64cf-7241-7000-8000-000000000001",
      configuration,
      fetch: fetch as CompatibleFetch,
      limits: { responseBodyBytes: 64 },
    });

    await expect(failureOf(sendResponsesTurn(input(fetch, { endpoint })))).resolves.toEqual({
      category: "protocol",
      message: "The provider response exceeded the configured size limit.",
    });
  });

  it("preserves caller cancellation while reading a rejected-response body", async () => {
    const controller = new AbortController();
    let readingBody: (() => void) | undefined;
    const bodyRead = new Promise<void>((resolve) => {
      readingBody = resolve;
    });
    let bodyCancelled = false;
    let firstPull = true;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(streamController) {
              if (firstPull) {
                firstPull = false;
                streamController.enqueue(encoder.encode('{"error":'));
                return;
              }
              readingBody?.();
            },
            cancel() {
              bodyCancelled = true;
            },
          }),
          { status: 400 },
        ),
    );
    const turn = failureOf(sendResponsesTurn(input(fetch, { signal: controller.signal })));

    await bodyRead;
    controller.abort();

    await expect(turn).resolves.toEqual({
      category: "interrupted",
      message: "The provider request was cancelled.",
    });
    expect(bodyCancelled).toBe(true);
  });

  it("sanitizes callback failures that carry extra raw payload", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          item_id: "msg_private",
          output_index: 0,
          content_index: 0,
          delta: "hello",
          logprobs: [],
        },
        completed(3),
      ),
    );

    const failure = await failureOf(
      sendResponsesTurn(
        input(fetch, {
          onEvent() {
            throw {
              category: "protocol",
              message: "private callback failure",
              private_detail: "must not escape",
            };
          },
        }),
      ),
    );

    expect(failure).toEqual({
      category: "provider-failed",
      message: "The provider response could not be normalized.",
    });
    expect(JSON.stringify(failure)).not.toContain("private");
  });

  it("sanitizes upstream failure objects with invalid categories or extra fields", async () => {
    const fetch = vi.fn(async () => {
      throw {
        category: "private-category",
        message: "private upstream failure",
        private_detail: "must not escape",
      };
    });

    const failure = await failureOf(sendResponsesTurn(input(fetch)));

    expect(failure).toEqual({
      category: "provider-failed",
      message: "The provider response could not be normalized.",
    });
    expect(JSON.stringify(failure)).not.toContain("private");
  });

  it("reconstructs a strictly valid upstream failure instead of returning its source object", async () => {
    const source = {
      category: "unavailable" as const,
      message: "The provider endpoint could not be reached.",
    };
    const fetch = vi.fn(async () => {
      throw source;
    });

    const failure = await failureOf(sendResponsesTurn(input(fetch)));

    expect(failure).toEqual(source);
    expect(failure).not.toBe(source);
  });

  it("ignores empty deltas without starting output or allocating an event", async () => {
    const observed = vi.fn();
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          item_id: "msg_private",
          output_index: 0,
          content_index: 0,
          delta: "",
          logprobs: [],
        },
        {
          type: "response.output_text.done",
          sequence_number: 3,
          item_id: "msg_private",
          output_index: 0,
          content_index: 0,
          text: "",
          logprobs: [],
        },
        {
          type: "response.output_item.done",
          sequence_number: 4,
          output_index: 0,
          item: {
            id: "msg_private",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "", annotations: [] }],
          },
        },
        completed(5),
      ),
    );

    const result = await Effect.runPromise(sendResponsesTurn(input(fetch, { onEvent: observed })));

    expect(result.outputStarted).toBe(false);
    expect(result.events).toEqual([]);
    expect(observed).not.toHaveBeenCalled();
  });

  it("fails closed before an Octant event sequence allocation overflows", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          item_id: "msg_private",
          output_index: 0,
          content_index: 0,
          delta: "a",
          logprobs: [],
        },
        {
          type: "response.output_text.delta",
          sequence_number: 3,
          item_id: "msg_private",
          output_index: 0,
          content_index: 0,
          delta: "b",
          logprobs: [],
        },
        completed(4),
      ),
    );

    await expect(
      failureOf(sendResponsesTurn(input(fetch, { sequenceStart: Number.MAX_SAFE_INTEGER }))),
    ).resolves.toEqual({
      category: "protocol",
      message: "The Octant event sequence overflowed.",
    });
  });

  it.each([
    ["bare completion", { type: "response.completed", sequence_number: 1 }],
    [
      "malformed completion",
      {
        type: "response.completed",
        sequence_number: 1,
        response: { id: "resp_private", status: "completed", usage: null },
      },
    ],
    [
      "untyped output item",
      {
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 0,
        item: { id: "item_private" },
      },
    ],
    [
      "malformed message item",
      {
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 0,
        item: { id: "item_private", type: "message" },
      },
    ],
    [
      "malformed content part",
      {
        type: "response.content_part.added",
        sequence_number: 1,
        item_id: "item_private",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text" },
      },
    ],
  ])("rejects %s instead of accepting malformed lifecycle data", async (_name, event) => {
    const fetch = vi.fn(async () => sse(event));

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream contained invalid lifecycle data.",
    });
  });

  it("rejects provider-native tool output items", async () => {
    const fetch = vi.fn(async () =>
      sse(created(1), {
        type: "response.output_item.added",
        sequence_number: 2,
        output_index: 0,
        item: {
          id: "call_private",
          type: "web_search_call",
          status: "in_progress",
          name: "private_tool",
          arguments: "",
          call_id: "call_private",
        },
      }),
    );

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "unsupported",
      message: "The provider attempted an unsupported tool call.",
    });
  });

  it("rejects done text that contradicts accumulated deltas", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          item_id: "msg_private",
          output_index: 0,
          content_index: 0,
          delta: "hello",
          logprobs: [],
        },
        {
          type: "response.output_text.done",
          sequence_number: 3,
          item_id: "msg_private",
          output_index: 0,
          content_index: 0,
          text: "different",
          logprobs: [],
        },
      ),
    );

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream output did not match its completed text.",
    });
  });

  it.each([
    ["failed", { ...responseState("failed"), error: null }],
    ["incomplete", { ...responseState("incomplete"), incomplete_details: null }],
  ])("rejects malformed %s terminal response details", async (status, response) => {
    const fetch = vi.fn(async () =>
      sse(created(1), { type: `response.${status}`, sequence_number: 2, response }),
    );

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream contained invalid lifecycle data.",
    });
  });

  it("validates completed message item text against accumulated deltas", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          item_id: "msg_private",
          output_index: 0,
          content_index: 0,
          delta: "hello",
          logprobs: [],
        },
        {
          type: "response.output_item.done",
          sequence_number: 3,
          output_index: 0,
          item: {
            id: "msg_private",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "different", annotations: [] }],
          },
        },
        completed(4),
      ),
    );

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream output did not match its completed text.",
    });
  });

  it("requires the documented text-done logprobs shape", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        {
          type: "response.output_text.done",
          sequence_number: 2,
          item_id: "msg_private",
          output_index: 0,
          content_index: 0,
          text: "",
        },
        completed(3),
      ),
    );

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream contained invalid lifecycle data.",
    });
  });

  it("rejects a done-only text event for a ghost item", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        {
          type: "response.output_text.done",
          sequence_number: 2,
          item_id: "ghost-message",
          output_index: 0,
          content_index: 0,
          text: "",
          logprobs: [],
        },
        completed(3),
      ),
    );

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream ended with unresolved output items.",
    });
  });

  it("rejects a done-only reasoning event for a ghost item", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        {
          type: "response.reasoning_summary_text.done",
          sequence_number: 2,
          item_id: "ghost-reasoning",
          output_index: 0,
          summary_index: 0,
          text: "",
        },
        completed(3),
      ),
    );

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream ended with unresolved output items.",
    });
  });

  it("rejects [DONE] before terminal completion even when later frames complete", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          [
            `data: ${JSON.stringify(created(1))}`,
            "data: [DONE]",
            `data: ${JSON.stringify(completed(2))}`,
            "",
          ].join("\n\n"),
        ),
    );

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream ended without a terminal response.",
    });
  });

  it.each([
    [
      "output text without an item id",
      {
        type: "response.output_text.delta",
        sequence_number: 2,
        output_index: 0,
        content_index: 0,
        delta: "",
        logprobs: [],
      },
    ],
    [
      "reasoning text without a content index",
      {
        type: "response.reasoning_text.delta",
        sequence_number: 2,
        item_id: "reason_private",
        output_index: 0,
        delta: "",
      },
    ],
    [
      "reasoning summary without a summary index",
      {
        type: "response.reasoning_summary_text.delta",
        sequence_number: 2,
        item_id: "reason_private",
        output_index: 0,
        delta: "",
      },
    ],
  ])("rejects malformed empty %s deltas before suppression", async (_name, event) => {
    const fetch = vi.fn(async () => sse(created(1), event, completed(3)));

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream contained invalid lifecycle data.",
    });
  });

  it("rejects a completed message item that omits streamed content", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          item_id: "msg_private",
          output_index: 0,
          content_index: 0,
          delta: "hello",
          logprobs: [],
        },
        {
          type: "response.output_item.done",
          sequence_number: 3,
          output_index: 0,
          item: {
            id: "msg_private",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [],
          },
        },
        completed(4),
      ),
    );

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream output item omitted streamed content.",
    });
  });

  it("rejects a completed reasoning item that omits streamed summary content", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        {
          type: "response.reasoning_summary_text.delta",
          sequence_number: 2,
          item_id: "reason_private",
          output_index: 0,
          summary_index: 0,
          delta: "Think",
        },
        {
          type: "response.output_item.done",
          sequence_number: 3,
          output_index: 0,
          item: {
            id: "reason_private",
            type: "reasoning",
            status: "completed",
            summary: [],
            content: [],
          },
        },
        completed(4),
      ),
    );

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream reasoning item omitted streamed content.",
    });
  });

  it("does not let a changed output index bypass completed item coverage", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          item_id: "msg_private",
          output_index: 0,
          content_index: 0,
          delta: "hello",
          logprobs: [],
        },
        {
          type: "response.output_item.done",
          sequence_number: 3,
          output_index: 1,
          item: {
            id: "msg_private",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [],
          },
        },
        completed(4),
      ),
    );

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream contained invalid lifecycle data.",
    });
  });

  it("rejects reasoning summary part done text that contradicts accumulated deltas", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        {
          type: "response.reasoning_summary_text.delta",
          sequence_number: 2,
          item_id: "reason_private",
          output_index: 0,
          summary_index: 0,
          delta: "Think",
        },
        {
          type: "response.reasoning_summary_part.done",
          sequence_number: 3,
          item_id: "reason_private",
          output_index: 0,
          summary_index: 0,
          part: { type: "summary_text", text: "Different" },
        },
        completed(4),
      ),
    );

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream reasoning did not match its completed text.",
    });
  });

  it("accepts complete item and summary done coverage when text matches", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          item_id: "msg_private",
          output_index: 0,
          content_index: 0,
          delta: "hello",
          logprobs: [],
        },
        {
          type: "response.output_item.done",
          sequence_number: 3,
          output_index: 0,
          item: {
            id: "msg_private",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "hello", annotations: [] }],
          },
        },
        {
          type: "response.reasoning_summary_text.delta",
          sequence_number: 4,
          item_id: "reason_private",
          output_index: 1,
          summary_index: 0,
          delta: "Think",
        },
        {
          type: "response.reasoning_summary_part.done",
          sequence_number: 5,
          item_id: "reason_private",
          output_index: 1,
          summary_index: 0,
          part: { type: "summary_text", text: "Think" },
        },
        {
          type: "response.output_item.done",
          sequence_number: 6,
          output_index: 1,
          item: {
            id: "reason_private",
            type: "reasoning",
            status: "completed",
            summary: [{ type: "summary_text", text: "Think" }],
            content: [],
          },
        },
        completed(7),
      ),
    );

    const result = await Effect.runPromise(sendResponsesTurn(input(fetch)));

    expect(result).toMatchObject({ text: "hello", reasoning: "Think", terminal: "completed" });
  });

  it.each([
    ["error", { error: { code: "private", message: "private" } }],
    ["incomplete details", { incomplete_details: { reason: "private" } }],
  ])("rejects completed responses with non-null %s", async (_name, contradiction) => {
    const fetch = vi.fn(async () =>
      sse(created(1), {
        ...completed(2),
        response: { ...responseState("completed"), ...contradiction },
      }),
    );

    const failure = await failureOf(sendResponsesTurn(input(fetch)));

    expect(failure).toEqual({
      category: "protocol",
      message: "The provider stream contained invalid lifecycle data.",
    });
    expect(JSON.stringify(failure)).not.toContain("private");
  });

  it.each([
    ["missing", { input_tokens: 3, output_tokens: 2 }],
    ["non-integer", { input_tokens: 3, output_tokens: 2, total_tokens: 5.5 }],
    ["negative", { input_tokens: 3, output_tokens: 2, total_tokens: -1 }],
    ["unsafe", { input_tokens: 3, output_tokens: 2, total_tokens: Number.MAX_SAFE_INTEGER + 1 }],
    ["contradictory", { input_tokens: 3, output_tokens: 2, total_tokens: 6 }],
  ])("rejects %s total token usage before success", async (_name, usage) => {
    const observed = vi.fn();
    const fetch = vi.fn(async () => sse(created(1), completed(2, usage)));

    const failure = await failureOf(sendResponsesTurn(input(fetch, { onEvent: observed })));

    expect(failure).toEqual({
      category: "protocol",
      message: "The provider stream contained invalid usage.",
    });
    expect(observed).not.toHaveBeenCalled();
  });

  it("rejects done lifecycle for a different item identity", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          item_id: "msg-a",
          output_index: 0,
          content_index: 0,
          delta: "hello",
          logprobs: [],
        },
        {
          type: "response.output_item.done",
          sequence_number: 3,
          output_index: 0,
          item: {
            id: "msg-b",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [],
          },
        },
        completed(4),
      ),
    );

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream contained invalid lifecycle data.",
    });
  });

  it("rejects done lifecycle with a different item type", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          item_id: "shared-id",
          output_index: 0,
          content_index: 0,
          delta: "hello",
          logprobs: [],
        },
        {
          type: "response.output_item.done",
          sequence_number: 3,
          output_index: 0,
          item: {
            id: "shared-id",
            type: "reasoning",
            status: "completed",
            summary: [],
            content: [],
          },
        },
        completed(4),
      ),
    );

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream contained invalid lifecycle data.",
    });
  });

  it("rejects an incomplete item before response completion", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          item_id: "msg-a",
          output_index: 0,
          content_index: 0,
          delta: "hello",
          logprobs: [],
        },
        {
          type: "response.output_item.done",
          sequence_number: 3,
          output_index: 0,
          item: {
            id: "msg-a",
            type: "message",
            role: "assistant",
            status: "incomplete",
            content: [{ type: "output_text", text: "hello", annotations: [] }],
          },
        },
        completed(4),
      ),
    );

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream contained invalid lifecycle data.",
    });
  });

  it("rejects terminal success while a streamed item has no done event", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          item_id: "msg-a",
          output_index: 0,
          content_index: 0,
          delta: "hello",
          logprobs: [],
        },
        completed(3),
      ),
    );

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream ended with unresolved output items.",
    });
  });

  it.each([
    [
      "tool call",
      {
        id: "call-private",
        type: "web_search_call",
        status: "completed",
        name: "private_tool",
        arguments: "{}",
        call_id: "call-private",
      },
      { category: "unsupported", message: "The provider attempted an unsupported tool call." },
    ],
    [
      "refusal",
      {
        id: "msg-private",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "refusal", refusal: "private refusal" }],
      },
      { category: "provider-failed", message: "The provider refused the request." },
    ],
    [
      "unsupported status",
      {
        id: "msg-private",
        type: "message",
        role: "assistant",
        status: "incomplete",
        content: [],
      },
      { category: "protocol", message: "The provider stream contained invalid lifecycle data." },
    ],
  ])("rejects terminal output containing a %s", async (_name, outputItem, expected) => {
    const fetch = vi.fn(async () =>
      sse(created(1), {
        ...completed(2),
        response: { ...responseState("completed"), output: [outputItem] },
      }),
    );

    const failure = await failureOf(sendResponsesTurn(input(fetch)));

    expect(failure).toEqual(expected);
    expect(JSON.stringify(failure)).not.toContain("private");
  });

  it("rejects terminal output identity that does not match the streamed item", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          item_id: "msg-a",
          output_index: 0,
          content_index: 0,
          delta: "hello",
          logprobs: [],
        },
        {
          type: "response.output_item.done",
          sequence_number: 3,
          output_index: 0,
          item: {
            id: "msg-a",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "hello", annotations: [] }],
          },
        },
        {
          ...completed(4),
          response: {
            ...responseState("completed"),
            output: [
              {
                id: "msg-b",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "hello", annotations: [] }],
              },
            ],
          },
        },
      ),
    );

    await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
      category: "protocol",
      message: "The provider stream contained invalid lifecycle data.",
    });
  });

  it.each([
    [
      "text",
      {
        id: "msg-a",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "different", annotations: [] }],
      },
      "The provider stream output did not match its completed text.",
    ],
    [
      "reasoning",
      {
        id: "reason-a",
        type: "reasoning",
        status: "completed",
        summary: [{ type: "summary_text", text: "Different" }],
        content: [],
      },
      "The provider stream reasoning did not match its completed text.",
    ],
  ])(
    "rejects terminal %s output that contradicts normalized streaming",
    async (kind, outputItem, message) => {
      const isText = kind === "text";
      const itemId = isText ? "msg-a" : "reason-a";
      const delta = isText
        ? {
            type: "response.output_text.delta",
            sequence_number: 2,
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            delta: "hello",
            logprobs: [],
          }
        : {
            type: "response.reasoning_summary_text.delta",
            sequence_number: 2,
            item_id: itemId,
            output_index: 0,
            summary_index: 0,
            delta: "Think",
          };
      const doneItem = isText
        ? {
            id: itemId,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "hello", annotations: [] }],
          }
        : {
            id: itemId,
            type: "reasoning",
            status: "completed",
            summary: [{ type: "summary_text", text: "Think" }],
            content: [],
          };
      const fetch = vi.fn(async () =>
        sse(
          created(1),
          delta,
          {
            type: "response.output_item.done",
            sequence_number: 3,
            output_index: 0,
            item: doneItem,
          },
          {
            ...completed(4),
            response: { ...responseState("completed"), output: [outputItem] },
          },
        ),
      );

      await expect(failureOf(sendResponsesTurn(input(fetch)))).resolves.toEqual({
        category: "protocol",
        message,
      });
    },
  );

  it("accepts realistic terminal output that reconciles message and reasoning items", async () => {
    const messageItem = {
      id: "msg-a",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "hello", annotations: [] }],
    };
    const reasoningItem = {
      id: "reason-a",
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: "Think" }],
      content: [],
    };
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          item_id: "msg-a",
          output_index: 0,
          content_index: 0,
          delta: "hello",
          logprobs: [],
        },
        {
          type: "response.output_item.done",
          sequence_number: 3,
          output_index: 0,
          item: messageItem,
        },
        {
          type: "response.reasoning_summary_text.delta",
          sequence_number: 4,
          item_id: "reason-a",
          output_index: 1,
          summary_index: 0,
          delta: "Think",
        },
        {
          type: "response.output_item.done",
          sequence_number: 5,
          output_index: 1,
          item: reasoningItem,
        },
        {
          ...completed(6),
          response: {
            ...responseState("completed"),
            output: [messageItem, reasoningItem],
          },
        },
      ),
    );

    const result = await Effect.runPromise(sendResponsesTurn(input(fetch)));

    expect(result).toMatchObject({ text: "hello", reasoning: "Think", terminal: "completed" });
  });
});
