import type {
  OpenAiCompatibleProviderConfiguration,
  ProviderFailure,
  ProviderToolDefinition,
} from "@octant/contracts";
import { Effect, Either } from "effect";
import { describe, expect, it, vi } from "vitest";
import { type CompatibleFetch, makeOpenAiCompatibleEndpoint } from "./openAiCompatibleEndpoint";
import {
  type ProtocolToolCall,
  type ProtocolTurnEvent,
  type ResponsesTurnInput,
  sendResponsesTurn,
} from "./openAiResponses";

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
  output: unknown[] = [],
) {
  return { id: "resp_private", object: "response", status, usage, output };
}

function created(sequenceNumber: number) {
  return {
    type: "response.created",
    sequence_number: sequenceNumber,
    response: responseState("in_progress"),
  };
}

function completed(
  sequenceNumber: number,
  output: unknown[] = [],
  usage: Record<string, unknown> | null = null,
) {
  return {
    type: "response.completed",
    sequence_number: sequenceNumber,
    response: responseState("completed", usage, output),
  };
}

function functionCallItem(
  callId: string,
  name: string,
  argumentsJson: string,
  status: "in_progress" | "completed" = "completed",
  itemId = "fc_private",
) {
  return {
    id: itemId,
    type: "function_call",
    status,
    call_id: callId,
    name,
    arguments: argumentsJson,
  };
}

function functionCallAdded(sequenceNumber: number, item: Record<string, unknown>, outputIndex = 0) {
  return {
    type: "response.output_item.added",
    sequence_number: sequenceNumber,
    output_index: outputIndex,
    item,
  };
}

function functionCallDone(sequenceNumber: number, item: Record<string, unknown>, outputIndex = 0) {
  return {
    type: "response.output_item.done",
    sequence_number: sequenceNumber,
    output_index: outputIndex,
    item,
  };
}

