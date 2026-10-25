import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  decodeProviderToolDefinition,
  type ProviderModelId,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { runProviderConformance } from "@octant/provider-sdk/conformance";
import { runProviderChatConformance } from "@octant/provider-sdk/chat-conformance";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { makeOllamaDriver } from "./ollamaDriver";
import {
  recordProviderChatConformanceEvidence,
  recordProviderConformanceEvidence,
} from "./chatProviderMatrixEvidence.test-support";
import type { OllamaFetch } from "./ollamaEndpoint";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000721");
const interruptedSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000722");
const successfulSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000724");
const chatSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000725");
const modelId = "fixture-model" as ProviderModelId;

describe("Ollama provider conformance", () => {
  it("passes capability, streaming, resume, interruption, and cleanup conformance", async () => {
    const registry = new ProviderRuntimeRegistry();
    let chatRequests = 0;
    const fetch: OllamaFetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/version")) return Response.json({ version: "0.31.2" });
      if (url.endsWith("/tags")) {
        return Response.json({ models: [{ name: modelId, model: modelId }] });
      }
      if (url.endsWith("/show")) {
        return Response.json({
          capabilities: ["completion"],
          model_info: { "fixture.context_length": 32768 },
        });
      }
      if (!url.endsWith("/chat")) throw new Error(`Unexpected Ollama request: ${url}`);
      chatRequests += 1;
      return chatRequests === 1 ? completedChat() : hangingChat();
    };
    const driver = makeOllamaDriver({
      instanceId,
      configuration: { kind: "ollama-native-http", baseUrl: "http://127.0.0.1:11434" },
      runtimeRegistry: registry,
      fetch,
      clock: () => "2026-07-18T08:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000723",
    });

    const evidence = await runProviderConformance({
      driver,
      probeInput: { instanceId },
      acquireInput: {
        instanceId,
        projectRoot: "/tmp/octant-ollama-conformance",
        mode: "code",
      },
      successfulTurn: {
        sessionStart: {
          sessionId: successfulSessionId,
          modelId,
          executionPolicy: "approval-gated",
        },
        turn: {
          sessionId: successfulSessionId,
          prompt: "successful fixture prompt",
          attachments: [],
          tools: [],
        },
        expectedEventKinds: ["text-delta", "usage", "completed"],
        expectedStreaming: "supported",
        observed: () => registry.observedState(instanceId),
      },
      sessionStart: {
        sessionId: interruptedSessionId,
        modelId,
        executionPolicy: "approval-gated",
      },
      turn: {
        sessionId: interruptedSessionId,
        prompt: "interrupt fixture prompt",
        attachments: [],
        tools: [],
      },
      resume: {
        sessionId: interruptedSessionId,
        resumeCursor: { driverKind: "ollama", value: interruptedSessionId },
        executionPolicy: "approval-gated",
      },
      staleResume: {
        sessionId: interruptedSessionId,
        resumeCursor: { driverKind: "ollama", value: "stale" },
        executionPolicy: "approval-gated",
      },
      unknownApproval: {
        sessionId: interruptedSessionId,
        requestId: "unknown",
        approved: false,
      },
      unknownUserInput: {
        sessionId: interruptedSessionId,
        requestId: "unknown",
        answer: "none",
      },
      expectedEventKinds: ["interrupted"],
      expectedFailureCategories: {
        staleResume: "stale-resume",
        unknownApproval: "unsupported",
        unknownUserInput: "unsupported",
      },
      isReleased: () => registry.activeSessionCount(instanceId) === 0,
    });
    const chatEvidence = await runProviderChatConformance({
      driver,
      probeInput: { instanceId },
      acquireInput: {
        instanceId,
        projectRoot: "/tmp/octant-ollama-conformance",
        mode: "code",
      },
      sessionStart: { sessionId: chatSessionId, modelId, executionPolicy: "approval-gated" },
      turn: {
        sessionId: chatSessionId,
        prompt: "hello",
        attachments: [
          {
            attachmentId: "attachment-1",
            displayName: "diagram.png",
            mediaType: "image/png",
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
        tools: [],
      },
      isReleased: () => registry.activeSessionCount(instanceId) === 0,
    });
    recordProviderConformanceEvidence("ollama", evidence);
    recordProviderChatConformanceEvidence("ollama", chatEvidence);

    expect(evidence).toEqual({
      probed: true,
      capabilityHonest: true,
      usageCapabilityHonest: true,
      researchCapabilityHonest: true,
      citationsCapabilityHonest: true,
      streamedInOrder: true,
      interrupted: true,
      resumed: true,
      staleResumeRejected: true,
      unknownApprovalRejected: true,
      unknownUserInputRejected: true,
      failureClassified: true,
      released: true,
    });
    expect(chatEvidence).toMatchObject({ nativeAttachmentHonest: true, released: true });
  });
});

describe("Ollama harness tool round trip", () => {
  const toolSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000726");
  const readTool = decodeProviderToolDefinition({
    name: "read_file",
    description: "Read a file in the Project.",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  });

  function toolService(chat: (body: Record<string, unknown>) => Response) {
    const registry = new ProviderRuntimeRegistry();
    const chatBodies: Array<Record<string, unknown>> = [];
    const fetch: OllamaFetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/version")) return Response.json({ version: "0.31.2" });
      if (url.endsWith("/tags")) return Response.json({ models: [{ model: modelId }] });
      if (url.endsWith("/show")) return Response.json({ capabilities: ["completion", "tools"] });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      chatBodies.push(body);
      return chat(body);
    };
    const driver = makeOllamaDriver({
      instanceId,
      configuration: { kind: "ollama-native-http", baseUrl: "http://127.0.0.1:11434" },
      runtimeRegistry: registry,
      fetch,
      clock: () => "2026-07-18T08:00:00.000Z",
    });
    return { registry, driver, chatBodies };
  }

  /** Runs one Code turn, answering each tool request as the server's tool set would. */
  function codeTurn(
    fixture: ReturnType<typeof toolService>,
    answer: (request: Extract<ProviderRuntimeEvent, { kind: "tool-request" }>) => {
      readonly resultJson: string;
      readonly isError: boolean;
    },
  ) {
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* fixture.driver.probe({ instanceId });
          const connection = yield* fixture.driver.acquire({
            instanceId,
            projectRoot: "/tmp/octant-ollama-conformance",
            mode: "code",
          });
          yield* connection.start({
            sessionId: toolSessionId,
            modelId,
            executionPolicy: "approval-gated",
          });
          const events: ProviderRuntimeEvent[] = [];
          const collector = yield* Effect.fork(
            (yield* connection.subscribe).pipe(
              Stream.takeUntil((event) =>
                ["completed", "failed", "interrupted"].includes(event.kind),
              ),
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  events.push(event);
                  if (event.kind !== "tool-request") return;
                  yield* connection.answerTool({
                    sessionId: toolSessionId,
                    requestId: event.requestId,
                    ...answer(event),
                  });
                }),
              ),
            ),
          );
          const sent = yield* Effect.either(
            connection.send({
              sessionId: toolSessionId,
              prompt: "read a.ts",
              attachments: [],
              tools: [readTool],
            }),
          );
          if (sent._tag === "Left") {
            yield* Fiber.interrupt(collector);
          } else {
            yield* Fiber.join(collector);
          }
          yield* connection.stop(toolSessionId);
          return { sent, events };
        }),
      ),
    );
  }

  function verify(fixture: ReturnType<typeof toolService>) {
    const observed = fixture.registry.observedState(instanceId);
    if (observed === undefined) throw new Error("The driver was not probed.");
    fixture.registry.setObservedState({ ...observed, verifiedToolModelIds: [modelId] });
  }

  it("refuses Octant tools for a model nobody verified, before any request", async () => {
    const fixture = toolService(() => completedChat());
    const { sent } = await codeTurn(fixture, () => ({ resultJson: "{}", isError: false }));
    expect(sent).toMatchObject({ _tag: "Left", left: { category: "unsupported" } });
    expect(fixture.chatBodies).toEqual([]);
  });

  it.each([
    { outcome: "allowed", resultJson: '{"text":"export {}"}', isError: false },
    {
      outcome: "refused",
      resultJson: '{"error":"The approval was declined."}',
      isError: true,
    },
  ])(
    "returns an $outcome tool call's answer to the model and finishes the turn",
    async ({ resultJson, isError }) => {
      const replies = [toolCallChat("read_file", { path: "a.ts" }), completedChat()];
      const fixture = toolService(() => replies.shift() ?? completedChat());
      await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
      verify(fixture);

      const { sent, events } = await codeTurn(fixture, (request) => {
        expect(request).toMatchObject({ toolName: "read_file", inputJson: '{"path":"a.ts"}' });
        return { resultJson, isError };
      });

      expect(sent._tag).toBe("Right");
      expect(events.map((event) => event.kind)).toContain("tool-request");
      expect(events.at(-1)?.kind).toBe("completed");
      expect(fixture.chatBodies).toHaveLength(2);
      expect(fixture.chatBodies[0]).toMatchObject({
        tools: [{ type: "function", function: { name: "read_file" } }],
      });
      const followUp = fixture.chatBodies[1]?.messages as ReadonlyArray<Record<string, unknown>>;
      expect(followUp.slice(-2)).toEqual([
        {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "read_file", arguments: { path: "a.ts" } } }],
        },
        { role: "tool", tool_name: "read_file", content: expect.stringContaining(resultJson) },
      ]);
    },
  );
});

function toolCallChat(name: string, args: Record<string, unknown>): Response {
  return new Response(
    `${JSON.stringify({
      model: modelId,
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name, arguments: args } }],
      },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 3,
      eval_count: 2,
    })}\n`,
    { headers: { "content-type": "application/x-ndjson" } },
  );
}

function completedChat(): Response {
  return new Response(
    `${JSON.stringify({
      model: modelId,
      message: { role: "assistant", content: "fixture answer" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 3,
      eval_count: 2,
    })}\n`,
    { headers: { "content-type": "application/x-ndjson" } },
  );
}

function hangingChat(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start() {},
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
}
