import type {
  OpenAiCompatibleProviderConfiguration,
  ProviderFailure,
  ProviderToolDefinition,
} from "@octant/contracts";
import { Effect, Either } from "effect";
import { describe, expect, it, vi } from "vitest";
import { type CompatibleFetch, makeOpenAiCompatibleEndpoint } from "./openAiCompatibleEndpoint";
import { type ChatCompletionsTurnInput, sendChatCompletionsTurn } from "./openAiChatCompletions";
import type { ProtocolToolCall, ProtocolTurnEvent } from "./openAiResponses";

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

function toolCallDelta(
  index: number,
  id: string | null,
  name: string | null,
  argumentsDelta: string | null,
) {
  const toolCall: Record<string, unknown> = { index };
  if (id !== null) toolCall.id = id;
  toolCall.type = "function";
  const fn: Record<string, unknown> = {};
  if (name !== null) fn.name = name;
  if (argumentsDelta !== null) fn.arguments = argumentsDelta;
  toolCall.function = fn;
  return { tool_calls: [toolCall] };
}

function usageChunk(inputTokens = 3, outputTokens = 2) {
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

function nonStreamingResponse(
  message: Record<string, unknown>,
  finishReason: string,
  usage: Record<string, unknown> | null = null,
): Response {
  const body = {
    id: "chatcmpl_private",
    object: "chat.completion",
    created: 1,
    model: "manual-model",
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    ...(usage === null ? {} : { usage }),
  };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function streamUnsupportedResponse(): Response {
  return Response.json(
    {
      error: {
        message: "unsupported",
        type: "invalid_request_error",
        param: "stream",
        code: "unsupported_parameter",
      },
    },
    { status: 400 },
  );
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
    history: [],
    prompt: "use the tool",
    ...overrides,
  };
}

async function failureOf(effect: Effect.Effect<unknown, ProviderFailure>) {
  const either = await Effect.runPromise(Effect.either(effect));
  expect(Either.isLeft(either)).toBe(true);
  if (Either.isRight(either)) throw new Error("Expected a typed provider failure.");
  return either.left;
}

const echoTool: ProviderToolDefinition = {
  name: "octant_capability_echo" as never,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["echo"],
    properties: { echo: { type: "string" } },
  },
};

