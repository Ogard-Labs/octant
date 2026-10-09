import {
  decodeProviderInstanceId,
  decodeProviderProbeResult,
  decodeProviderSessionId,
  type OpenAiCompatibleProviderConfiguration,
  type ProviderFailure,
  type ProviderModelId,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { encodeSubscriptionOAuthCredential } from "@octant/provider-sdk/subscription-oauth";
import { Effect, Either, Fiber, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import type { ModelContextWindowMemory } from "./modelContextWindowFacts";
import type { CompatibleFetch } from "./openAiCompatibleEndpoint";
import { makeOpenAiCompatibleDriver } from "./openAiCompatibleDriver";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000501");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000502");
const otherSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000504");
const modelId = "manual-model" as ProviderModelId;
const encoder = new TextEncoder();

const configuration: OpenAiCompatibleProviderConfiguration = {
  kind: "openai-compatible-http",
  baseUrl: "https://provider.example/v1",
  authentication: "bearer",
  protocol: "chat-completions",
  manualModelIds: [modelId],
};

describe("makeOpenAiCompatibleDriver", () => {
  it("resolves credentials for every probe and session while allowing no-auth loopback", async () => {
    const credentialResolver = resolver();
    const fetch = vi.fn(async (url: string | URL | Request) => modelsResponse(url));
    const driver = makeDriver({ credentialResolver, fetch });

    const first = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    expect(first).toMatchObject({
      readiness: "ready",
      processState: "stopped",
      credentialStatus: "stored",
      capabilities: {
        streaming: "unavailable",
        resume: "supported",
        interruption: "supported",
        approvals: "unsupported",
        userQuestions: "unsupported",
        toolActivity: "unsupported",
        fileChanges: "unsupported",
        nativeChildAgents: "unsupported",
        harnessAutoReview: "unsupported",
      },
    });
    expect(first.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "discovered-model",
          source: "discovered",
          verification: "verified",
        }),
      ]),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          yield* connection.stop(sessionId);
        }),
      ),
    );
    expect(credentialResolver.resolve).toHaveBeenCalledTimes(3);

    const noAuthResolver = resolver();
    const noAuthDriver = makeDriver({
      credentialResolver: noAuthResolver,
      fetch,
      configuration: {
        ...configuration,
        baseUrl: "http://127.0.0.1:11434/v1",
        authentication: "none",
      },
    });
    await Effect.runPromise(Effect.scoped(noAuthDriver.probe({ instanceId })));
    expect(noAuthResolver.resolve).not.toHaveBeenCalled();
  });

  it("keeps only successful active history and verifies a manual model after terminal success", async () => {
    const bodies: unknown[] = [];
    let turn = 0;
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/models")) return new Response(null, { status: 404 });
      bodies.push(JSON.parse(String(init?.body)) as unknown);
      turn += 1;
      if (turn === 1) return chatStream("first answer");
      if (turn === 2) return new Response(null, { status: 400 });
      return chatStream("third answer");
    });
    const driver = makeDriver({ fetch, runtimeRegistry });
    const probe = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    expect(probe).toMatchObject({
      readiness: "degraded",
      models: [{ verification: "unverified" }],
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });

          const firstEvents = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, sessionId),
          );
          yield* connection.send({ sessionId, prompt: "first", attachments: [], tools: [] });
          expect(Array.from(yield* Fiber.join(firstEvents)).at(-1)?.kind).toBe("completed");

          const failedEvents = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, sessionId),
          );
          yield* connection.send({ sessionId, prompt: "second", attachments: [], tools: [] });
          expect(Array.from(yield* Fiber.join(failedEvents)).at(-1)?.kind).toBe("failed");

          const thirdEvents = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, sessionId),
          );
          yield* connection.send({ sessionId, prompt: "third", attachments: [], tools: [] });
          expect(Array.from(yield* Fiber.join(thirdEvents)).at(-1)?.kind).toBe("completed");
          yield* connection.stop(sessionId);
        }),
      ),
    );

    expect(bodies).toEqual([
      chatBody([{ role: "user", content: "first" }]),
      chatBody([
        { role: "user", content: "first" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second" },
      ]),
      chatBody([
        { role: "user", content: "first" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second" },
        { role: "user", content: "third" },
      ]),
    ]);
    expect(runtimeRegistry.observedState(instanceId)).toMatchObject({
      observedProtocol: "chat-completions",
      models: [{ id: modelId, verification: "verified" }],
      capabilities: { streaming: "supported", usage: "supported" },
      processState: "stopped",
    });
  });

  it("broadcasts each event to multiple subscribers instead of destructively sharing a queue", async () => {
    const driver = makeDriver({ fetch: vi.fn(async () => chatStream("broadcast")) });

    const firstEvents = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const first = yield* Effect.fork(
            Stream.runCollect(
              (yield* connection.subscribe).pipe(
                Stream.filter((event) => event.sessionId === sessionId),
                Stream.take(1),
              ),
            ),
          );
          const second = yield* Effect.fork(
            Stream.runCollect(
              (yield* connection.subscribe).pipe(
                Stream.filter((event) => event.sessionId === sessionId),
                Stream.take(1),
              ),
            ),
          );
          yield* connection.send({ sessionId, prompt: "broadcast", attachments: [], tools: [] });
          return [Array.from(yield* Fiber.join(first)), Array.from(yield* Fiber.join(second))];
        }),
      ),
    );

    expect(firstEvents.map((events) => events.map(({ kind }) => kind))).toEqual([
      ["text-delta"],
      ["text-delta"],
    ]);
  });

  it("routes concurrent session streams independently through each terminal event", async () => {
    const driver = makeDriver({ fetch: vi.fn(async () => chatStream("answer")) });

    const [firstEvents, secondEvents] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          yield* connection.start({
            sessionId: otherSessionId,
            modelId,
            executionPolicy: "approval-gated",
          });
          const firstSubscribers = [
            yield* Effect.fork(firstSessionEvent(yield* connection.subscribe, sessionId)),
            yield* Effect.fork(firstSessionEvent(yield* connection.subscribe, sessionId)),
          ];
          const secondSubscribers = [
            yield* Effect.fork(firstSessionEvent(yield* connection.subscribe, otherSessionId)),
            yield* Effect.fork(firstSessionEvent(yield* connection.subscribe, otherSessionId)),
          ];
          const firstTerminal = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, sessionId),
          );
          const secondTerminal = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, otherSessionId),
          );
          yield* Effect.all([
            connection.send({ sessionId, prompt: "first", attachments: [], tools: [] }),
            connection.send({
              sessionId: otherSessionId,
              prompt: "second",
              attachments: [],
              tools: [],
            }),
          ]);
          for (const subscriber of firstSubscribers) {
            expect(Array.from(yield* Fiber.join(subscriber))).toMatchObject([
              { sessionId, kind: "text-delta" },
            ]);
          }
          for (const subscriber of secondSubscribers) {
            expect(Array.from(yield* Fiber.join(subscriber))).toMatchObject([
              { sessionId: otherSessionId, kind: "text-delta" },
            ]);
          }
          yield* Fiber.join(firstTerminal);
          yield* Fiber.join(secondTerminal);

          const first = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, sessionId),
          );
          const second = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, otherSessionId),
          );
          yield* Effect.all([
            connection.send({ sessionId, prompt: "first again", attachments: [], tools: [] }),
            connection.send({
              sessionId: otherSessionId,
              prompt: "second again",
              attachments: [],
              tools: [],
            }),
          ]);
          return [Array.from(yield* Fiber.join(first)), Array.from(yield* Fiber.join(second))];
        }),
      ),
    );

    for (const [events, expectedSessionId] of [
      [firstEvents, sessionId],
      [secondEvents, otherSessionId],
    ] as const) {
      expect(events.map(({ kind }) => kind)).toEqual(["text-delta", "usage", "completed"]);
      expect(new Set(events.map(({ sessionId }) => sessionId))).toEqual(
        new Set([expectedSessionId]),
      );
    }
  });

  it("does not append user input until the bounded request is constructable", async () => {
    let acceptedBody: { messages: Array<{ role: string; content: string }> } | undefined;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/models")) return new Response(null, { status: 404 });
      acceptedBody = JSON.parse(String(init?.body)) as typeof acceptedBody;
      return chatStream("accepted");
    });
    const driver = makeDriver({ fetch });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const rejected = yield* Effect.exit(
            connection.send({
              sessionId,
              prompt: "x".repeat(1_048_577),
              attachments: [],
              tools: [],
            }),
          );
          expect(String(rejected)).toContain("invalid-configuration");
          const accepted = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, sessionId),
          );
          yield* connection.send({ sessionId, prompt: "small", attachments: [], tools: [] });
          yield* Fiber.join(accepted);
          yield* connection.stop(sessionId);
        }),
      ),
    );

    expect(acceptedBody?.messages).toEqual([{ role: "user", content: "small" }]);
  });

  it("enforces one in-flight turn, orders abort before interrupted, and clears scope state", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/models")) return modelsResponse(url);
      requestSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            requestSignal?.addEventListener("abort", () => controller.error(new Error("secret")));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const driver = makeDriver({ fetch, runtimeRegistry });

    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const collected = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, sessionId),
          );
          yield* connection.send({ sessionId, prompt: "first", attachments: [], tools: [] });
          const duplicate = yield* Effect.exit(
            connection.send({ sessionId, prompt: "second", attachments: [], tools: [] }),
          );
          expect(String(duplicate)).toContain("protocol");
          yield* connection.interrupt(sessionId);
          expect(requestSignal?.aborted).toBe(true);
          // A cancel ends the turn but keeps the session live for the next send.
          expect(runtimeRegistry.activeSessionCount(instanceId)).toBe(1);
          return Array.from(yield* Fiber.join(collected));
        }),
      ),
    );
    expect(events.at(-1)).toMatchObject({ kind: "interrupted", sequence: 1 });
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
  });

  it("releases stopped and interrupted session history and credential closures", async () => {
    const credentialResolver: ProviderCredentialResolver = {
      has: vi.fn(async () => true),
      resolve: vi
        .fn<ProviderCredentialResolver["resolve"]>()
        .mockResolvedValueOnce("first-private-key")
        .mockResolvedValueOnce("second-private-key")
        .mockResolvedValueOnce("third-private-key")
        .mockResolvedValueOnce("fourth-private-key"),
    };
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    let hanging = false;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (hanging) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener("abort", () => controller.error(new Error("private")));
            },
          }),
        );
      }
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
      return chatStream("answer");
    });
    const driver = makeDriver({ credentialResolver, fetch });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const first = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, sessionId),
          );
          yield* connection.send({
            sessionId,
            prompt: "private stopped prompt",
            attachments: [],
            tools: [],
          });
          yield* Fiber.join(first);
          yield* connection.stop(sessionId);

          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const second = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, sessionId),
          );
          yield* connection.send({ sessionId, prompt: "fresh prompt", attachments: [], tools: [] });
          yield* Fiber.join(second);
          yield* connection.stop(sessionId);

          hanging = true;
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const interrupted = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, sessionId),
          );
          yield* connection.send({
            sessionId,
            prompt: "private interrupted prompt",
            attachments: [],
            tools: [],
          });
          yield* connection.interrupt(sessionId);
          expect(Array.from(yield* Fiber.join(interrupted)).at(-1)?.kind).toBe("interrupted");
          // The cancel kept the session live; release it before starting over.
          yield* connection.stop(sessionId);

          hanging = false;
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          yield* connection.stop(sessionId);
        }),
      ),
    );

    expect(bodies.map(({ messages }) => messages)).toEqual([
      [{ role: "user", content: "private stopped prompt" }],
      [{ role: "user", content: "fresh prompt" }],
    ]);
    expect(credentialResolver.resolve).toHaveBeenCalledTimes(4);
  });

  it("preflights only the cached protocol body in automatic mode", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    runtimeRegistry.setCompatibleProtocol(instanceId, "responses");
    const emptyResponseLength = JSON.stringify({
      model: modelId,
      input: [{ role: "user", content: "" }],
      stream: true,
      store: false,
      // The Responses body carries the session's prompt cache key.
      prompt_cache_key: String(sessionId),
    }).length;
    const prompt = "x".repeat(1_048_576 - emptyResponseLength);
    const fetch = vi.fn(async (_url: string | URL | Request) => responsesTextStream("accepted"));
    const driver = makeDriver({
      configuration: { ...configuration, protocol: "auto" },
      fetch,
      runtimeRegistry,
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const events = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, sessionId),
          );
          yield* connection.send({ sessionId, prompt, attachments: [], tools: [] });
          expect(Array.from(yield* Fiber.join(events)).at(-1)?.kind).toBe("completed");
          yield* connection.stop(sessionId);
        }),
      ),
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/\/responses$/);
  });

  it("refuses a resume cursor that names no saved conversation", async () => {
    const driver = makeDriver({ fetch: vi.fn(async (url) => modelsResponse(url)) });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          return yield* connection.resume({
            sessionId,
            resumeCursor: { driverKind: "openai-compatible", value: "never-started" },
            executionPolicy: "approval-gated",
          });
        }),
      ),
    );
    expect(String(exit)).toContain("stale-resume");
  });

  it("fails unsupported session operations honestly and stop emits no false completion", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const driver = makeDriver({
      fetch: vi.fn(async (url) => modelsResponse(url)),
      runtimeRegistry,
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          for (const operation of [
            connection.answerApproval({ sessionId, requestId: "request", approved: false }),
            connection.answerUserInput({ sessionId, requestId: "request", answer: "answer" }),
          ]) {
            const exit = yield* Effect.exit(operation);
            expect(String(exit)).toContain("unsupported");
          }
          yield* connection.stop(sessionId);
          expect(runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
        }),
      ),
    );
  });

  it("reports the quota buckets an accepted response disclosed in its headers", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/models")) return new Response(null, { status: 404 });
      return new Response(chatStream("answer").body, {
        headers: {
          "content-type": "text/event-stream",
          "x-ratelimit-limit-requests": "5000",
          "x-ratelimit-remaining-requests": "4990",
          "x-ratelimit-reset-requests": "6m0s",
          "x-ratelimit-limit-tokens": "800000",
          "x-ratelimit-remaining-tokens": "799000",
        },
      });
    });
    const driver = makeDriver({ fetch });

    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const collected = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, sessionId),
          );
          yield* connection.send({ sessionId, prompt: "limits", attachments: [], tools: [] });
          const value = Array.from(yield* Fiber.join(collected));
          yield* connection.stop(sessionId);
          return value;
        }),
      ),
    );

    expect(events.map((event) => event.kind)).toEqual([
      "text-delta",
      "usage",
      "rate-limit-bucket",
      "rate-limit-bucket",
      "completed",
    ]);
    expect(events[2]).toMatchObject({
      bucket: "requests",
      limit: 5000,
      remaining: 4990,
      resetsAt: expect.stringMatching(/Z$/),
    });
    expect(events[3]).toMatchObject({ bucket: "tokens", limit: 800_000, remaining: 799_000 });
    expect(events[3]).not.toHaveProperty("resetsAt");
    expect(
      events.every((event, index) => index === 0 || event.sequence > events[index - 1]!.sequence),
    ).toBe(true);
  });

  it("carries cache and reasoning tokens onto the runtime usage event", async () => {
    const driver = makeDriver({
      fetch: vi.fn(async () =>
        chatStream("cached answer", {
          prompt_tokens: 100,
          completion_tokens: 12,
          total_tokens: 112,
          prompt_tokens_details: { cached_tokens: 64 },
          completion_tokens_details: { reasoning_tokens: 5 },
        }),
      ),
    });

    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const collected = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, sessionId),
          );
          yield* connection.send({ sessionId, prompt: "cache", attachments: [], tools: [] });
          return Array.from(yield* Fiber.join(collected));
        }),
      ),
    );

    expect(events.find((event) => event.kind === "usage")).toMatchObject({
      inputTokens: 100,
      outputTokens: 12,
      cacheReadInputTokens: 64,
      reasoningTokens: 5,
    });
  });

  it("sends the harness session id as the Responses prompt cache key", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/models")) return new Response(null, { status: 404 });
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return responsesTextStream("answer");
    });
    const driver = makeDriver({
      configuration: { ...configuration, protocol: "responses" },
      fetch,
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const events = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, sessionId),
          );
          yield* connection.send({ sessionId, prompt: "hi", attachments: [], tools: [] });
          expect(Array.from(yield* Fiber.join(events)).at(-1)?.kind).toBe("completed");
          yield* connection.stop(sessionId);
        }),
      ),
    );

    expect(bodies[0]?.prompt_cache_key).toBe(String(sessionId));
  });

  it("does not let a responses token count reject a later request automatic mode may send as chat completions", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    runtimeRegistry.setCompatibleProtocol(instanceId, "responses");
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
          contextLimit: 200,
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
        harnessAutoReview: "unsupported",
        nativeAttachments: "unsupported",
        nativeWebResearch: "unsupported",
        appManagedTools: "supported",
        citations: "unsupported",
      },
      observedAt: "2026-07-15T12:00:00.000Z",
    });
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/responses")
        ? responsesTextStream("ok", {
            input_tokens: 10_000,
            output_tokens: 1,
            total_tokens: 10_001,
          })
        : chatStream("ok"),
    );
    const driver = makeDriver({
      configuration: { ...configuration, protocol: "auto" },
      fetch,
      runtimeRegistry,
    });

    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const first = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, sessionId),
          );
          yield* connection.send({ sessionId, prompt: "hi", attachments: [], tools: [] });
          expect(Array.from(yield* Fiber.join(first)).at(-1)?.kind).toBe("completed");
          const second = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, sessionId),
          );
          yield* connection.send({
            sessionId,
            prompt: "x".repeat(400),
            attachments: [],
            tools: [],
          });
          const followed = Array.from(yield* Fiber.join(second));
          yield* connection.stop(sessionId);
          return followed;
        }),
      ),
    );

    expect(events.at(-1)?.kind).toBe("completed");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("learns the window an overflow refusal names, keeps it, and sends a smaller request once", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    runtimeRegistry.setObservedState(observedManualModel());
    const remember = vi.fn();
    const bodies: Array<{ readonly messages: ReadonlyArray<unknown> }> = [];
    let refused = false;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/models")) return new Response(null, { status: 404 });
      const body = JSON.parse(String(init?.body)) as { readonly messages: ReadonlyArray<unknown> };
      bodies.push(body);
      if (bodies.length === 3 && !refused) {
        refused = true;
        return Response.json(
          {
            error: {
              code: "context_length_exceeded",
              message:
                "This model's maximum context length is 2048 tokens. However, your messages resulted in 3100 tokens.",
            },
          },
          { status: 400 },
        );
      }
      return chatStream("ok");
    });
    const driver = makeDriver({
      fetch,
      runtimeRegistry,
      contextWindows: { remember },
    });

    const outcomes = await runTurns(driver, ["a".repeat(6_000), "b".repeat(6_000), "next"]);

    // The person sees the turn answered, not the refusal.
    expect(outcomes).toEqual(["completed", "completed", "completed"]);
    expect(bodies).toHaveLength(4);
    expect(bodies[3]?.messages.length).toBeLessThan(bodies[2]?.messages.length ?? 0);
    expect(runtimeRegistry.observedState(instanceId)?.models[0]).toMatchObject({
      learnedContextWindow: 2_048,
    });
    expect(remember).toHaveBeenCalledWith(instanceId, modelId, { learnedContextWindow: 2_048 });
  });

  it("still recovers once and learns nothing from a refusal that names no window", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    runtimeRegistry.setObservedState(observedManualModel());
    const remember = vi.fn();
    let generations = 0;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/models")) return new Response(null, { status: 404 });
      generations += 1;
      if (generations === 3) {
        return Response.json(
          { error: { code: "context_length_exceeded", message: "too long" } },
          { status: 400 },
        );
      }
      return chatStream("ok");
    });
    const driver = makeDriver({ fetch, runtimeRegistry, contextWindows: { remember } });

    const outcomes = await runTurns(driver, ["a".repeat(600), "b".repeat(600), "next"]);

    expect(outcomes).toEqual(["completed", "completed", "completed"]);
    expect(generations).toBe(4);
    expect(runtimeRegistry.observedState(instanceId)?.models[0]?.learnedContextWindow).toBe(
      undefined,
    );
    expect(remember).not.toHaveBeenCalled();
  });

  it("records the model a deployment served and sizes the next request by its profile", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    runtimeRegistry.setObservedState(observedManualModel());
    const remember = vi.fn();
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/models")
        ? new Response(null, { status: 404 })
        : chatStream("ok", undefined, "DeepSeek-V4.1-Flash"),
    );
    const driver = makeDriver({ fetch, runtimeRegistry, contextWindows: { remember } });

    await runTurns(driver, ["hi"]);

    expect(runtimeRegistry.observedState(instanceId)?.models[0]).toMatchObject({
      servedModelId: "DeepSeek-V4.1-Flash",
    });
    expect(remember).toHaveBeenCalledWith(instanceId, modelId, {
      servedModelId: "DeepSeek-V4.1-Flash",
    });
    // A later probe rebuilds the model from the listing and keeps what was learned.
    await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    expect(runtimeRegistry.observedState(instanceId)?.models[0]).toMatchObject({
      servedModelId: "DeepSeek-V4.1-Flash",
    });
  });
});

