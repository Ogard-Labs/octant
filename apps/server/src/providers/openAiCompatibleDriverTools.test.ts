import { Effect, Stream } from "effect";
import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type OpenAiCompatibleProviderConfiguration,
  type ProviderModelId,
  type ProviderRuntimeEvent,
  type ProviderToolAnswer,
  type ProviderToolDefinition,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { CompatibleFetch } from "./openAiCompatibleEndpoint";
import { makeOpenAiCompatibleDriver } from "./openAiCompatibleDriver";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000601");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000602");
const modelId = "manual-model" as ProviderModelId;

const configuration: OpenAiCompatibleProviderConfiguration = {
  kind: "openai-compatible-http",
  baseUrl: "https://provider.example/v1",
  authentication: "none",
  protocol: "responses",
  manualModelIds: [modelId],
};

const echoTool: ProviderToolDefinition = {
  name: "octant_capability_echo" as never,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["echo"],
    properties: { echo: { type: "string" } },
  },
};

function makeDriver(fetch: CompatibleFetch) {
  const runtimeRegistry = new ProviderRuntimeRegistry();
  return {
    driver: makeOpenAiCompatibleDriver({
      instanceId,
      configuration,
      runtimeRegistry,
      fetch,
    }),
    runtimeRegistry,
  };
}