describe("sendChatCompletionsTurn tool calls (streaming)", () => {
  it("parses a single streamed tool call into a correlated tool-call event and tool-calls terminal", async () => {
    const observed: ProtocolTurnEvent[] = [];
    const fetch = vi.fn(async () =>
      stream(
        chunk(toolCallDelta(0, "call_abc", "octant_capability_echo", null)),
        chunk(toolCallDelta(0, null, null, '{"echo":"')),
        chunk(toolCallDelta(0, null, null, 'hello"}'), "tool_calls"),
        usageChunk(4, 3),
        "[DONE]",
      ),
    );

    const result = await Effect.runPromise(
      sendChatCompletionsTurn({
        ...input(fetch),
        tools: [echoTool],
        onEvent: (event) => observed.push(event),
      }),
    );

    expect(result.terminal).toBe("tool-calls");
    expect(result.toolCalls).toEqual<ProtocolToolCall[]>([
      {
        toolCallId: "call_abc",
        toolName: "octant_capability_echo",
        argumentsJson: '{"echo":"hello"}',
      },
    ]);
    const toolCallEvent = observed.find((event) => event.kind === "tool-call");
    expect(toolCallEvent).toMatchObject({
      kind: "tool-call",
      toolCallId: "call_abc",
      toolName: "octant_capability_echo",
      argumentsJson: '{"echo":"hello"}',
    });
  });

  it("emits the tool-call event only after the finish reason with complete bounded JSON", async () => {
    const observed: ProtocolTurnEvent[] = [];
    const fetch = vi.fn(async () =>
      stream(
        chunk(toolCallDelta(0, "call_abc", "octant_capability_echo", null)),
        chunk(toolCallDelta(0, null, null, '{"echo":"hi"}'), "tool_calls"),
        usageChunk(2, 2),
        "[DONE]",
      ),
    );

    const result = await Effect.runPromise(
      sendChatCompletionsTurn({
        ...input(fetch),
        tools: [echoTool],
        onEvent: (event) => observed.push(event),
      }),
    );

    const toolCallEvents = observed.filter((event) => event.kind === "tool-call");
    expect(toolCallEvents).toHaveLength(1);
    expect(result.toolCalls[0]!.argumentsJson).toBe('{"echo":"hi"}');
  });

  it("parses several parallel tool calls emitted in one stream", async () => {
    const observed: ProtocolTurnEvent[] = [];
    const fetch = vi.fn(async () =>
      stream(
        chunk(toolCallDelta(0, "call_one", "octant_capability_echo", null)),
        chunk(toolCallDelta(1, "call_two", "octant_capability_echo", null)),
        chunk(toolCallDelta(0, null, null, '{"echo":"one"}')),
        chunk(toolCallDelta(1, null, null, '{"echo":"two"}'), "tool_calls"),
        usageChunk(4, 4),
        "[DONE]",
      ),
    );

    const result = await Effect.runPromise(
      sendChatCompletionsTurn({
        ...input(fetch),
        tools: [echoTool],
        onEvent: (event) => observed.push(event),
      }),
    );

    expect(result.terminal).toBe("tool-calls");
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.map((call) => call.toolCallId).sort()).toEqual([
      "call_one",
      "call_two",
    ]);
  });

  it("fails closed when the streamed tool call arguments are not valid JSON", async () => {
    const fetch = vi.fn(async () =>
      stream(
        chunk(toolCallDelta(0, "call_abc", "octant_capability_echo", null)),
        chunk(toolCallDelta(0, null, null, "{not json}"), "tool_calls"),
        usageChunk(2, 2),
        "[DONE]",
      ),
    );

    const failure = await failureOf(
      sendChatCompletionsTurn({ ...input(fetch), tools: [echoTool] }),
    );
    expect(failure.category).toBe("protocol");
  });

  it("fails closed when the tool call id is missing", async () => {
    const fetch = vi.fn(async () =>
      stream(
        chunk(toolCallDelta(0, null, "octant_capability_echo", null)),
        chunk(toolCallDelta(0, null, null, "{}"), "tool_calls"),
        usageChunk(2, 2),
        "[DONE]",
      ),
    );

    const failure = await failureOf(
      sendChatCompletionsTurn({ ...input(fetch), tools: [echoTool] }),
    );
    expect(failure.category).toBe("protocol");
  });

  it("fails closed when the tool name is malformed", async () => {
    const fetch = vi.fn(async () =>
      stream(
        chunk(toolCallDelta(0, "call_abc", "bad name", null)),
        chunk(toolCallDelta(0, null, null, "{}"), "tool_calls"),
        usageChunk(2, 2),
        "[DONE]",
      ),
    );

    const failure = await failureOf(
      sendChatCompletionsTurn({ ...input(fetch), tools: [echoTool] }),
    );
    expect(failure.category).toBe("protocol");
  });

  it("fails closed when the stream ends with finish reason tool_calls but no tool calls were streamed", async () => {
    const fetch = vi.fn(async () => stream(chunk({}, "tool_calls"), usageChunk(2, 2), "[DONE]"));

    const failure = await failureOf(
      sendChatCompletionsTurn({ ...input(fetch), tools: [echoTool] }),
    );
    expect(failure.category).toBe("protocol");
  });

  it("fails closed when a tool call index appears before its identity is established", async () => {
    const fetch = vi.fn(async () =>
      stream(
        chunk(toolCallDelta(0, null, null, '{"echo":"hi"}'), "tool_calls"),
        usageChunk(2, 2),
        "[DONE]",
      ),
    );

    const failure = await failureOf(
      sendChatCompletionsTurn({ ...input(fetch), tools: [echoTool] }),
    );
    expect(failure.category).toBe("protocol");
  });

  it("still rejects the legacy function_call finish reason as unsupported", async () => {
    const fetch = vi.fn(async () => stream(chunk({}, "function_call"), usageChunk(2, 2), "[DONE]"));

    const failure = await failureOf(
      sendChatCompletionsTurn({ ...input(fetch), tools: [echoTool] }),
    );
    expect(failure.category).toBe("unsupported");
  });

  it("encodes the supplied tool definitions into the Chat Completions request body", async () => {
    const fetch = vi.fn(async () => stream(chunk({}, "stop"), usageChunk(1, 1), "[DONE]"));

    await Effect.runPromise(sendChatCompletionsTurn({ ...input(fetch), tools: [echoTool] }));

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "octant_capability_echo",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["echo"],
            properties: { echo: { type: "string" } },
          },
        },
      },
    ]);
  });
});

describe("sendChatCompletionsTurn tool calls (non-streaming)", () => {
  it("parses a non-streaming tool call response into a correlated tool-call event", async () => {
    const observed: ProtocolTurnEvent[] = [];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(streamUnsupportedResponse())
      .mockResolvedValueOnce(
        nonStreamingResponse(
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: {
                  name: "octant_capability_echo",
                  arguments: '{"echo":"hello"}',
                },
              },
            ],
          },
          "tool_calls",
          { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
        ),
      );

    const result = await Effect.runPromise(
      sendChatCompletionsTurn({
        ...input(fetch),
        tools: [echoTool],
        onEvent: (event) => observed.push(event),
      }),
    );

    expect(result.terminal).toBe("tool-calls");
    expect(result.toolCalls).toEqual<ProtocolToolCall[]>([
      {
        toolCallId: "call_abc",
        toolName: "octant_capability_echo",
        argumentsJson: '{"echo":"hello"}',
      },
    ]);
    const toolCallEvent = observed.find((event) => event.kind === "tool-call");
    expect(toolCallEvent).toBeDefined();
  });

  it("fails closed when non-streaming tool call arguments are not valid JSON", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(streamUnsupportedResponse())
      .mockResolvedValueOnce(
        nonStreamingResponse(
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: { name: "octant_capability_echo", arguments: "{not json}" },
              },
            ],
          },
          "tool_calls",
          { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
        ),
      );

    const failure = await failureOf(
      sendChatCompletionsTurn({ ...input(fetch), tools: [echoTool] }),
    );
    expect(failure.category).toBe("protocol");
  });

  it("fails closed when a non-streaming tool call id is missing", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(streamUnsupportedResponse())
      .mockResolvedValueOnce(
        nonStreamingResponse(
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                type: "function",
                function: { name: "octant_capability_echo", arguments: "{}" },
              },
            ],
          },
          "tool_calls",
          { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
        ),
      );

    const failure = await failureOf(
      sendChatCompletionsTurn({ ...input(fetch), tools: [echoTool] }),
    );
    expect(failure.category).toBe("protocol");
  });
});
