import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderFailure,
  type ProviderModelId,
  type ProviderRuntimeEvent,
  type ProviderToolDefinition,
} from "@octant/contracts";
import type { ProviderConnection } from "@octant/provider-sdk/driver";
import type {
  HarnessEndpointDriver,
  HarnessEndpointRequest,
  HarnessEndpointResponse,
} from "@octant/provider-sdk/harness-endpoint";
import { Effect, Exit, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { honestDirectEndpointCapabilities } from "../providers/directEndpointSubscriptionOAuth";
import { ProviderRuntimeRegistry } from "../providers/providerRuntimeRegistry";
import { runOnNativeHarness } from "./nativeHarnessEndpointDriver";
import { NativeHarnessEndpointRegistry } from "./nativeHarnessEndpointRegistry";
import { MemoryNativeHarnessTranscriptStore } from "./nativeHarnessTranscriptStore";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000a01");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000a02");
const modelId = "port-model" as ProviderModelId;
const projectRoot = "/tmp/octant-harness-port";
const readTool: ProviderToolDefinition = {
  name: "read",
  inputSchema: { type: "object", properties: {} },
};

/**
 * A third-party-shaped driver: it supplies only an endpoint through the
 * provider-sdk port, answers from a script, and admits tools for no model
 * unless told to admit every turn.
 */
function portDriver(
  script: Array<HarnessEndpointResponse | ProviderFailure>,
  options: { readonly admitsEveryTurn?: boolean } = {},
): {
  readonly driver: HarnessEndpointDriver;
  readonly requests: HarnessEndpointRequest[];
} {
  const requests: HarnessEndpointRequest[] = [];
  return {
    requests,
    driver: {
      kind: "openai-compatible",
      probe: () => Effect.die("not probed"),
      harnessEndpoint: {
        open: async () => ({
          fits: () => true,
          send: async (request) => {
            requests.push(request);
            const next = script.shift();
            if (next === undefined) throw new Error("The script ran out of responses.");
            if ("category" in next) throw next;
            return next;
          },
          release: () => undefined,
        }),
        admitTurn: (turn) =>
          options.admitsEveryTurn === true || turn.tools.length === 0
            ? undefined
            : { category: "invalid-configuration", message: "This model's tools are unverified." },
      },
    },
  };
}

function host(
  transcripts: MemoryNativeHarnessTranscriptStore,
  endpoints = new NativeHarnessEndpointRegistry(),
  runtimeRegistry = new ProviderRuntimeRegistry(),
) {
  return {
    instanceId,
    runtimeRegistry,
    transcripts,
    harness: { endpoints, retry: { sleep: async () => undefined, random: () => 0.5 } },
    clock: () => "2026-10-26T09:00:00.000Z",
    correlationId: () => "80000000-0000-4000-8000-000000000a03",
  };
}

/** The host's record that a person ran Verify tools on the model. */
function verifiedToolsOn(model: ProviderModelId): ProviderRuntimeRegistry {
  const runtimeRegistry = new ProviderRuntimeRegistry();
  runtimeRegistry.setObservedState({
    instanceId,
    readiness: "ready",
    processState: "stopped",
    models: [],
    capabilities: honestDirectEndpointCapabilities,
    verifiedToolModelIds: [model],
    observedAt: "2026-10-26T09:00:00.000Z",
  });
  return runtimeRegistry;
}

function runTurn(
  connection: ProviderConnection,
  tools: ReadonlyArray<ProviderToolDefinition>,
): Effect.Effect<
  ReadonlyArray<ProviderRuntimeEvent>,
  ProviderFailure,
  import("effect").Scope.Scope
> {
  return Effect.gen(function* () {
    const events = yield* Effect.fork(
      Stream.runCollect(
        (yield* connection.subscribe).pipe(
          Stream.takeUntil((event) => event.kind === "completed" || event.kind === "failed"),
        ),
      ),
    );
    yield* connection.send({ sessionId, prompt: "Say hello", context: [], attachments: [], tools });
    return Array.from(yield* Fiber.join(events));
  });
}