function observedManualModel() {
  return {
    instanceId,
    readiness: "ready" as const,
    processState: "stopped" as const,
    models: [
      {
        id: modelId,
        displayName: "manual",
        source: "manual" as const,
        verification: "unverified" as const,
        reasoning: "unavailable" as const,
        inputModalities: ["text" as const],
        options: [],
      },
    ],
    capabilities: {
      streaming: "supported" as const,
      resume: "unsupported" as const,
      interruption: "supported" as const,
      approvals: "unsupported" as const,
      userQuestions: "unsupported" as const,
      reasoning: "unavailable" as const,
      usage: "supported" as const,
      toolActivity: "unsupported" as const,
      fileChanges: "unsupported" as const,
      diffs: "unsupported" as const,
      taskProgress: "unsupported" as const,
      nativeChildAgents: "unsupported" as const,
      harnessAutoReview: "unsupported" as const,
      nativeAttachments: "unsupported" as const,
      nativeWebResearch: "unsupported" as const,
      appManagedTools: "unsupported" as const,
      citations: "unsupported" as const,
    },
    observedAt: "2026-07-15T12:00:00.000Z",
  };
}

/** Sends each prompt as its own turn on one session and returns how each turn ended. */
function runTurns(
  driver: ReturnType<typeof makeDriver>,
  prompts: ReadonlyArray<string>,
): Promise<ReadonlyArray<string | undefined>> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
        yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
        const outcomes: Array<string | undefined> = [];
        for (const prompt of prompts) {
          const events = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, sessionId),
          );
          yield* connection.send({ sessionId, prompt, attachments: [], tools: [] });
          outcomes.push(Array.from(yield* Fiber.join(events)).at(-1)?.kind);
        }
        yield* connection.stop(sessionId);
        return outcomes;
      }),
    ),
  );
}

