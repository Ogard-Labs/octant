import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type OpenAiCompatibleProviderConfiguration,
  type ProviderModelId,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { NATIVE_HARNESS_TOOL_DEFINITIONS } from "@octant/contracts";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeOpenAiCompatibleDriver } from "./openAiCompatibleDriver";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000601");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000602");
const modelId = "manual-model" as ProviderModelId;
const encoder = new TextEncoder();
const configuration: OpenAiCompatibleProviderConfiguration = {
  kind: "openai-compatible-http",
  baseUrl: "https://provider.example/v1",
  authentication: "bearer",
  protocol: "chat-completions",
  manualModelIds: [modelId],
};

function chatChunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: "chatcmpl_private",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    usage: null,
  };
}

function chatStream(text: string): Response {
  const chunks = [
    chatChunk({ role: "assistant", content: text }),
    chatChunk({}, "stop"),
    {
      id: "chatcmpl_private",
      object: "chat.completion.chunk",
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    },
    "[DONE]",
  ];
  const body = chunks
    .map((value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`)
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

/**
 * The cache-stable assembly contract, checked at the wire: the second turn of
 * a session must send the first turn's request as a byte-identical prefix —
 * same tool definitions in the same order, same history — so a provider's
 * prefix cache serves everything before the new message. A single reordered
 * key would silently re-bill the whole prefix on every turn.
 */
describe("native harness request prefix stability", () => {
  it("sends the first turn's tools and history unchanged at the front of the second turn", async () => {
    const bodies: string[] = [];
    const runtimeRegistry = new ProviderRuntimeRegistry();
    runtimeRegistry.setObservedState({
      instanceId,
      readiness: "ready",
      processState: "stopped",
      models: [
        {
          id: modelId,
          displayName: "manual",
          source: "manual",
          verification: "unverified",
          reasoning: "unavailable",
          inputModalities: ["text"],
          options: [],
        },
      ],
      capabilities: {
        streaming: "supported",
        resume: "unsupported",
        interruption: "supported",
        approvals: "unsupported",
        userQuestions: "unsupported",
        reasoning: "unavailable",
        usage: "supported",
        toolActivity: "unsupported",
        fileChanges: "unsupported",
        diffs: "unsupported",
        taskProgress: "unsupported",
        nativeChildAgents: "unsupported",
        nativeAttachments: "unsupported",
        nativeWebResearch: "unsupported",
        appManagedTools: "supported",
        citations: "unsupported",
      },
      observedAt: "2026-09-05T12:00:00.000Z",
    } as never);
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/models")) return new Response(null, { status: 404 });
      bodies.push(String(init?.body));
      return chatStream(bodies.length === 1 ? "first answer" : "second answer");
    });
    const driver = makeOpenAiCompatibleDriver({
      instanceId,
      configuration,
      credentialResolver: { has: async () => true, resolve: async () => "private-key" },
      fetch: fetch as never,
      runtimeRegistry,
      clock: () => "2026-09-05T12:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000603",
    });
    const tools = [...NATIVE_HARNESS_TOOL_DEFINITIONS];
    const instructions = [{ kind: "instructions" as const, text: "Stable harness instructions." }];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          for (const prompt of ["first", "second"]) {
            const events = yield* Effect.fork(
              Stream.runCollect(
                (yield* connection.subscribe).pipe(
                  Stream.filter((event: ProviderRuntimeEvent) => event.sessionId === sessionId),
                  Stream.takeUntil(
                    (event) => event.kind === "completed" || event.kind === "failed",
                  ),
                ),
              ),
            );
            yield* connection.send({
              sessionId,
              prompt,
              context: instructions,
              attachments: [],
              tools,
            });
            const collected = Array.from(yield* Fiber.join(events));
            const last = collected.at(-1);
            if (last?.kind !== "completed") throw new Error(`terminal: ${JSON.stringify(last)}`);
          }
          yield* connection.stop(sessionId);
        }),
      ),
    );
    expect(bodies).toHaveLength(2);
    const first = JSON.parse(bodies[0]!) as { messages: unknown[]; tools: unknown[] };
    const second = JSON.parse(bodies[1]!) as { messages: unknown[]; tools: unknown[] };
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(JSON.stringify(second.messages.slice(0, first.messages.length))).toBe(
      JSON.stringify(first.messages),
    );
    expect(second.messages.length).toBe(first.messages.length + 2);
  });
});