describe("native harness endpoint port", () => {
  it("runs a port driver's turn on the host loop, retrying a failure that usually passes and journaling the conversation", async () => {
    const { driver, requests } = portDriver([
      { category: "unavailable", message: "The endpoint is warming up." },
      { text: "Hello.", toolCalls: [] },
    ]);
    const transcripts = new MemoryNativeHarnessTranscriptStore();
    const composed = runOnNativeHarness(driver, host(transcripts));

    expect(composed.conversationOwnership).toBe("host");
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* composed.acquire({ instanceId, projectRoot, mode: "chat" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "plan" });
          return yield* runTurn(connection, []);
        }),
      ),
    );

    expect(requests).toHaveLength(2);
    expect(events.map((event) => event.kind)).toContain("retrying");
    expect(events.at(-1)?.kind).toBe("completed");
    expect(
      transcripts.load(sessionId)?.messages.map((message) => [message.role, message.text]),
    ).toEqual([
      ["user", expect.stringContaining("Say hello")],
      ["assistant", "Hello."],
    ]);
  });

  it("refuses a turn the driver does not admit before any request is sent or recorded", async () => {
    const { driver, requests } = portDriver([{ text: "unused", toolCalls: [] }]);
    const transcripts = new MemoryNativeHarnessTranscriptStore();
    const composed = runOnNativeHarness(
      driver,
      host(transcripts, new NativeHarnessEndpointRegistry(), verifiedToolsOn(modelId)),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* composed.acquire({ instanceId, projectRoot, mode: "work" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "plan" });
          return yield* runTurn(connection, [readTool]);
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("This model's tools are unverified.");
    expect(requests).toHaveLength(0);
    expect(transcripts.load(sessionId)?.messages).toEqual([]);
  });

  it("refuses tools for a model the host holds no Verify tools record for even when the driver admits every turn", async () => {
    const { driver, requests } = portDriver([{ text: "unused", toolCalls: [] }], {
      admitsEveryTurn: true,
    });
    const transcripts = new MemoryNativeHarnessTranscriptStore();
    const composed = runOnNativeHarness(driver, host(transcripts));

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* composed.acquire({ instanceId, projectRoot, mode: "work" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "plan" });
          return yield* runTurn(connection, [readTool]);
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("App-managed tools are unsupported.");
    expect(requests).toHaveLength(0);
  });

  it("registers the endpoint so another instance's lead can fall back onto it with the same retries", async () => {
    const { driver, requests } = portDriver([
      { category: "rate-limited", message: "Slow down." },
      { text: "Picked up.", toolCalls: [] },
    ]);
    const endpoints = new NativeHarnessEndpointRegistry();
    runOnNativeHarness(driver, host(new MemoryNativeHarnessTranscriptStore(), endpoints));

    const registered = endpoints.get(instanceId);
    expect(
      registered?.admitTurn(
        { sessionId, prompt: "x", context: [], attachments: [], tools: [readTool] },
        modelId,
      ),
    ).toMatchObject({
      category: "unsupported",
    });
    const session = await registered?.open(modelId);
    const response = await session?.send(
      { sessionId, modelId, system: undefined, history: [{ role: "user", text: "go" }], tools: [] },
      { signal: new AbortController().signal, onEvent: () => undefined },
    );

    expect(response?.text).toBe("Picked up.");
    expect(requests).toHaveLength(2);
  });

  it("keeps what a port endpoint's requests teach about its model's window and the model it served", async () => {
    const { driver } = portDriver([
      {
        category: "provider-failed",
        message:
          "This model's maximum context length is 2048 tokens. However, your messages resulted in 3100 tokens.",
      },
      {
        text: "Fits now.",
        toolCalls: [],
        usage: { inputTokens: 2_000, outputTokens: 500 },
        servedModelId: "served-model-2026-10-01",
      },
    ]);
    const runtimeRegistry = new ProviderRuntimeRegistry();
    runtimeRegistry.setObservedState({
      instanceId,
      readiness: "ready",
      processState: "stopped",
      models: [
        {
          id: modelId,
          displayName: "Port model",
          source: "manual",
          verification: "unverified",
          reasoning: "unavailable",
          inputModalities: ["text"],
          options: [],
        },
      ],
      capabilities: honestDirectEndpointCapabilities,
      observedAt: "2026-10-26T09:00:00.000Z",
    });
    const remembered: unknown[] = [];
    const endpoints = new NativeHarnessEndpointRegistry();
    runOnNativeHarness(driver, {
      ...host(new MemoryNativeHarnessTranscriptStore(), endpoints, runtimeRegistry),
      harness: {
        endpoints,
        retry: { sleep: async () => undefined, random: () => 0.5 },
        contextWindows: { remember: (...lesson) => remembered.push(lesson) },
      },
    });
    const session = await endpoints.get(instanceId)?.open(modelId);
    const request: HarnessEndpointRequest = {
      sessionId,
      modelId,
      system: undefined,
      history: [{ role: "user", text: "go" }],
      tools: [],
    };
    const stream = { signal: new AbortController().signal, onEvent: () => undefined };

    await expect(session?.send(request, stream)).rejects.toMatchObject({
      category: "provider-failed",
    });
    expect(runtimeRegistry.observedState(instanceId)?.models[0]?.learnedContextWindow).toBe(2_048);

    await session?.send(request, stream);
    expect(runtimeRegistry.observedState(instanceId)?.models[0]).toMatchObject({
      learnedContextWindow: 2_500,
      servedModelId: "served-model-2026-10-01",
    });
    expect(remembered).toEqual([
      [instanceId, modelId, { learnedContextWindow: 2_048 }],
      [
        instanceId,
        modelId,
        { servedModelId: "served-model-2026-10-01", learnedContextWindow: 2_500 },
      ],
    ]);
  });

  it("refuses a connection without a product mode", async () => {
    const composed = runOnNativeHarness(
      portDriver([]).driver,
      host(new MemoryNativeHarnessTranscriptStore()),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(composed.acquire({ instanceId, projectRoot })),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("explicit product mode");
  });
});