describe("makeOpenAiCompatibleDriver under the ChatGPT plan profile", () => {
  const planConfiguration: OpenAiCompatibleProviderConfiguration = {
    kind: "openai-compatible-http",
    baseUrl: "https://api.openai.com/v1",
    authentication: "bearer",
    protocol: "chat-completions",
    manualModelIds: [modelId],
    oauthDescriptorId: "chatgpt-plan",
  };

  function planDriver(options: {
    readonly fetch: CompatibleFetch;
    readonly protocol?: OpenAiCompatibleProviderConfiguration["protocol"];
    readonly manualModelIds?: ReadonlyArray<ProviderModelId>;
  }) {
    return makeOpenAiCompatibleDriver({
      instanceId,
      configuration: {
        ...planConfiguration,
        ...(options.protocol === undefined ? {} : { protocol: options.protocol }),
        ...(options.manualModelIds === undefined ? {} : { manualModelIds: options.manualModelIds }),
      },
      runtimeRegistry: new ProviderRuntimeRegistry(),
      credentialResolver: {
        has: async () => true,
        resolve: async () =>
          encodeSubscriptionOAuthCredential({
            kind: "subscription-oauth",
            credentialRef: "7c1e1d3f-1e4b-4051-8d2b-7f6e5d4c3b2a",
            descriptorId: "chatgpt-plan",
            accountLabel: "ChatGPT plan",
          }),
      },
      subscriptionOAuth: {
        refresh: async () => ({ kind: "refreshed" as const }),
        access: async () => ({
          kind: "granted" as const,
          accessToken: "plan-access-token",
          subscriptionUsageGranted: true,
        }),
      },
      fetch: options.fetch,
      clock: () => "2026-10-06T18:00:00.000Z",
    });
  }

  /**
   * Check connection exactly as the renderer sees it: the driver's probe
   * result, sent as JSON and decoded with the client's contract decoder.
   */
  async function checkPlanConnection(
    answer: Response,
    manualModelIds: ReadonlyArray<ProviderModelId> = [],
  ) {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return answer;
    });
    const either = await Effect.runPromise(
      Effect.either(Effect.scoped(planDriver({ fetch, manualModelIds }).probe({ instanceId }))),
    );
    const decoded = Either.isRight(either)
      ? decodeProviderProbeResult(JSON.parse(JSON.stringify(either.right)))
      : undefined;
    return { either, decoded, calls };
  }

  const planNotListedMessage =
    "Models can't be listed on the ChatGPT plan. Add the model IDs your plan offers under Manual model IDs, then check the connection again.";

  it("reports the plan's models from its own models listing, with display names and context windows", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { either, decoded, calls } = await checkPlanConnection(
      Response.json({
        models: [
          {
            slug: "gpt-plan-pro",
            display_name: "GPT Plan Pro",
            description: "Plan model",
            context_window: 272_000,
            default_reasoning_level: "medium",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
            visibility: "list",
            priority: 1,
          },
          { slug: "gpt-plan-mini", display_name: "GPT Plan Mini", context_window: "large" },
          { id: "gpt-plan-legacy", displayName: "Legacy", contextWindow: 128_000 },
          { name: "gpt-plan-named" },
          { display_name: "No identifier" },
          "not-an-item",
          { slug: " padded " },
          { slug: "gpt-plan-pro", display_name: "Duplicate" },
        ],
      }),
    );
    // Before the plan profile read this shape, the probe failed with a
    // protocol category and the renderer said "Provider returned an invalid
    // response."
    expect(Either.isRight(either)).toBe(true);
    expect(decoded).toMatchObject({
      readiness: "ready",
      credentialStatus: "stored",
      lastSuccessfulProbeAt: "2026-10-06T18:00:00.000Z",
    });
    expect(decoded?.message).toBeUndefined();
    expect(
      decoded?.models.map(({ id, displayName, contextLimit, source, verification }) => ({
        id,
        displayName,
        contextLimit,
        source,
        verification,
      })),
    ).toEqual([
      {
        id: "gpt-plan-pro",
        displayName: "GPT Plan Pro",
        contextLimit: 272_000,
        source: "discovered",
        verification: "verified",
      },
      {
        id: "gpt-plan-mini",
        displayName: "GPT Plan Mini",
        contextLimit: undefined,
        source: "discovered",
        verification: "verified",
      },
      {
        id: "gpt-plan-legacy",
        displayName: "Legacy",
        contextLimit: 128_000,
        source: "discovered",
        verification: "verified",
      },
      {
        id: "gpt-plan-named",
        displayName: "gpt-plan-named",
        contextLimit: undefined,
        source: "discovered",
        verification: "verified",
      },
    ]);
    expect(calls).toEqual([
      { url: "https://api.openai.com/v1/models", authorization: "Bearer plan-access-token" },
    ]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("stays degraded in words when none of the plan's listed items can be mapped, logging only their key names", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { either, decoded } = await checkPlanConnection(
      Response.json({ models: [{ label: "secret-label", tier: "secret-tier" }, { label: "x" }] }),
    );
    expect(Either.isRight(either)).toBe(true);
    expect(decoded).toMatchObject({
      readiness: "degraded",
      credentialStatus: "stored",
      models: [],
      message: planNotListedMessage,
      lastSuccessfulProbeAt: "2026-10-06T18:00:00.000Z",
    });
    // The diagnostic names the answer's shape and the first item's key
    // names, and never a value or the bearer.
    expect(warn).toHaveBeenCalledWith("[provider] models route did not list models", {
      instanceId,
      httpStatus: 200,
      contentType: "application/json",
      shape: "{models}",
      firstItemKeys: ["label", "tier"],
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("plan-access-token");
    warn.mockRestore();
  });

  it("reports the same honest state for a non-JSON answer, an OpenAI-shaped 404, a route refusal, and a missing model-read scope", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const answers = [
      new Response("<html>ChatGPT</html>", { headers: { "content-type": "text/html" } }),
      Response.json(
        {
          error: {
            message: "Invalid URL (GET /v1/models)",
            type: "invalid_request_error",
            param: null,
            code: null,
          },
        },
        { status: 404 },
      ),
      Response.json(
        { error: { code: "subscription_sharing_route_not_supported", message: "no" } },
        { status: 400 },
      ),
      Response.json(
        {
          error: {
            message:
              "You have insufficient permissions for this operation. Missing scopes: api.model.read.",
            type: "invalid_request_error",
            param: null,
            code: null,
          },
        },
        { status: 401 },
      ),
    ];
    for (const answer of answers) {
      const { decoded } = await checkPlanConnection(answer);
      expect(decoded).toMatchObject({
        readiness: "degraded",
        models: [],
        message: planNotListedMessage,
      });
    }
    warn.mockRestore();
  });

  it("keeps the person's manual model IDs usable when the plan cannot list models", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { decoded } = await checkPlanConnection(
      Response.json(
        { error: { message: "Forbidden", type: "invalid_request_error" } },
        { status: 403 },
      ),
      ["plan-model" as ProviderModelId],
    );
    expect(decoded).toMatchObject({
      readiness: "degraded",
      models: [{ id: "plan-model", source: "manual", verification: "unverified" }],
      message: "Models can't be listed on the ChatGPT plan; Octant uses your manual model IDs.",
    });
    warn.mockRestore();
  });

  it("reports the plan's listed models, and says so when it lists none", async () => {
    const listed = await checkPlanConnection(
      Response.json({ object: "list", data: [{ id: "plan-model", object: "model" }] }),
    );
    expect(listed.decoded).toMatchObject({
      readiness: "ready",
      models: [{ id: "plan-model", source: "discovered", verification: "verified" }],
    });
    expect(listed.decoded?.message).toBeUndefined();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const empty = await checkPlanConnection(Response.json({ object: "list", data: [] }));
    expect(empty.decoded).toMatchObject({
      readiness: "degraded",
      models: [],
      message:
        "The ChatGPT plan listed no models. Add the model IDs your plan offers under Manual model IDs, then check the connection again.",
    });
    warn.mockRestore();
  });

  it("still fails Check connection with the typed state for a rejected sign-in or a reached usage limit", async () => {
    const rejected = await checkPlanConnection(
      Response.json(
        {
          error: {
            message: "Incorrect API key provided.",
            type: "invalid_request_error",
            param: null,
            code: "invalid_api_key",
          },
        },
        { status: 401 },
      ),
    );
    expect(Either.isLeft(rejected.either)).toBe(true);
    if (Either.isRight(rejected.either)) throw new Error("expected a typed failure");
    expect(rejected.either.left.category).toBe("unauthenticated");

    const limited = await checkPlanConnection(
      Response.json(
        { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } },
        { status: 429 },
      ),
    );
    expect(Either.isLeft(limited.either)).toBe(true);
    if (Either.isRight(limited.either)) throw new Error("expected a typed failure");
    expect(limited.either.left.category).toBe("rate-limited");
    expect(limited.either.left.message).toContain("https://chatgpt.com/settings/usage");
  });

  it("runs a Responses turn on a manual model after the plan could not list models", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return String(url).endsWith("/models")
        ? Response.json({ models: [{ label: "unmappable" }] })
        : responsesTextStream("plan answer");
    });
    const driver = planDriver({ fetch, protocol: "responses" });
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const probe = yield* driver.probe({ instanceId });
          expect(probe.models.map((model) => model.id)).toEqual([modelId]);
          const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp/project" });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const collected = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, sessionId),
          );
          yield* connection.send({ sessionId, prompt: "first", attachments: [], tools: [] });
          return Array.from(yield* Fiber.join(collected));
        }),
      ),
    );
    expect(events.at(-1)?.kind).toBe("completed");
    expect(calls).toEqual([
      "https://api.openai.com/v1/models",
      "https://api.openai.com/v1/responses",
    ]);
    warn.mockRestore();
  });

  it("refuses a turn before any request when the plan profile is bound to chat-completions", async () => {
    const fetch = vi.fn(async () => modelsResponse("x"));
    const driver = planDriver({ fetch });

    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({
            instanceId,
            projectRoot: "/tmp/project",
          });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const collected = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, sessionId),
          );
          yield* connection.send({ sessionId, prompt: "first", attachments: [], tools: [] });
          return Array.from(yield* Fiber.join(collected));
        }),
      ),
    );
    const failed = events.find((event) => event.kind === "failed");
    expect(failed).toBeDefined();
    if (failed === undefined || failed.kind !== "failed") throw new Error("expected a failure");
    expect(failed.failure.category).toBe("unsupported");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not fall back to chat-completions from responses under the plan profile", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ error: { code: "not_found", message: "no route" } }), {
        status: 404,
      });
    });
    const driver = planDriver({ fetch, protocol: "auto" });

    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({
            instanceId,
            projectRoot: "/tmp/project",
          });
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const collected = yield* Effect.fork(
            collectSessionEvents(yield* connection.subscribe, sessionId),
          );
          yield* connection.send({ sessionId, prompt: "first", attachments: [], tools: [] });
          return Array.from(yield* Fiber.join(collected));
        }),
      ),
    );
    const failed = events.find((event) => event.kind === "failed");
    expect(failed).toBeDefined();
    if (failed === undefined || failed.kind !== "failed") throw new Error("expected a failure");
    // The fallback the auto protocol would otherwise permit is refused with
    // the plan's typed reason, and no chat-completions request left the
    // process — only the one Responses request was sent.
    expect(failed.failure.category).toBe("unsupported");
    expect(failed.failure.message).toContain("Responses API");
    expect(calls.filter((url) => url.endsWith("/chat/completions"))).toEqual([]);
    expect(calls.filter((url) => url.endsWith("/responses"))).toHaveLength(1);
  });

  it("refuses to verify tool support over chat-completions under the plan profile", async () => {
    const fetch = vi.fn(async () => modelsResponse("x"));
    const driver = planDriver({ fetch });
    if (driver.verifyToolCapability === undefined) {
      throw new Error("expected the driver to verify tool capability");
    }

    const either = await Effect.runPromise(
      Effect.either(Effect.scoped(driver.verifyToolCapability({ instanceId, modelId }))),
    );
    expect(Either.isLeft(either)).toBe(true);
    if (Either.isRight(either)) throw new Error("expected a typed provider failure");
    expect(either.left.category).toBe("unsupported");
    expect(either.left.message).toContain("Responses API");
    expect(fetch).not.toHaveBeenCalled();
  });
});