function argumentsDelta(sequenceNumber: number, itemId: string, delta: string, outputIndex = 0) {
  return {
    type: "response.function_call_arguments.delta",
    sequence_number: sequenceNumber,
    item_id: itemId,
    output_index: outputIndex,
    delta,
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

describe("sendResponsesTurn tool calls", () => {
  it("parses a single structured function call into a correlated tool-call event and tool-calls terminal", async () => {
    const observed: ProtocolTurnEvent[] = [];
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        functionCallAdded(2, {
          id: "fc_private",
          type: "function_call",
          status: "in_progress",
          call_id: "call_abc",
          name: "octant_capability_echo",
          arguments: "",
        }),
        argumentsDelta(3, "fc_private", '{"echo":"'),
        argumentsDelta(4, "fc_private", 'hello"}'),
        functionCallDone(
          5,
          functionCallItem("call_abc", "octant_capability_echo", '{"echo":"hello"}'),
        ),
        completed(6, [functionCallItem("call_abc", "octant_capability_echo", '{"echo":"hello"}')], {
          input_tokens: 4,
          output_tokens: 3,
          total_tokens: 7,
        }),
      ),
    );

    const result = await Effect.runPromise(
      sendResponsesTurn({
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
    expect(toolCallEvent).toMatchObject({
      kind: "tool-call",
      toolCallId: "call_abc",
      toolName: "octant_capability_echo",
      argumentsJson: '{"echo":"hello"}',
    });
  });

  it("emits the tool-call event only after the function call item completes with valid bounded JSON", async () => {
    const observed: ProtocolTurnEvent[] = [];
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        functionCallAdded(2, {
          id: "fc_private",
          type: "function_call",
          status: "in_progress",
          call_id: "call_abc",
          name: "octant_capability_echo",
          arguments: "",
        }),
        argumentsDelta(3, "fc_private", '{"echo":"hi"}'),
        functionCallDone(
          4,
          functionCallItem("call_abc", "octant_capability_echo", '{"echo":"hi"}'),
        ),
        completed(5, [functionCallItem("call_abc", "octant_capability_echo", '{"echo":"hi"}')]),
      ),
    );

    await Effect.runPromise(
      sendResponsesTurn({
        ...input(fetch),
        tools: [echoTool],
        onEvent: (event) => observed.push(event),
      }),
    );

    const toolCallEvents = observed.filter((event) => event.kind === "tool-call");
    expect(toolCallEvents).toHaveLength(1);
  });

  it("parses several parallel function calls when the model emits them in one response", async () => {
    const observed: ProtocolTurnEvent[] = [];
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        functionCallAdded(2, {
          id: "fc_one",
          type: "function_call",
          status: "in_progress",
          call_id: "call_one",
          name: "octant_capability_echo",
          arguments: "",
        }),
        functionCallAdded(
          3,
          {
            id: "fc_two",
            type: "function_call",
            status: "in_progress",
            call_id: "call_two",
            name: "octant_capability_echo",
            arguments: "",
          },
          1,
        ),
        argumentsDelta(4, "fc_one", '{"echo":"one"}', 0),
        argumentsDelta(5, "fc_two", '{"echo":"two"}', 1),
        functionCallDone(
          6,
          functionCallItem(
            "call_one",
            "octant_capability_echo",
            '{"echo":"one"}',
            "completed",
            "fc_one",
          ),
          0,
        ),
        functionCallDone(
          7,
          functionCallItem(
            "call_two",
            "octant_capability_echo",
            '{"echo":"two"}',
            "completed",
            "fc_two",
          ),
          1,
        ),
        completed(
          8,
          [
            functionCallItem(
              "call_one",
              "octant_capability_echo",
              '{"echo":"one"}',
              "completed",
              "fc_one",
            ),
            functionCallItem(
              "call_two",
              "octant_capability_echo",
              '{"echo":"two"}',
              "completed",
              "fc_two",
            ),
          ],
          { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
        ),
      ),
    );

    const result = await Effect.runPromise(
      sendResponsesTurn({
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

  it("fails closed when the function call arguments are not valid JSON", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        functionCallAdded(2, {
          id: "fc_private",
          type: "function_call",
          status: "in_progress",
          call_id: "call_abc",
          name: "octant_capability_echo",
          arguments: "",
        }),
        functionCallDone(3, functionCallItem("call_abc", "octant_capability_echo", "{not json}")),
        completed(4, [functionCallItem("call_abc", "octant_capability_echo", "{not json}")]),
      ),
    );

    const failure = await failureOf(sendResponsesTurn({ ...input(fetch), tools: [echoTool] }));
    expect(failure.category).toBe("protocol");
  });

  it("fails closed when the function call name is malformed", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        functionCallAdded(2, {
          id: "fc_private",
          type: "function_call",
          status: "in_progress",
          call_id: "call_abc",
          name: "bad name with space",
          arguments: "",
        }),
        functionCallDone(3, functionCallItem("call_abc", "bad name with space", "{}")),
        completed(4, [functionCallItem("call_abc", "bad name with space", "{}")]),
      ),
    );

    const failure = await failureOf(sendResponsesTurn({ ...input(fetch), tools: [echoTool] }));
    expect(failure.category).toBe("protocol");
  });

  it("fails closed when the call_id is missing", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        functionCallAdded(2, {
          id: "fc_private",
          type: "function_call",
          status: "in_progress",
          name: "octant_capability_echo",
          arguments: "",
        }),
        functionCallDone(3, {
          id: "fc_private",
          type: "function_call",
          status: "completed",
          name: "octant_capability_echo",
          arguments: "{}",
        }),
        completed(4, [
          {
            id: "fc_private",
            type: "function_call",
            status: "completed",
            name: "octant_capability_echo",
            arguments: "{}",
          },
        ]),
      ),
    );

    const failure = await failureOf(sendResponsesTurn({ ...input(fetch), tools: [echoTool] }));
    expect(failure.category).toBe("protocol");
  });

  it("fails closed when the stream ends before the function call item completes", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        functionCallAdded(2, {
          id: "fc_private",
          type: "function_call",
          status: "in_progress",
          call_id: "call_abc",
          name: "octant_capability_echo",
          arguments: "",
        }),
        argumentsDelta(3, "fc_private", '{"echo":"partial'),
      ),
    );

    const failure = await failureOf(sendResponsesTurn({ ...input(fetch), tools: [echoTool] }));
    expect(failure.category).toBe("protocol");
  });

  it("fails closed when the completed response output omits a streamed function call", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        functionCallAdded(2, {
          id: "fc_private",
          type: "function_call",
          status: "in_progress",
          call_id: "call_abc",
          name: "octant_capability_echo",
          arguments: "",
        }),
        argumentsDelta(3, "fc_private", '{"echo":"hi"}'),
        functionCallDone(
          4,
          functionCallItem("call_abc", "octant_capability_echo", '{"echo":"hi"}'),
        ),
        completed(5, []),
      ),
    );

    const failure = await failureOf(sendResponsesTurn({ ...input(fetch), tools: [echoTool] }));
    expect(failure.category).toBe("protocol");
  });

  it("still rejects provider-native tool item types like web_search_call as unsupported", async () => {
    const fetch = vi.fn(async () =>
      sse(
        created(1),
        functionCallAdded(2, {
          id: "ws_private",
          type: "web_search_call",
          status: "in_progress",
        }),
      ),
    );

    const failure = await failureOf(sendResponsesTurn({ ...input(fetch), tools: [echoTool] }));
    expect(failure.category).toBe("unsupported");
  });

  it("encodes the supplied tool definitions into the Responses request body", async () => {
    const fetch = vi.fn(async () =>
      sse(created(1), completed(2, [], { input_tokens: 1, output_tokens: 1, total_tokens: 2 })),
    );

    await Effect.runPromise(sendResponsesTurn({ ...input(fetch), tools: [echoTool] }));

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "octant_capability_echo",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["echo"],
          properties: { echo: { type: "string" } },
        },
      },
    ]);
  });

  it("does not include a tools field when no tools are supplied", async () => {
    const fetch = vi.fn(async () =>
      sse(created(1), completed(2, [], { input_tokens: 1, output_tokens: 1, total_tokens: 2 })),
    );

    await Effect.runPromise(sendResponsesTurn(input(fetch)));

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).not.toHaveProperty("tools");
  });
});