function responsesToolCallStream(callId: string, toolName: string, args: string): Response {
  const events = [
    {
      type: "response.created",
      sequence_number: 1,
      response: { id: "r", object: "response", status: "in_progress", usage: null, output: [] },
    },
    {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: {
        id: "fc_1",
        type: "function_call",
        status: "in_progress",
        call_id: callId,
        name: toolName,
        arguments: "",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      sequence_number: 3,
      item_id: "fc_1",
      output_index: 0,
      delta: args,
    },
    {
      type: "response.output_item.done",
      sequence_number: 4,
      output_index: 0,
      item: {
        id: "fc_1",
        type: "function_call",
        status: "completed",
        call_id: callId,
        name: toolName,
        arguments: args,
      },
    },
    {
      type: "response.completed",
      sequence_number: 5,
      response: {
        id: "r",
        object: "response",
        status: "completed",
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        output: [
          {
            id: "fc_1",
            type: "function_call",
            status: "completed",
            call_id: callId,
            name: toolName,
            arguments: args,
          },
        ],
      },
    },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function responsesTextStream(text: string): Response {
  const events = [
    {
      type: "response.created",
      sequence_number: 1,
      response: { id: "r", object: "response", status: "in_progress", usage: null, output: [] },
    },
    {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 3,
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
    },
    {
      type: "response.output_text.done",
      sequence_number: 4,
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      text,
      logprobs: [],
    },
    {
      type: "response.output_item.done",
      sequence_number: 5,
      output_index: 0,
      item: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      sequence_number: 6,
      response: {
        id: "r",
        object: "response",
        status: "completed",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        output: [],
      },
    },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function modelsResponse(): Response {
  return Response.json({ data: [{ id: "manual-model" }] });
}

function isToolRequest(event: ProviderRuntimeEvent): boolean {
  return event.kind === "tool-request";
}

function isTerminal(event: ProviderRuntimeEvent): boolean {
  return event.kind === "completed" || event.kind === "interrupted" || event.kind === "failed";
}

async function collectEvents(
  stream: Stream.Stream<ProviderRuntimeEvent, unknown>,
  until: (event: ProviderRuntimeEvent) => boolean,
): Promise<ProviderRuntimeEvent[]> {
  const chunk = await Effect.runPromise(Stream.runCollect(stream.pipe(Stream.takeUntil(until))));
  return Array.from(chunk) as ProviderRuntimeEvent[];
}

function routeFetch(
  turnResponse: () => Response,
  modelsResponseFn: () => Response = modelsResponse,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL | Request) => {
    const path = typeof url === "string" ? url : url instanceof URL ? url.pathname : url.url;
    if (path.includes("/models")) return modelsResponseFn();
    return turnResponse();
  });
}

describe("makeOpenAiCompatibleDriver tool loop", () => {
  it("emits tool-request events when the model requests a tool call (no waiting terminal)", async () => {
    const fetch = routeFetch(() =>
      responsesToolCallStream("call_abc", "octant_capability_echo", '{"echo":"hi"}'),
    );
    const { driver, runtimeRegistry } = makeDriver(fetch as CompatibleFetch);

    await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    const collected = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const events = connection.events;
          yield* connection.send({
            sessionId,
            prompt: "echo hi",
            attachments: [],
            tools: [echoTool],
            context: [],
          });
          // Collect until the tool-request is emitted (no terminal for tool-calls)
          const result = yield* Effect.promise(() => collectEvents(events, isToolRequest));
          yield* connection.stop(sessionId);
          return result;
        }),
      ),
    );

    const toolRequests = collected.filter((e) => e.kind === "tool-request");
    expect(toolRequests).toHaveLength(1);
    expect(toolRequests[0]).toMatchObject({
      kind: "tool-request",
      requestId: "call_abc",
      toolName: "octant_capability_echo",
      inputJson: '{"echo":"hi"}',
    });
    // No waiting terminal should be emitted for app-managed tool calls
    const waiting = collected.find((e) => e.kind === "waiting");
    expect(waiting).toBeUndefined();

    const observed = runtimeRegistry.observedState(instanceId);
    expect(observed?.capabilities.appManagedTools).toBe("supported");
  });

  it("completes the turn after answerTool provides the tool result", async () => {
    let callCount = 0;
    const fetch = routeFetch(() => {
      callCount += 1;
      return callCount === 1
        ? responsesToolCallStream("call_abc", "octant_capability_echo", '{"echo":"hi"}')
        : responsesTextStream("done");
    });
    const { driver } = makeDriver(fetch as CompatibleFetch);

    await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const events = connection.events;
          yield* connection.send({
            sessionId,
            prompt: "echo hi",
            attachments: [],
            tools: [echoTool],
            context: [],
          });
          // Wait for the first turn to emit the tool-request
          yield* Stream.runCollect(events.pipe(Stream.takeUntil((e) => e.kind === "tool-request")));
          const answer: ProviderToolAnswer = {
            sessionId,
            requestId: "call_abc",
            resultJson: '{"echo":"hi"}',
            isError: false,
          };
          const answerResult = yield* Effect.either(connection.answerTool(answer));
          expect(answerResult._tag).toBe("Right");
          // Wait briefly for the second turn to complete
          yield* Effect.sleep("200 millis");
          yield* connection.stop(sessionId);
        }),
      ),
    );
    expect(callCount).toBe(2);
  });

  it("rejects answerTool for an unknown tool call id", async () => {
    const fetch = routeFetch(() =>
      responsesToolCallStream("call_abc", "octant_capability_echo", '{"echo":"hi"}'),
    );
    const { driver } = makeDriver(fetch as CompatibleFetch);

    await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const events = connection.events;
          yield* connection.send({
            sessionId,
            prompt: "echo hi",
            attachments: [],
            tools: [echoTool],
            context: [],
          });
          yield* Effect.promise(() => collectEvents(events, (e) => e.kind === "tool-request"));
          const answer: ProviderToolAnswer = {
            sessionId,
            requestId: "call_unknown",
            resultJson: '{"echo":"hi"}',
            isError: false,
          };
          const result = yield* Effect.either(connection.answerTool(answer));
          expect(result._tag).toBe("Left");
          yield* connection.stop(sessionId);
        }),
      ),
    );
  });

  it("rejects answerTool when no tools were supplied for the turn", async () => {
    const fetch = routeFetch(() => responsesTextStream("hello"));
    const { driver } = makeDriver(fetch as CompatibleFetch);

    await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          yield* connection.send({
            sessionId,
            prompt: "hello",
            attachments: [],
            tools: [],
            context: [],
          });
          const answer: ProviderToolAnswer = {
            sessionId,
            requestId: "call_abc",
            resultJson: '{"echo":"hi"}',
            isError: false,
          };
          const result = yield* Effect.either(connection.answerTool(answer));
          expect(result._tag).toBe("Left");
          yield* connection.stop(sessionId);
        }),
      ),
    );
  });

  it("preserves appManagedTools capability after a follow-up plain completion", async () => {
    let callCount = 0;
    const fetch = routeFetch(() => {
      callCount += 1;
      return callCount === 1
        ? responsesToolCallStream("call_abc", "octant_capability_echo", '{"echo":"hi"}')
        : responsesTextStream("done");
    });
    const { driver, runtimeRegistry } = makeDriver(fetch as CompatibleFetch);

    await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const events = connection.events;
          yield* connection.send({
            sessionId,
            prompt: "echo hi",
            attachments: [],
            tools: [echoTool],
            context: [],
          });
          // Wait for the tool-request
          yield* Stream.runCollect(events.pipe(Stream.takeUntil((e) => e.kind === "tool-request")));
          const answer: ProviderToolAnswer = {
            sessionId,
            requestId: "call_abc",
            resultJson: '{"echo":"hi"}',
            isError: false,
          };
          yield* connection.answerTool(answer);
          // Wait for the follow-up completion
          yield* Effect.sleep("300 millis");
          yield* connection.stop(sessionId);
        }),
      ),
    );
    // After the tool loop completes with a plain response, appManagedTools
    // must remain "supported" (sticky), not downgraded to "unsupported".
    // parallelTools must not appear on ProviderCapabilities (only on ProviderModel).
    const observed = runtimeRegistry.observedState(instanceId);
    expect(observed).toBeDefined();
    expect(observed?.capabilities.appManagedTools).toBe("supported");
    const capabilities = (observed ?? { capabilities: {} }).capabilities as Record<string, unknown>;
    expect(capabilities.parallelTools).toBeUndefined();
    expect(callCount).toBe(2);
  });

  it("rejects unoffered tool calls with a failed terminal", async () => {
    const fetch = routeFetch(() => responsesToolCallStream("call_abc", "unknown_tool", '{"x":1}'));
    const { driver } = makeDriver(fetch as CompatibleFetch);

    await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    const collected = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const events = connection.events;
          yield* connection.send({
            sessionId,
            prompt: "use unknown tool",
            attachments: [],
            tools: [echoTool],
            context: [],
          });
          const result = yield* Effect.promise(() => collectEvents(events, isTerminal));
          yield* connection.stop(sessionId);
          return result;
        }),
      ),
    );
    const failed = collected.find((e) => e.kind === "failed");
    expect(failed).toBeDefined();
    expect((failed as { kind: string; failure: { message: string } }).failure.message).toContain(
      "unsupported tool",
    );
    // No tool-request should be emitted for an unoffered tool
    const toolRequest = collected.find((e) => e.kind === "tool-request");
    expect(toolRequest).toBeUndefined();
  });

  it("rejects duplicate tool call identifiers with a failed terminal", async () => {
    const fetch = routeFetch(() => {
      // Two tool calls with the same call_id in a single response
      const events = [
        {
          type: "response.created",
          sequence_number: 1,
          response: { id: "r", object: "response", status: "in_progress", usage: null, output: [] },
        },
        {
          type: "response.output_item.added",
          sequence_number: 2,
          output_index: 0,
          item: {
            id: "fc_1",
            type: "function_call",
            status: "in_progress",
            call_id: "call_dup",
            name: "octant_capability_echo",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          sequence_number: 3,
          item_id: "fc_1",
          output_index: 0,
          delta: '{"echo":"a"}',
        },
        {
          type: "response.output_item.done",
          sequence_number: 4,
          output_index: 0,
          item: {
            id: "fc_1",
            type: "function_call",
            status: "completed",
            call_id: "call_dup",
            name: "octant_capability_echo",
            arguments: '{"echo":"a"}',
          },
        },
        {
          type: "response.output_item.added",
          sequence_number: 5,
          output_index: 1,
          item: {
            id: "fc_2",
            type: "function_call",
            status: "in_progress",
            call_id: "call_dup",
            name: "octant_capability_echo",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          sequence_number: 6,
          item_id: "fc_2",
          output_index: 1,
          delta: '{"echo":"b"}',
        },
        {
          type: "response.output_item.done",
          sequence_number: 7,
          output_index: 1,
          item: {
            id: "fc_2",
            type: "function_call",
            status: "completed",
            call_id: "call_dup",
            name: "octant_capability_echo",
            arguments: '{"echo":"b"}',
          },
        },
        {
          type: "response.completed",
          sequence_number: 8,
          response: {
            id: "r",
            object: "response",
            status: "completed",
            usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
            output: [
              {
                id: "fc_1",
                type: "function_call",
                status: "completed",
                call_id: "call_dup",
                name: "octant_capability_echo",
                arguments: '{"echo":"a"}',
              },
              {
                id: "fc_2",
                type: "function_call",
                status: "completed",
                call_id: "call_dup",
                name: "octant_capability_echo",
                arguments: '{"echo":"b"}',
              },
            ],
          },
        },
      ];
      return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const { driver } = makeDriver(fetch as CompatibleFetch);

    await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    const collected = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const events = connection.events;
          yield* connection.send({
            sessionId,
            prompt: "dup call",
            attachments: [],
            tools: [echoTool],
            context: [],
          });
          const result = yield* Effect.promise(() => collectEvents(events, isTerminal));
          yield* connection.stop(sessionId);
          return result;
        }),
      ),
    );
    const failed = collected.find((e) => e.kind === "failed");
    expect(failed).toBeDefined();
    expect((failed as { kind: string; failure: { message: string } }).failure.message).toContain(
      "duplicate tool call",
    );
  });

  it("persists tool results in history after a tool loop completes", async () => {
    let callCount = 0;
    const capturedBodies: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = typeof url === "string" ? url : url instanceof URL ? url.pathname : url.url;
      if (path.includes("/models")) return modelsResponse();
      callCount += 1;
      // Capture non-models request bodies for later inspection
      if (init?.body) capturedBodies.push(String(init.body));
      // Routine provider probes are non-generating. The first model request is
      // therefore the actual send, followed by the tool-result continuation.
      return callCount === 1
        ? responsesToolCallStream("call_abc", "octant_capability_echo", '{"echo":"hi"}')
        : responsesTextStream("done");
    });
    const { driver } = makeDriver(fetch as unknown as CompatibleFetch);

    await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const events = connection.events;
          yield* connection.send({
            sessionId,
            prompt: "echo hi",
            attachments: [],
            tools: [echoTool],
            context: [],
          });
          yield* Stream.runCollect(events.pipe(Stream.takeUntil((e) => e.kind === "tool-request")));
          yield* connection.answerTool({
            sessionId,
            requestId: "call_abc",
            resultJson: '{"echo":"hi"}',
            isError: false,
          });
          yield* Effect.sleep("300 millis");
          yield* connection.stop(sessionId);
        }),
      ),
    );
    // The continuation request body (last captured) should include
    // function_call_output from history.
    expect(capturedBodies.length).toBe(2);
    const lastBody = capturedBodies[capturedBodies.length - 1];
    expect(lastBody).toBeDefined();
    const continuationBody = JSON.parse(lastBody as string);
    expect(JSON.stringify(continuationBody.input)).toContain("function_call_output");
    expect(JSON.stringify(continuationBody.input)).toContain("call_abc");
    // P1 #1: no empty assistant item should appear between the function_call
    // and its function_call_output (the tool-result-only history entry
    // serializes directly to output items).
    const inputItems = continuationBody.input as {
      role?: string;
      content?: string;
      type?: string;
    }[];
    const outputIndex = inputItems.findIndex((item) => item.type === "function_call_output");
    expect(outputIndex).toBeGreaterThan(0);
    const preceding = inputItems[outputIndex - 1];
    expect(preceding).toBeDefined();
    // The item immediately before the output must be a function_call, not an
    // empty assistant message.
    expect(preceding?.type).toBe("function_call");
  });

  it("ignores duplicate answerTool calls for the same request", async () => {
    let callCount = 0;
    const fetch = routeFetch(() => {
      callCount += 1;
      return callCount === 1
        ? responsesToolCallStream("call_abc", "octant_capability_echo", '{"echo":"hi"}')
        : responsesTextStream("done");
    });
    const { driver } = makeDriver(fetch as CompatibleFetch);

    await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const events = connection.events;
          yield* connection.send({
            sessionId,
            prompt: "echo hi",
            attachments: [],
            tools: [echoTool],
            context: [],
          });
          yield* Stream.runCollect(events.pipe(Stream.takeUntil((e) => e.kind === "tool-request")));
          const answer = {
            sessionId,
            requestId: "call_abc",
            resultJson: '{"echo":"hi"}',
            isError: false,
          };
          // First answer starts the continuation
          yield* connection.answerTool(answer);
          // Duplicate answer for the same request should be ignored, not
          // start a second continuation or encode duplicate tool results.
          yield* connection.answerTool(answer);
          yield* Effect.sleep("300 millis");
          yield* connection.stop(sessionId);
        }),
      ),
    );
    // Only 2 non-models requests: probe + tool-call turn + continuation = 3,
    // but routeFetch handles the probe separately, so the turn responses are
    // callCount (1 tool-call + 1 continuation = 2).
    expect(callCount).toBe(2);
  });
});