function makeDriver(options: {
  readonly configuration?: OpenAiCompatibleProviderConfiguration;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly fetch: CompatibleFetch;
  readonly runtimeRegistry?: ProviderRuntimeRegistry;
  readonly contextWindows?: ModelContextWindowMemory;
}) {
  const runtimeRegistry = options.runtimeRegistry ?? new ProviderRuntimeRegistry();
  const driver = makeOpenAiCompatibleDriver({
    instanceId,
    ...(options.contextWindows === undefined
      ? {}
      : { harness: { contextWindows: options.contextWindows } }),
    configuration: options.configuration ?? configuration,
    credentialResolver: options.credentialResolver ?? resolver(),
    fetch: options.fetch,
    runtimeRegistry,
    clock: () => "2026-07-15T12:00:00.000Z",
    correlationId: () => "80000000-0000-4000-8000-000000000503",
  });
  return driver;
}

function resolver(): ProviderCredentialResolver {
  return { has: vi.fn(async () => true), resolve: vi.fn(async () => "private-key") };
}

function modelsResponse(_url: string | URL | Request): Response {
  return Response.json({ data: [{ id: "discovered-model" }] });
}

function chatStream(
  text: string,
  usage: Record<string, unknown> = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  servedModel?: string,
): Response {
  const served = servedModel === undefined ? {} : { model: servedModel };
  const chunks = [
    { ...chatChunk({ role: "assistant", content: text }), ...served },
    { ...chatChunk({}, "stop"), ...served },
    {
      id: "chatcmpl_private",
      object: "chat.completion.chunk",
      choices: [],
      usage,
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

function chatChunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: "chatcmpl_private",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    usage: null,
  };
}

function chatBody(messages: readonly unknown[]) {
  return {
    model: modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
}

function collectSessionEvents(
  events: import("effect").Stream.Stream<ProviderRuntimeEvent, ProviderFailure>,
  expectedSessionId: typeof sessionId,
) {
  return Stream.runCollect(
    events.pipe(
      Stream.filter((event) => event.sessionId === expectedSessionId),
      Stream.takeUntil(isTerminalEvent),
    ),
  );
}

function firstSessionEvent(
  events: import("effect").Stream.Stream<ProviderRuntimeEvent, ProviderFailure>,
  expectedSessionId: typeof sessionId,
) {
  return Stream.runCollect(
    events.pipe(
      Stream.filter((event) => event.sessionId === expectedSessionId),
      Stream.take(1),
    ),
  );
}

function isTerminalEvent(event: ProviderRuntimeEvent) {
  return event.kind === "completed" || event.kind === "interrupted" || event.kind === "failed";
}

function responsesTextStream(
  text: string,
  usage: { input_tokens: number; output_tokens: number; total_tokens: number } = {
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
  },
): Response {
  const response = (status: "in_progress" | "completed", usage: unknown = null) => ({
    id: "resp_private",
    object: "response",
    status,
    usage,
  });
  const events = [
    { type: "response.created", sequence_number: 1, response: response("in_progress") },
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
      delta: text,
      logprobs: [],
    },
    {
      type: "response.output_text.done",
      sequence_number: 4,
      item_id: "msg_private",
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
        id: "msg_private",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      sequence_number: 6,
      response: response("completed", usage),
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
