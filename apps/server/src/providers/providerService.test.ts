import {
  decodeProviderCatalogSnapshot,
  decodeProviderInstance,
  decodeProviderInstanceId,
  decodeProviderModel,
  decodeProviderModelId,
  decodeProviderObservedState,
  decodeWindowId,
  type ProviderDefaults,
  type ProviderCatalogSnapshot,
  type ProviderInstance,
} from "@octant/contracts";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Effect, Queue, Stream } from "effect";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import type { PersistenceService } from "../persistence/persistenceService";
import { ProviderDriverConfigurationError } from "./providerDriverFactory";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";
import {
  ProviderService,
  runPackagedProviderSmokeTurn,
  type ProviderServiceOptions,
} from "./providerService";

const windowId = decodeWindowId("80000000-0000-4000-8000-000000000010");
const otherWindowId = decodeWindowId("80000000-0000-4000-8000-000000000013");
const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000011");
const otherId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000012");
const now = "2026-07-14T10:00:00.000Z";
const capabilities = {
  streaming: "supported",
  resume: "supported",
  interruption: "supported",
  approvals: "supported",
  userQuestions: "supported",
  reasoning: "supported",
  usage: "supported",
  toolActivity: "supported",
  fileChanges: "supported",
  diffs: "supported",
  taskProgress: "supported",
  nativeChildAgents: "supported",
  nativeAttachments: "supported",
  nativeWebResearch: "supported",
  appManagedTools: "supported",
  citations: "supported",
} as const;

describe("ProviderService", () => {
  it("consumes a single-queue smoke event stream exactly once", async () => {
    const sessionId = "80000000-0000-4000-8000-000000000023";
    const queue = Effect.runSync(Queue.unbounded<never>());
    let subscriptions = 0;
    const answerApproval = vi.fn(() => Effect.void);
    const connection = {
      subscribe: Effect.sync(() => {
        subscriptions += 1;
        return Stream.fromQueue(queue);
      }),
      start: () => Effect.succeed({ sessionId }) as never,
      send: () =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, {
            kind: "approval-request",
            sessionId,
            requestId: "approval-queue",
            action: "write",
            description: "Queue-owned request",
          } as never);
          yield* Queue.offer(queue, { kind: "completed", sessionId } as never);
        }),
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval,
      answerUserInput: () => Effect.void,
    } as never;

    await expect(
      runPackagedProviderSmokeTurn(
        { acquire: () => Effect.succeed(connection) } as never,
        {
          instanceId,
          sessionId: sessionId as never,
          modelId: "model-a" as never,
          prompt: "single consumer",
          action: "answer-approval",
          approved: false,
        },
        { timeoutMs: 100 },
      ),
    ).resolves.toMatchObject({ events: [{ kind: "approval-request" }, { kind: "completed" }] });
    expect(subscriptions).toBe(1);
    expect(answerApproval).toHaveBeenCalledOnce();
  });

  it.each(["success", "acquire-failure", "start-failure", "timeout"] as const)(
    "uses a unique canonical isolated smoke root and cleans it after %s",
    async (outcome) => {
      const roots: string[] = [];
      const canonicalRootsAtAcquire: string[] = [];
      const sessionId = "80000000-0000-4000-8000-000000000024";
      const connection = {
        subscribe: Effect.succeed(
          outcome === "timeout"
            ? Stream.never
            : Stream.fromIterable([{ kind: "completed", sessionId }] as never),
        ),
        start: () =>
          outcome === "start-failure"
            ? Effect.fail({ category: "provider-failed", message: "start failed" })
            : (Effect.succeed({ sessionId }) as never),
        send: () => Effect.void,
        interrupt: () => Effect.void,
        stop: () => Effect.void,
        answerApproval: () => Effect.void,
        answerUserInput: () => Effect.void,
      } as never;
      const driver = {
        acquire: ({ projectRoot }: { readonly projectRoot: string }) => {
          roots.push(projectRoot);
          canonicalRootsAtAcquire.push(realpathSync(projectRoot));
          return outcome === "acquire-failure"
            ? Effect.fail({ category: "provider-failed", message: "acquire failed" })
            : Effect.succeed(connection);
        },
      } as never;
      const run = runPackagedProviderSmokeTurn(
        driver,
        {
          instanceId,
          sessionId: sessionId as never,
          modelId: "model-a" as never,
          prompt: "isolated root",
          action: "complete",
        },
        { timeoutMs: 25 },
      );

      if (outcome === "success") await expect(run).resolves.toBeDefined();
      else await expect(run).rejects.toBeDefined();
      expect(roots).toHaveLength(1);
      expect(roots[0]).toBe(canonicalRootsAtAcquire[0]);
      expect(dirname(roots[0]!)).toBe(realpathSync(tmpdir()));
      expect(basename(roots[0]!)).toMatch(/^octant-provider-smoke-/);
      expect(roots[0]).not.toBe(realpathSync(tmpdir()));
      expect(existsSync(roots[0]!)).toBe(false);
    },
  );

  it("creates a different isolated smoke root for every run", async () => {
    const roots: string[] = [];
    const sessionId = "80000000-0000-4000-8000-000000000025";
    const connection = {
      subscribe: Effect.succeed(Stream.fromIterable([{ kind: "completed", sessionId }] as never)),
      start: () => Effect.succeed({ sessionId }) as never,
      send: () => Effect.void,
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
    } as never;
    const driver = {
      acquire: ({ projectRoot }: { readonly projectRoot: string }) => {
        roots.push(projectRoot);
        return Effect.succeed(connection);
      },
    } as never;
    const input = {
      instanceId,
      sessionId: sessionId as never,
      modelId: "model-a" as never,
      prompt: "unique root",
      action: "complete" as const,
    };

    await runPackagedProviderSmokeTurn(driver, input);
    await runPackagedProviderSmokeTurn(driver, input);

    expect(new Set(roots).size).toBe(2);
    expect(roots.every((root) => !existsSync(root))).toBe(true);
  });

  it("forwards an explicit product mode and execution policy to the packaged smoke session", async () => {
    const sessionId = "80000000-0000-4000-8000-000000000026";
    const start = vi.fn(() => Effect.succeed({ sessionId }) as never);
    const acquire = vi.fn(() =>
      Effect.succeed({
        subscribe: Effect.succeed(Stream.fromIterable([{ kind: "completed", sessionId }] as never)),
        start,
        send: () => Effect.void,
        interrupt: () => Effect.void,
        stop: () => Effect.void,
        answerApproval: () => Effect.void,
        answerUserInput: () => Effect.void,
      } as never),
    );

    await runPackagedProviderSmokeTurn({ acquire } as never, {
      instanceId,
      sessionId: sessionId as never,
      modelId: "model-a" as never,
      prompt: "bounded plan smoke",
      action: "complete",
      mode: "code",
      executionPolicy: "plan",
    });

    expect(acquire).toHaveBeenCalledWith({
      instanceId,
      projectRoot: expect.stringMatching(/^\/.*octant-provider-smoke-/),
      mode: "code",
    });
    expect(start).toHaveBeenCalledWith({
      sessionId,
      modelId: "model-a",
      executionPolicy: "plan",
    });
  });

  it("runs complete and accepted-output cancellation through the configured driver", async () => {
    const calls: string[] = [];
    const events = [
      { kind: "text-delta", text: "one", sessionId: "80000000-0000-4000-8000-000000000014" },
      { kind: "text-delta", text: "two", sessionId: "80000000-0000-4000-8000-000000000014" },
      {
        kind: "usage",
        inputTokens: 1,
        outputTokens: 2,
        sessionId: "80000000-0000-4000-8000-000000000014",
      },
      { kind: "completed", sessionId: "80000000-0000-4000-8000-000000000014" },
    ] as never;
    const connection = {
      subscribe: Effect.succeed(Stream.fromIterable(events)),
      start: () => Effect.sync(() => void calls.push("start")) as never,
      send: () => Effect.sync(() => void calls.push("send")) as never,
      interrupt: () => Effect.sync(() => void calls.push("interrupt")) as never,
      stop: () => Effect.sync(() => void calls.push("stop")) as never,
    } as never;
    const driver = { acquire: () => Effect.succeed(connection) } as never;

    await expect(
      runPackagedProviderSmokeTurn(driver, {
        instanceId,
        sessionId: "80000000-0000-4000-8000-000000000014" as never,
        modelId: "model-a" as never,
        prompt: "complete",
        action: "complete",
      }),
    ).resolves.toMatchObject({ events });
    expect(calls).toEqual(["start", "send", "stop"]);

    calls.length = 0;
    const cancelledEvents = [
      { kind: "text-delta", text: "accepted", sessionId: "80000000-0000-4000-8000-000000000015" },
      { kind: "interrupted", sessionId: "80000000-0000-4000-8000-000000000015" },
    ] as never;
    const cancelledConnection = {
      ...(connection as unknown as Record<string, unknown>),
      subscribe: Effect.succeed(Stream.fromIterable(cancelledEvents)),
    };
    await expect(
      runPackagedProviderSmokeTurn(
        { acquire: () => Effect.succeed(cancelledConnection) } as never,
        {
          instanceId,
          sessionId: "80000000-0000-4000-8000-000000000015" as never,
          modelId: "model-a" as never,
          prompt: "cancel",
          action: "cancel-after-output",
        },
      ),
    ).resolves.toMatchObject({ events: cancelledEvents });
    expect(calls).toEqual(["start", "send", "interrupt", "stop"]);
  });

  it.each([
    {
      action: "answer-approval" as const,
      request: {
        kind: "approval-request",
        requestId: "approval-1",
        action: "write",
        description: "Write a smoke-owned file",
      },
      input: { approved: false },
      expected: {
        kind: "approval",
        value: {
          sessionId: "80000000-0000-4000-8000-000000000016",
          requestId: "approval-1",
          approved: false,
        },
      },
    },
    {
      action: "answer-question" as const,
      request: {
        kind: "user-input-request",
        requestId: "question-1",
        prompt: "Choose a smoke answer",
        options: ["bounded"],
      },
      input: { answer: "bounded" },
      expected: {
        kind: "question",
        value: {
          sessionId: "80000000-0000-4000-8000-000000000016",
          requestId: "question-1",
          answer: "bounded",
        },
      },
    },
  ])("correlates the exact normalized request for $action", async (scenario) => {
    const sessionId = "80000000-0000-4000-8000-000000000016";
    const answers: unknown[] = [];
    const events = [
      { ...scenario.request, sessionId },
      { kind: "completed", sessionId },
    ] as never;
    const connection = {
      subscribe: Effect.succeed(Stream.fromIterable(events)),
      start: () => Effect.succeed({ sessionId }) as never,
      send: () => Effect.void,
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: (value: unknown) =>
        Effect.sync(() => void answers.push({ kind: "approval", value })) as never,
      answerUserInput: (value: unknown) =>
        Effect.sync(() => void answers.push({ kind: "question", value })) as never,
    } as never;

    await expect(
      runPackagedProviderSmokeTurn(
        { acquire: () => Effect.succeed(connection) } as never,
        {
          instanceId,
          sessionId: sessionId as never,
          modelId: "model-a" as never,
          prompt: "request bounded input",
          action: scenario.action,
          ...scenario.input,
        } as never,
      ),
    ).resolves.toMatchObject({ events });
    expect(answers).toEqual([scenario.expected]);
  });

  it("runs bounded smoke through any enabled configured driver", async () => {
    const fixture = serviceFixture({ instances: [claudeProvider()] });
    fixture.runtime.setObservedState(observation());
    const sessionId = "80000000-0000-4000-8000-000000000017";
    const connection = {
      subscribe: Effect.succeed(Stream.fromIterable([{ kind: "completed", sessionId }] as never)),
      start: () => Effect.succeed({ sessionId }) as never,
      send: () => Effect.void,
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
    } as never;
    const acquire = vi.fn(() => Effect.succeed(connection));
    const service = new ProviderService({
      persistence: fixture.persistence,
      runtimeRegistry: fixture.runtime,
      driver: () => ({ kind: "claude", probe: () => Effect.die("unused"), acquire }),
      uuid: () => crypto.randomUUID(),
      clock: () => now,
    });

    await expect(
      service.smokeTurn(windowId, instanceId, {
        sessionId: sessionId as never,
        modelId: "model-a" as never,
        prompt: "complete smoke-owned work",
        action: "complete",
      }),
    ).resolves.toMatchObject({ events: [{ kind: "completed", sessionId }] });
    expect(acquire).toHaveBeenCalledOnce();
  });

  it("rejects smoke for a disabled provider before driver acquisition", async () => {
    const fixture = serviceFixture({ instances: [claudeProvider({ enabled: false })] });
    const acquire = vi.fn();
    const service = new ProviderService({
      persistence: fixture.persistence,
      runtimeRegistry: fixture.runtime,
      driver: () => ({ kind: "claude", probe: () => Effect.die("unused"), acquire }) as never,
      uuid: () => crypto.randomUUID(),
      clock: () => now,
    });

    await expect(
      service.smokeTurn(windowId, instanceId, {
        sessionId: "80000000-0000-4000-8000-000000000020" as never,
        modelId: "model-a" as never,
        prompt: "must stay disabled",
        action: "complete",
      }),
    ).rejects.toThrow(/requires an enabled provider/);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("rejects ambiguous duplicate normalized smoke requests", async () => {
    const sessionId = "80000000-0000-4000-8000-000000000021";
    const answerApproval = vi.fn(() => Effect.void);
    const events = Stream.fromIterable([
      {
        kind: "approval-request",
        sessionId,
        requestId: "approval-1",
        action: "write",
        description: "First request",
      },
      {
        kind: "approval-request",
        sessionId,
        requestId: "approval-2",
        action: "write",
        description: "Ambiguous request",
      },
      { kind: "completed", sessionId },
    ] as never);
    const connection = {
      subscribe: Effect.succeed(events),
      start: () => Effect.succeed({ sessionId }) as never,
      send: () => Effect.void,
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval,
      answerUserInput: () => Effect.void,
    } as never;

    await expect(
      runPackagedProviderSmokeTurn({ acquire: () => Effect.succeed(connection) } as never, {
        instanceId,
        sessionId: sessionId as never,
        modelId: "model-a" as never,
        prompt: "reject ambiguity",
        action: "answer-approval",
        approved: false,
      }),
    ).rejects.toThrow(/exactly one matching normalized request/);
    expect(answerApproval).toHaveBeenCalledOnce();
  });

  it("rejects a mismatched normalized smoke request kind", async () => {
    const sessionId = "80000000-0000-4000-8000-000000000022";
    const connection = {
      subscribe: Effect.succeed(
        Stream.fromIterable([
          {
            kind: "user-input-request",
            sessionId,
            requestId: "question-1",
            prompt: "Wrong request kind",
            options: [],
          },
          { kind: "completed", sessionId },
        ] as never),
      ),
      start: () => Effect.succeed({ sessionId }) as never,
      send: () => Effect.void,
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
    } as never;

    await expect(
      runPackagedProviderSmokeTurn({ acquire: () => Effect.succeed(connection) } as never, {
        instanceId,
        sessionId: sessionId as never,
        modelId: "model-a" as never,
        prompt: "reject mismatch",
        action: "answer-approval",
        approved: false,
      }),
    ).rejects.toThrow(/no matching normalized request/);
  });

  it("stops the smoke session when a turn fails after start", async () => {
    const stop = vi.fn(() => Effect.void);
    const sessionId = "80000000-0000-4000-8000-000000000018";
    const connection = {
      subscribe: Effect.succeed(Stream.never),
      start: () => Effect.succeed({ sessionId }) as never,
      send: () =>
        Effect.fail({ category: "provider-failed", message: "sanitized smoke failure" }) as never,
      interrupt: () => Effect.void,
      stop,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
    } as never;

    await expect(
      runPackagedProviderSmokeTurn({ acquire: () => Effect.succeed(connection) } as never, {
        instanceId,
        sessionId: sessionId as never,
        modelId: "model-a" as never,
        prompt: "fail safely",
        action: "complete",
      }),
    ).rejects.toThrow(/sanitized smoke failure/);
    expect(stop).toHaveBeenCalledWith(sessionId);
  });

  it("bounds collected smoke events and requires a terminal outcome", async () => {
    const sessionId = "80000000-0000-4000-8000-000000000019";
    const stop = vi.fn(() => Effect.void);
    const connection = {
      subscribe: Effect.succeed(
        Stream.fromIterable(
          ["one", "two", "three"].map((text) => ({ kind: "text-delta", sessionId, text })) as never,
        ),
      ),
      start: () => Effect.succeed({ sessionId }) as never,
      send: () => Effect.void,
      interrupt: () => Effect.void,
      stop,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
    } as never;

    await expect(
      runPackagedProviderSmokeTurn(
        { acquire: () => Effect.succeed(connection) } as never,
        {
          instanceId,
          sessionId: sessionId as never,
          modelId: "model-a" as never,
          prompt: "bounded events",
          action: "complete",
        },
        { maxEvents: 2, timeoutMs: 1_000 },
      ),
    ).rejects.toThrow(/bounded terminal event sequence/);
    expect(stop).toHaveBeenCalledWith(sessionId);
  });
  it("combines durable registry state with ephemeral observations", async () => {
    const fixture = serviceFixture({ instances: [provider()] });
    const observed = observation();
    fixture.runtime.setObservedState(observed);
    await expect(fixture.service.bootstrap(windowId)).resolves.toEqual({
      instances: [provider()],
      defaults: { permissionPersistence: "current-session", version: 0 },
      observedStates: [observed],
    });
    expect(fixture.append).not.toHaveBeenCalled();
  });

  it("keeps Settings instances but contributes no models, tools, or capabilities when the driver plugin is not effective", async () => {
    const fixture = serviceFixture({
      instances: [provider()],
      withCatalogPersistence: true,
      initialCatalog: persistedCatalog(),
      isDriverPluginEffective: (driverKind) => driverKind !== "opencode",
    });
    fixture.runtime.setObservedState(observation());
    await expect(fixture.service.bootstrap(windowId)).resolves.toEqual({
      instances: [provider()],
      defaults: { permissionPersistence: "current-session", version: 0 },
      observedStates: [
        {
          instanceId,
          readiness: "unavailable",
          processState: "stopped",
          models: [],
          capabilities: {
            streaming: "unavailable",
            resume: "unavailable",
            interruption: "unavailable",
            approvals: "unavailable",
            userQuestions: "unavailable",
            reasoning: "unavailable",
            usage: "unavailable",
            toolActivity: "unavailable",
            fileChanges: "unavailable",
            diffs: "unavailable",
            taskProgress: "unavailable",
            nativeChildAgents: "unavailable",
            nativeAttachments: "unavailable",
            nativeWebResearch: "unavailable",
            appManagedTools: "unavailable",
            citations: "unavailable",
          },
          message: "This provider driver is not available.",
          observedAt: now,
        },
      ],
    });
  });

  it("refuses to probe or create a provider whose driver plugin is not effective", async () => {
    const fixture = serviceFixture({
      instances: [provider()],
      isDriverPluginEffective: () => false,
    });
    await expect(fixture.service.probe(windowId, instanceId)).rejects.toThrow(/not available/);
    expect(fixture.probe).not.toHaveBeenCalled();

    const createFixture = serviceFixture({
      isDriverPluginEffective: () => false,
    });
    await expect(
      createFixture.service.execute(windowId, {
        kind: "create-opencode-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "OpenCode local",
        binaryPath: "/opt/homebrew/bin/opencode",
      }),
    ).rejects.toThrow(/not available/);
    expect(createFixture.append).not.toHaveBeenCalled();
  });

  it("still journals an image profile when vendor-driver plugins are not effective", async () => {
    const fixture = serviceFixture({
      isDriverPluginEffective: () => false,
    });
    await expect(
      fixture.service.execute(windowId, {
        kind: "create-openai-image-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "GPT Image",
        configuration: {
          kind: "openai-image-http",
          modelAllowlist: ["gpt-image-2"],
          defaultModel: "gpt-image-2",
        },
      }),
    ).resolves.toMatchObject({
      kind: "provider-created",
      instance: { driverKind: "openai-image", displayName: "GPT Image" },
    });
    expect(fixture.append).toHaveBeenCalled();
  });

  it("creates providers with optimistic versions and unique active names", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.execute(windowId, {
        kind: "create-opencode-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "OpenCode local",
        binaryPath: "/opt/homebrew/bin/opencode",
      }),
    ).resolves.toMatchObject({
      kind: "provider-created",
      instance: { displayName: "OpenCode local", version: 1 },
    });
    expect(fixture.append).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregate: { aggregateType: "provider-instance", aggregateId: instanceId },
        expectedVersion: 0,
        events: [expect.objectContaining({ eventName: "provider.instance-created@1" })],
      }),
    );
    await expect(
      fixture.service.execute(windowId, {
        kind: "create-opencode-provider",
        instanceId: otherId,
        expectedVersion: 0,
        displayName: "opencode LOCAL",
        binaryPath: "/usr/local/bin/opencode",
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid-configuration" } });
  });

  it("creates normalized OpenAI-compatible providers with optimistic versions", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.execute(windowId, {
        kind: "create-openai-compatible-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "Private gateway",
        configuration: {
          kind: "openai-compatible-http",
          baseUrl: "https://gateway.example/v1",
          authentication: "bearer",
          protocol: "auto",
          manualModelIds: ["model-a"],
        },
      }),
    ).resolves.toMatchObject({
      kind: "provider-created",
      instance: {
        displayName: "Private gateway",
        driverKind: "openai-compatible",
        configuration: {
          baseUrl: "https://gateway.example/v1/",
          manualModelIds: ["model-a"],
        },
        version: 1,
      },
    });
    expect(fixture.append).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregate: { aggregateType: "provider-instance", aggregateId: instanceId },
        expectedVersion: 0,
        events: [expect.objectContaining({ eventName: "provider.instance-created@1" })],
      }),
    );
  });

  it("creates and updates an OpenAI image profile through the journal", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.execute(windowId, {
        kind: "create-openai-image-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "GPT Image",
        configuration: {
          kind: "openai-image-http",
          modelAllowlist: ["gpt-image-2", "gpt-image-1"],
          defaultModel: "gpt-image-2",
          quality: "high",
        },
      }),
    ).resolves.toMatchObject({
      kind: "provider-created",
      instance: {
        displayName: "GPT Image",
        driverKind: "openai-image",
        configuration: {
          kind: "openai-image-http",
          modelAllowlist: ["gpt-image-2", "gpt-image-1"],
          defaultModel: "gpt-image-2",
          quality: "high",
        },
        version: 1,
      },
    });
    await expect(
      fixture.service.execute(windowId, {
        kind: "change-openai-image-configuration",
        instanceId,
        expectedVersion: 1,
        configuration: {
          kind: "openai-image-http",
          modelAllowlist: ["gpt-image-1"],
          defaultModel: "gpt-image-1",
        },
      }),
    ).resolves.toMatchObject({
      kind: "provider-updated",
      instance: {
        driverKind: "openai-image",
        configuration: {
          modelAllowlist: ["gpt-image-1"],
          defaultModel: "gpt-image-1",
        },
        version: 2,
      },
    });
    await expect(
      fixture.service.execute(windowId, {
        kind: "remove-provider",
        instanceId,
        expectedVersion: 2,
      }),
    ).resolves.toMatchObject({ kind: "provider-removed", instanceId, version: 3 });
  });

  it("creates and updates a Gemini image profile through the journal", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.execute(windowId, {
        kind: "create-gemini-native-image-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "Gemini Image",
        configuration: {
          kind: "gemini-native-image-http",
          modelAllowlist: ["gemini-3.1-flash-image"],
          defaultModel: "gemini-3.1-flash-image",
          aspectRatio: "1:1",
        },
      }),
    ).resolves.toMatchObject({
      kind: "provider-created",
      instance: {
        displayName: "Gemini Image",
        driverKind: "gemini-native-image",
        configuration: {
          kind: "gemini-native-image-http",
          modelAllowlist: ["gemini-3.1-flash-image"],
          defaultModel: "gemini-3.1-flash-image",
          aspectRatio: "1:1",
        },
        version: 1,
      },
    });
    await expect(
      fixture.service.execute(windowId, {
        kind: "change-gemini-native-image-configuration",
        instanceId,
        expectedVersion: 1,
        configuration: {
          kind: "gemini-native-image-http",
          modelAllowlist: ["gemini-3-pro-image"],
          defaultModel: "gemini-3-pro-image",
          resolution: "4K",
        },
      }),
    ).resolves.toMatchObject({
      kind: "provider-updated",
      instance: {
        driverKind: "gemini-native-image",
        configuration: {
          modelAllowlist: ["gemini-3-pro-image"],
          defaultModel: "gemini-3-pro-image",
          resolution: "4K",
        },
        version: 2,
      },
    });
  });

  it("creates and updates a BFL image profile through the journal", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.execute(windowId, {
        kind: "create-bfl-image-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "FLUX",
        configuration: {
          kind: "bfl-image-http",
          modelAllowlist: ["flux-pro-1.1", "flux-dev"],
          defaultModel: "flux-pro-1.1",
        },
      }),
    ).resolves.toMatchObject({
      kind: "provider-created",
      instance: {
        displayName: "FLUX",
        driverKind: "bfl-image",
        configuration: {
          kind: "bfl-image-http",
          modelAllowlist: ["flux-pro-1.1", "flux-dev"],
          defaultModel: "flux-pro-1.1",
        },
        version: 1,
      },
    });
    await expect(
      fixture.service.execute(windowId, {
        kind: "change-bfl-image-configuration",
        instanceId,
        expectedVersion: 1,
        configuration: {
          kind: "bfl-image-http",
          modelAllowlist: ["flux-dev"],
          defaultModel: "flux-dev",
        },
      }),
    ).resolves.toMatchObject({
      kind: "provider-updated",
      instance: {
        driverKind: "bfl-image",
        configuration: {
          modelAllowlist: ["flux-dev"],
          defaultModel: "flux-dev",
        },
        version: 2,
      },
    });
    await expect(
      fixture.service.execute(windowId, {
        kind: "remove-provider",
        instanceId,
        expectedVersion: 2,
      }),
    ).resolves.toMatchObject({ kind: "provider-removed", instanceId, version: 3 });
  });

  it("creates and updates an Ideogram image profile through the journal", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.execute(windowId, {
        kind: "create-ideogram-image-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "Ideogram",
        configuration: {
          kind: "ideogram-image-http",
          modelAllowlist: ["ideogram-v3", "ideogram-v4"],
          defaultModel: "ideogram-v3",
        },
      }),
    ).resolves.toMatchObject({
      kind: "provider-created",
      instance: {
        displayName: "Ideogram",
        driverKind: "ideogram-image",
        configuration: {
          kind: "ideogram-image-http",
          modelAllowlist: ["ideogram-v3", "ideogram-v4"],
          defaultModel: "ideogram-v3",
        },
        version: 1,
      },
    });
    await expect(
      fixture.service.execute(windowId, {
        kind: "change-ideogram-image-configuration",
        instanceId,
        expectedVersion: 1,
        configuration: {
          kind: "ideogram-image-http",
          modelAllowlist: ["ideogram-v4"],
          defaultModel: "ideogram-v4",
        },
      }),
    ).resolves.toMatchObject({
      kind: "provider-updated",
      instance: {
        driverKind: "ideogram-image",
        configuration: {
          modelAllowlist: ["ideogram-v4"],
          defaultModel: "ideogram-v4",
        },
        version: 2,
      },
    });
    await expect(
      fixture.service.execute(windowId, {
        kind: "remove-provider",
        instanceId,
        expectedVersion: 2,
      }),
    ).resolves.toMatchObject({ kind: "provider-removed", instanceId, version: 3 });
  });

  it("creates and returns the authoritative strict Codex provider instance", async () => {
    const fixture = serviceFixture();
    const expected = decodeProviderInstance({
      id: instanceId,
      displayName: "Codex local",
      driverKind: "codex",
      configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      fixture.service.execute(windowId, {
        kind: "create-codex-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "Codex local",
        binaryPath: "/opt/homebrew/bin/codex",
      }),
    ).resolves.toEqual({ kind: "provider-created", instance: expected });
    await expect(fixture.service.bootstrap(windowId)).resolves.toMatchObject({
      instances: [expected],
    });
    expect(fixture.append).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregate: { aggregateType: "provider-instance", aggregateId: instanceId },
        expectedVersion: 0,
        events: [expect.objectContaining({ eventName: "provider.instance-created@1" })],
      }),
    );
  });

  it("creates disabled providers when the create command requests enabled false", async () => {
    const fixture = serviceFixture();

    await expect(
      fixture.service.execute(windowId, {
        kind: "create-codex-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "Codex local",
        binaryPath: "/opt/homebrew/bin/codex",
        enabled: false,
      }),
    ).resolves.toMatchObject({
      kind: "provider-created",
      instance: {
        id: instanceId,
        enabled: false,
        driverKind: "codex",
        configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
      },
    });
  });

  it("creates, replays, and updates a strict non-secret Kimi Code provider", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.execute(windowId, {
        kind: "create-kimi-code-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "Kimi local",
        binaryPath: "/opt/homebrew/bin/kimi",
      }),
    ).resolves.toMatchObject({
      kind: "provider-created",
      instance: {
        driverKind: "kimi-code",
        configuration: { kind: "kimi-code-acp", binaryPath: "/opt/homebrew/bin/kimi" },
        version: 1,
      },
    });
    await expect(fixture.service.bootstrap(windowId)).resolves.toMatchObject({
      instances: [
        expect.objectContaining({
          driverKind: "kimi-code",
          configuration: { kind: "kimi-code-acp", binaryPath: "/opt/homebrew/bin/kimi" },
        }),
      ],
    });
    await expect(
      fixture.service.execute(windowId, {
        kind: "change-provider-binary",
        instanceId,
        expectedVersion: 1,
        binaryPath: "/usr/local/bin/kimi",
      }),
    ).resolves.toMatchObject({
      kind: "provider-updated",
      instance: {
        driverKind: "kimi-code",
        configuration: { kind: "kimi-code-acp", binaryPath: "/usr/local/bin/kimi" },
        version: 2,
      },
    });
    expect(JSON.stringify(fixture.append.mock.calls)).not.toMatch(
      /apiKey|oauthToken|credential|account|KIMI_CODE_HOME/,
    );
  });

  it("creates and replays a strict Claude subscription provider", async () => {
    const fixture = serviceFixture();

    await expect(
      fixture.service.execute(windowId, {
        kind: "create-claude-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "Claude local",
        configuration: {
          kind: "claude-agent-sdk",
          binaryPath: "/opt/homebrew/bin/claude",
          authentication: "subscription",
        },
      }),
    ).resolves.toMatchObject({
      kind: "provider-created",
      instance: {
        driverKind: "claude",
        configuration: {
          binaryPath: "/opt/homebrew/bin/claude",
          authentication: "subscription",
        },
        version: 1,
      },
    });
    expect(fixture.append).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 0,
        events: [expect.objectContaining({ eventName: "provider.instance-created@1" })],
      }),
    );
    await expect(fixture.service.bootstrap(windowId)).resolves.toMatchObject({
      instances: [claudeProvider()],
      observedStates: [
        {
          instanceId,
          readiness: "checking",
          processState: "stopped",
          models: [],
        },
      ],
    });
    expect(JSON.stringify(fixture.append.mock.calls)).not.toMatch(
      /apiKey|oauthToken|credential|account/,
    );
  });

  it("creates, replays, and reconfigures a strict Mistral Vibe provider", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.execute(windowId, {
        kind: "create-mistral-vibe-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "Mistral Vibe local",
        configuration: {
          kind: "mistral-vibe-acp",
          binaryPath: "/Users/example/.local/bin/vibe-acp",
          authentication: "subscription",
        },
      }),
    ).resolves.toMatchObject({
      kind: "provider-created",
      instance: {
        driverKind: "mistral-vibe",
        configuration: {
          kind: "mistral-vibe-acp",
          authentication: "subscription",
        },
        version: 1,
      },
    });
    await expect(fixture.service.bootstrap(windowId)).resolves.toMatchObject({
      instances: [mistralVibeProvider()],
      observedStates: [
        {
          instanceId,
          readiness: "checking",
          processState: "stopped",
          models: [],
        },
      ],
    });

    await expect(
      fixture.service.execute(windowId, {
        kind: "change-mistral-vibe-configuration",
        instanceId,
        expectedVersion: 1,
        configuration: {
          kind: "mistral-vibe-acp",
          binaryPath: "/opt/homebrew/bin/vibe-acp",
          authentication: "api-key",
        },
      }),
    ).resolves.toMatchObject({
      kind: "provider-updated",
      instance: {
        driverKind: "mistral-vibe",
        configuration: {
          binaryPath: "/opt/homebrew/bin/vibe-acp",
          authentication: "api-key",
        },
        version: 2,
      },
    });
    expect(fixture.runtime.observedState(instanceId)).toEqual(
      expect.objectContaining({
        readiness: "checking",
        credentialStatus: "missing",
        models: [],
        capabilities: unavailableCapabilities(),
      }),
    );
    expect(JSON.stringify(fixture.append.mock.calls)).not.toMatch(
      /apiKey|oauthToken|credential|account|vibeHome|rawAcp/,
    );
  });

  it("creates, replays, and reconfigures a strict Devin subscription provider", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.execute(windowId, {
        kind: "create-devin-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "Devin local",
        configuration: {
          kind: "devin-acp",
          binaryPath: "/Users/example/.local/bin/devin",
          authentication: "subscription",
        },
      }),
    ).resolves.toMatchObject({
      kind: "provider-created",
      instance: {
        driverKind: "devin",
        configuration: {
          kind: "devin-acp",
          binaryPath: "/Users/example/.local/bin/devin",
          authentication: "subscription",
        },
        version: 1,
      },
    });
    await expect(fixture.service.bootstrap(windowId)).resolves.toMatchObject({
      instances: [devinProvider()],
      observedStates: [
        {
          instanceId,
          readiness: "checking",
          processState: "stopped",
          models: [],
        },
      ],
    });

    await expect(
      fixture.service.execute(windowId, {
        kind: "change-devin-configuration",
        instanceId,
        expectedVersion: 1,
        configuration: {
          kind: "devin-acp",
          binaryPath: "/opt/homebrew/bin/devin",
          authentication: "subscription",
        },
      }),
    ).resolves.toMatchObject({
      kind: "provider-updated",
      instance: {
        driverKind: "devin",
        configuration: {
          binaryPath: "/opt/homebrew/bin/devin",
          authentication: "subscription",
        },
        version: 2,
      },
    });
    expect(JSON.stringify(fixture.append.mock.calls)).not.toMatch(
      /apiKey|oauthToken|credential|account|team|cloudSessionId|rawAcp/,
    );
  });

  it("creates, replays, and reconfigures a strict Pi RPC provider", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.execute(windowId, {
        kind: "create-pi-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "Pi local",
        configuration: { kind: "pi-rpc", binaryPath: "/opt/homebrew/bin/pi" },
      }),
    ).resolves.toMatchObject({
      kind: "provider-created",
      instance: {
        driverKind: "pi",
        configuration: { kind: "pi-rpc", binaryPath: "/opt/homebrew/bin/pi" },
        version: 1,
      },
    });
    await expect(fixture.service.bootstrap(windowId)).resolves.toMatchObject({
      instances: [piProvider()],
    });

    await expect(
      fixture.service.execute(windowId, {
        kind: "change-pi-configuration",
        instanceId,
        expectedVersion: 1,
        configuration: { kind: "pi-rpc", binaryPath: "/usr/local/bin/pi" },
      }),
    ).resolves.toMatchObject({
      kind: "provider-updated",
      instance: {
        driverKind: "pi",
        configuration: { binaryPath: "/usr/local/bin/pi" },
        version: 2,
      },
    });
    expect(JSON.stringify(fixture.append.mock.calls)).not.toMatch(
      /apiKey|oauthToken|credential|account|rawRpc/,
    );
  });

  it("creates a discovered Oh My Pi provider without enabling it implicitly", async () => {
    const fixture = serviceFixture();

    await expect(
      fixture.service.execute(windowId, {
        kind: "create-oh-my-pi-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "Oh My Pi",
        configuration: {
          kind: "oh-my-pi-rpc",
          binaryPath:
            "/Users/example/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
          supportedVersion: "17.2.1",
        },
        enabled: false,
      }),
    ).resolves.toMatchObject({
      kind: "provider-created",
      instance: {
        driverKind: "oh-my-pi",
        enabled: false,
        configuration: {
          kind: "oh-my-pi-rpc",
          supportedVersion: "17.2.1",
        },
      },
    });
  });

  it("creates, replays, and reconfigures a strict Kilo ACP provider", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.execute(windowId, {
        kind: "create-kilo-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "Kilo local",
        configuration: { kind: "kilo-acp", binaryPath: "/opt/homebrew/bin/kilo" },
      }),
    ).resolves.toMatchObject({
      kind: "provider-created",
      instance: {
        driverKind: "kilo",
        configuration: { kind: "kilo-acp", binaryPath: "/opt/homebrew/bin/kilo" },
        version: 1,
      },
    });
    await expect(fixture.service.bootstrap(windowId)).resolves.toMatchObject({
      instances: [kiloProvider()],
      observedStates: [],
    });
    await expect(
      fixture.service.execute(windowId, {
        kind: "change-kilo-configuration",
        instanceId,
        expectedVersion: 1,
        configuration: { kind: "kilo-acp", binaryPath: "/usr/local/bin/kilo" },
      }),
    ).resolves.toMatchObject({
      kind: "provider-updated",
      instance: {
        driverKind: "kilo",
        configuration: { kind: "kilo-acp", binaryPath: "/usr/local/bin/kilo" },
        version: 2,
      },
    });
    expect(JSON.stringify(fixture.append.mock.calls)).not.toMatch(
      /apiKey|oauthToken|credential|account|kiloHome|plugin|skill|rawAcp/,
    );
  });

  it("creates, replays, and reconfigures a strict loopback Ollama provider", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.execute(windowId, {
        kind: "create-ollama-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "Ollama local",
        configuration: {
          kind: "ollama-native-http",
          baseUrl: "http://localhost:11434/",
        },
      }),
    ).resolves.toMatchObject({
      kind: "provider-created",
      instance: {
        driverKind: "ollama",
        configuration: {
          kind: "ollama-native-http",
          baseUrl: "http://localhost:11434",
        },
        version: 1,
      },
    });
    await expect(fixture.service.bootstrap(windowId)).resolves.toMatchObject({
      instances: [
        ollamaProvider({
          configuration: {
            kind: "ollama-native-http",
            baseUrl: "http://localhost:11434",
          },
        }),
      ],
    });
    fixture.runtime.setObservedState(observation());
    await expect(
      fixture.service.execute(windowId, {
        kind: "change-ollama-configuration",
        instanceId,
        expectedVersion: 1,
        configuration: {
          kind: "ollama-native-http",
          baseUrl: "http://127.0.0.1:11434/",
        },
      }),
    ).resolves.toMatchObject({
      kind: "provider-updated",
      instance: {
        driverKind: "ollama",
        configuration: { baseUrl: "http://127.0.0.1:11434" },
        version: 2,
      },
    });
    expect(fixture.runtime.observedState(instanceId)).toBeUndefined();
    expect(JSON.stringify(fixture.append.mock.calls)).not.toMatch(
      /apiKey|authorization|credential|prompt|response|rawNdjson/,
    );
  });

  it("delegates transient provider authentication without journaling the attempt", async () => {
    const fixture = serviceFixture({ instances: [mistralVibeProvider()] });
    const beginAuthentication = vi.fn(() =>
      Effect.succeed({
        attemptId: "provider-attempt-1" as never,
        signInUrl: "https://auth.mistral.example/attempt",
        expiresAt: "2026-07-17T11:00:00.000Z" as never,
      }),
    );
    const completeAuthentication = vi.fn(() => Effect.void);
    const service = new ProviderService({
      persistence: fixture.persistence,
      runtimeRegistry: fixture.runtime,
      driver: () => ({
        kind: "mistral-vibe",
        probe: () => Effect.die("unused"),
        acquire: () => Effect.die("unused"),
        beginAuthentication,
        completeAuthentication,
      }),
      uuid: () => crypto.randomUUID(),
      clock: () => now,
    });

    await expect(
      service.execute(windowId, {
        kind: "begin-provider-authentication",
        instanceId,
      }),
    ).resolves.toMatchObject({
      kind: "provider-authentication-started",
      instanceId,
      attempt: { attemptId: "provider-attempt-1" },
    });
    await expect(
      service.execute(windowId, {
        kind: "complete-provider-authentication",
        instanceId,
        attemptId: "provider-attempt-1",
      }),
    ).resolves.toEqual({ kind: "provider-authentication-completed", instanceId });
    expect(beginAuthentication).toHaveBeenCalledWith({ instanceId });
    expect(completeAuthentication).toHaveBeenCalledWith({
      instanceId,
      attemptId: "provider-attempt-1",
    });
    expect(fixture.append).not.toHaveBeenCalled();
  });

  it("invalidates the persisted catalog after browser authentication completes", async () => {
    const fixture = serviceFixture({
      instances: [mistralVibeProvider()],
      withCatalogPersistence: true,
      initialCatalog: persistedCatalog(),
    });
    const completeAuthentication = vi.fn(() => Effect.void);
    const service = new ProviderService({
      persistence: fixture.persistence,
      runtimeRegistry: fixture.runtime,
      driver: () => ({
        kind: "mistral-vibe",
        probe: () => Effect.die("unused"),
        acquire: () => Effect.die("unused"),
        completeAuthentication,
      }),
      uuid: () => crypto.randomUUID(),
      clock: () => now,
    });

    await expect(
      service.execute(windowId, {
        kind: "complete-provider-authentication",
        instanceId,
        attemptId: "provider-attempt-1",
      }),
    ).resolves.toEqual({ kind: "provider-authentication-completed", instanceId });

    expect(completeAuthentication).toHaveBeenCalledWith({
      instanceId,
      attemptId: "provider-attempt-1",
    });
    expect(fixture.catalogs()[0]).toMatchObject({
      version: 2,
      invalidated: true,
      invalidationReason: "provider authentication changed",
    });
  });

  it("invalidates only endpoint-derived evidence when the endpoint changes and preserves curated metadata", async () => {
    const catalogWithEvidence = decodeProviderCatalogSnapshot({
      instanceId,
      version: 1,
      models: [
        decodeProviderModel({
          id: "model-a",
          displayName: "Model A",
          source: "discovered",
          verification: "verified",
          reasoning: "unavailable",
          inputModalities: ["text"],
          options: [],
          capabilityEvidence: [
            {
              capability: "tool-calling",
              support: "supported",
              source: "endpoint-observation",
              confidence: "high",
              protocol: "responses",
              observedAt: now,
              invalidated: false,
            },
            {
              capability: "tool-calling",
              support: "supported",
              source: "catalog-metadata",
              confidence: "medium",
              protocol: "unknown",
              observedAt: now,
              invalidated: false,
            },
          ],
        }),
      ],
      manualModelOrder: [],
      invalidated: false,
      updatedAt: now,
    });
    const fixture = serviceFixture({
      instances: [httpProvider()],
      withCatalogPersistence: true,
      initialCatalog: catalogWithEvidence,
    });

    await expect(
      fixture.service.execute(windowId, {
        kind: "change-openai-compatible-configuration",
        instanceId,
        expectedVersion: 1,
        configuration: {
          kind: "openai-compatible-http",
          baseUrl: "https://other.example/v1/",
          authentication: "bearer",
          protocol: "auto",
          manualModelIds: ["model-a"],
        },
      }),
    ).resolves.toMatchObject({ kind: "provider-updated" });

    const catalog = fixture.catalogs()[0];
    expect(catalog).toMatchObject({
      invalidated: true,
      invalidationReason: "provider configuration changed",
    });
    const evidence = (
      catalog as {
        models: Array<{ capabilityEvidence?: Array<{ source: string; invalidated: boolean }> }>;
      }
    ).models[0]?.capabilityEvidence;
    expect(evidence?.find((record) => record.source === "endpoint-observation")?.invalidated).toBe(
      true,
    );
    expect(evidence?.find((record) => record.source === "catalog-metadata")?.invalidated).toBe(
      false,
    );
  });

  it("continues invalidating remaining evidence on a broader change after an earlier endpoint invalidation", async () => {
    const catalogWithEvidence = decodeProviderCatalogSnapshot({
      instanceId,
      version: 1,
      models: [
        decodeProviderModel({
          id: "model-a",
          displayName: "Model A",
          source: "discovered",
          verification: "verified",
          reasoning: "unavailable",
          inputModalities: ["text"],
          options: [],
          capabilityEvidence: [
            {
              capability: "tool-calling",
              support: "supported",
              source: "endpoint-observation",
              confidence: "high",
              protocol: "responses",
              observedAt: now,
              invalidated: false,
            },
            {
              capability: "tool-calling",
              support: "supported",
              source: "catalog-metadata",
              confidence: "medium",
              protocol: "unknown",
              observedAt: now,
              invalidated: false,
            },
          ],
        }),
      ],
      manualModelOrder: [],
      invalidated: false,
      updatedAt: now,
    });
    const fixture = serviceFixture({
      instances: [httpProvider()],
      withCatalogPersistence: true,
      initialCatalog: catalogWithEvidence,
    });

    // First change: endpoint-only — invalidates endpoint-derived evidence, preserves catalog metadata.
    await fixture.service.execute(windowId, {
      kind: "change-openai-compatible-configuration",
      instanceId,
      expectedVersion: 1,
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://other.example/v1/",
        authentication: "bearer",
        protocol: "auto",
        manualModelIds: ["model-a"],
      },
    });

    // Second change: non-authority field (manualModelIds) — classified as `all`,
    // must invalidate the surviving catalog-metadata evidence even though the
    // catalog is already marked invalidated.
    await fixture.service.execute(windowId, {
      kind: "change-openai-compatible-configuration",
      instanceId,
      expectedVersion: 2,
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://other.example/v1/",
        authentication: "bearer",
        protocol: "auto",
        manualModelIds: ["model-a", "model-b"],
      },
    });

    const catalog = fixture.catalogs()[0];
    const evidence = (
      catalog as {
        models: Array<{ capabilityEvidence?: Array<{ source: string; invalidated: boolean }> }>;
      }
    ).models[0]?.capabilityEvidence;
    expect(evidence?.find((record) => record.source === "endpoint-observation")?.invalidated).toBe(
      true,
    );
    expect(evidence?.find((record) => record.source === "catalog-metadata")?.invalidated).toBe(
      true,
    );
  });

  it("reconfigures Claude to API-key mode after invalidation and publishes missing credentials", async () => {
    const fixture = serviceFixture({ instances: [claudeProvider()] });
    fixture.runtime.setObservedState(observation({ credentialStatus: "stored" }));

    await expect(
      fixture.service.execute(windowId, {
        kind: "change-claude-configuration",
        instanceId,
        expectedVersion: 1,
        configuration: {
          kind: "claude-agent-sdk",
          binaryPath: "/usr/local/bin/claude",
          authentication: "api-key",
        },
      }),
    ).resolves.toMatchObject({
      kind: "provider-updated",
      instance: {
        configuration: {
          binaryPath: "/usr/local/bin/claude",
          authentication: "api-key",
        },
        version: 2,
      },
    });
    expect(fixture.append).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 1,
        events: [
          expect.objectContaining({ eventName: "provider.instance-configuration-changed@1" }),
        ],
      }),
    );
    expect(fixture.runtime.observedState(instanceId)).toEqual(
      expect.objectContaining({
        instanceId,
        readiness: "checking",
        processState: "stopped",
        credentialStatus: "missing",
        models: [],
        capabilities: unavailableCapabilities(),
      }),
    );
    expect(JSON.stringify(fixture.append.mock.calls)).not.toMatch(
      /apiKey|oauthToken|credential|account/,
    );
  });

  it("clears API-key credential readiness when Claude changes to subscription mode", async () => {
    const fixture = serviceFixture({
      instances: [
        claudeProvider({
          configuration: {
            kind: "claude-agent-sdk",
            binaryPath: "/opt/homebrew/bin/claude",
            authentication: "api-key",
          },
        }),
      ],
    });
    fixture.runtime.setObservedState(observation({ credentialStatus: "stored" }));

    await fixture.service.execute(windowId, {
      kind: "change-claude-configuration",
      instanceId,
      expectedVersion: 1,
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/opt/homebrew/bin/claude",
        authentication: "subscription",
      },
    });

    const observed = fixture.runtime.observedState(instanceId);
    expect(observed).toMatchObject({ readiness: "checking", models: [] });
    expect(observed).not.toHaveProperty("credentialStatus");
  });

  it("rejects stale and active-session Claude reconfiguration and removes Claude durably", async () => {
    const stale = serviceFixture({ instances: [claudeProvider()] });
    await expect(
      stale.service.execute(windowId, {
        kind: "change-claude-configuration",
        instanceId,
        expectedVersion: 0,
        configuration: claudeProvider().configuration,
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid-configuration" } });
    expect(stale.append).not.toHaveBeenCalled();

    const active = serviceFixture({ instances: [claudeProvider()] });
    active.runtime.setActiveSessionCount(instanceId, 1);
    await expect(
      active.service.execute(windowId, {
        kind: "change-claude-configuration",
        instanceId,
        expectedVersion: 1,
        configuration: claudeProvider().configuration,
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid-configuration" } });
    expect(active.append).not.toHaveBeenCalled();

    active.runtime.setActiveSessionCount(instanceId, 0);
    await expect(
      active.service.execute(windowId, {
        kind: "remove-provider",
        instanceId,
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({ kind: "provider-removed", instanceId, version: 2 });
    expect(active.runtime.observedState(instanceId)).toBeUndefined();
  });

  it("clears Claude resume identities only after durable provider removal succeeds", async () => {
    const clearResumeIdentities = vi.fn(async () => undefined);
    const clearRuntimeUsageLimits = vi.fn();
    const fixture = serviceFixture({
      instances: [claudeProvider()],
      clearResumeIdentities,
      clearRuntimeUsageLimits,
    });

    await expect(
      fixture.service.execute(windowId, {
        kind: "remove-provider",
        instanceId,
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({ kind: "provider-removed", instanceId });

    expect(fixture.persistence.readProviderInstance(instanceId)).toBeUndefined();
    expect(clearResumeIdentities).toHaveBeenCalledWith(instanceId);
    expect(clearRuntimeUsageLimits).toHaveBeenCalledWith(instanceId);
  });

  it("preserves Claude resume identities when durable provider removal fails", async () => {
    const clearResumeIdentities = vi.fn(async () => undefined);
    const fixture = serviceFixture({
      instances: [claudeProvider()],
      appendError: new Error("journal unavailable"),
      clearResumeIdentities,
    });

    await expect(
      fixture.service.execute(windowId, {
        kind: "remove-provider",
        instanceId,
        expectedVersion: 1,
      }),
    ).rejects.toBeDefined();
    expect(clearResumeIdentities).not.toHaveBeenCalled();
    expect(fixture.persistence.readProviderInstance(instanceId)).toBeDefined();
  });

  it("changes HTTP configuration, invalidates runtime, and clears stale discovery", async () => {
    const clearRuntimeUsageLimits = vi.fn();
    const fixture = serviceFixture({
      instances: [httpProvider()],
      clearRuntimeUsageLimits,
    });
    fixture.runtime.setObservedState(observation());
    fixture.runtime.setCompatibleProtocol(instanceId, "chat-completions");

    await expect(
      fixture.service.execute(windowId, {
        kind: "change-openai-compatible-configuration",
        instanceId,
        expectedVersion: 1,
        configuration: {
          kind: "openai-compatible-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          authentication: "none",
          protocol: "responses",
          manualModelIds: ["local-model"],
        },
      }),
    ).resolves.toMatchObject({
      kind: "provider-updated",
      instance: {
        configuration: {
          baseUrl: "http://127.0.0.1:11434/v1/",
          authentication: "none",
          manualModelIds: ["local-model"],
        },
        version: 2,
      },
    });
    expect(fixture.append).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 1,
        events: [
          expect.objectContaining({ eventName: "provider.instance-configuration-changed@1" }),
        ],
      }),
    );
    expect(fixture.runtime.observedState(instanceId)).toBeUndefined();
    expect(fixture.runtime.compatibleProtocol(instanceId)).toBeUndefined();
    expect(clearRuntimeUsageLimits).toHaveBeenCalledWith(instanceId);
  });

  it("keeps binary and HTTP configuration commands variant-specific", async () => {
    const openCode = serviceFixture({ instances: [provider()] });
    await expect(
      openCode.service.execute(windowId, {
        kind: "change-openai-compatible-configuration",
        instanceId,
        expectedVersion: 1,
        configuration: httpProvider().configuration,
      }),
    ).rejects.toMatchObject({ failure: { category: "unsupported" } });

    const http = serviceFixture({ instances: [httpProvider()] });
    await expect(
      http.service.execute(windowId, {
        kind: "change-provider-binary",
        instanceId,
        expectedVersion: 1,
        binaryPath: "/usr/local/bin/opencode",
      }),
    ).rejects.toMatchObject({ failure: { category: "unsupported" } });
    expect(openCode.append).not.toHaveBeenCalled();
    expect(http.append).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "nonzero expected version without an existing instance",
      expectedVersion: 1,
      instances: [] as ReadonlyArray<ProviderInstance>,
    },
    {
      name: "occupied instance ID",
      expectedVersion: 0,
      instances: [provider()],
    },
  ])("rejects Codex creation with $name without persisting it", async (scenario) => {
    const fixture = serviceFixture({ instances: scenario.instances });

    const failure = await rejected(
      fixture.service.execute(windowId, {
        kind: "create-codex-provider",
        instanceId,
        expectedVersion: scenario.expectedVersion,
        displayName: "Codex local",
        binaryPath: "/opt/homebrew/bin/codex",
      }),
    );

    expect(failure).toMatchObject({
      failure: {
        category: "invalid-configuration",
        message: "Provider configuration changed; reload and retry.",
      },
    });
    expect(JSON.stringify(failure)).not.toContain("/opt/homebrew/bin/codex");
    expect(fixture.append).not.toHaveBeenCalled();
    await expect(fixture.service.bootstrap(windowId)).resolves.toMatchObject({
      instances: scenario.instances,
    });
  });

  it("rejects stale commands and maps journal races without leaking internals", async () => {
    const stale = serviceFixture({ instances: [provider()] });
    await expect(
      stale.service.execute(windowId, {
        kind: "rename-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "Primary",
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid-configuration" } });
    expect(stale.append).not.toHaveBeenCalled();

    const raced = serviceFixture({
      instances: [provider()],
      appendError: new ConcurrencyConflict({
        aggregateType: "provider-instance",
        aggregateId: instanceId,
        expectedVersion: 1,
        actualVersion: 4,
      }),
    });
    const failure = await rejected(
      raced.service.execute(windowId, {
        kind: "rename-provider",
        instanceId,
        expectedVersion: 1,
        displayName: "Primary",
      }),
    );
    expect(failure).toMatchObject({ failure: { category: "invalid-configuration" } });
    expect(JSON.stringify(failure)).not.toContain("aggregateId");
  });

  it("persists permission defaults and reads the authoritative projection", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.execute(windowId, {
        kind: "update-provider-defaults",
        expectedVersion: 0,
        permissionPersistence: "project-default",
      }),
    ).resolves.toEqual({
      kind: "provider-defaults-updated",
      defaults: { permissionPersistence: "project-default", version: 1 },
    });
  });

  it("persists and clears the Settings-defined agent-eligible model defaults", async () => {
    const fixture = serviceFixture();
    const agentEligibleModels = [
      { providerInstanceId: instanceId, modelId: decodeProviderModelId("gpt-5.2") },
      { providerInstanceId: instanceId, modelId: decodeProviderModelId("gpt-5.2-mini") },
    ];
    await expect(
      fixture.service.execute(windowId, {
        kind: "update-provider-defaults",
        expectedVersion: 0,
        permissionPersistence: "current-session",
        agentEligibleModels,
      }),
    ).resolves.toEqual({
      kind: "provider-defaults-updated",
      defaults: {
        permissionPersistence: "current-session",
        agentEligibleModels,
        version: 1,
      },
    });
    // A defaults update that omits the pool preserves it unchanged.
    await expect(
      fixture.service.execute(windowId, {
        kind: "update-provider-defaults",
        expectedVersion: 1,
        permissionPersistence: "project-default",
      }),
    ).resolves.toEqual({
      kind: "provider-defaults-updated",
      defaults: {
        permissionPersistence: "project-default",
        agentEligibleModels,
        version: 2,
      },
    });
    // An explicit empty list clears the stored pool.
    await expect(
      fixture.service.execute(windowId, {
        kind: "update-provider-defaults",
        expectedVersion: 2,
        permissionPersistence: "project-default",
        agentEligibleModels: [],
      }),
    ).resolves.toEqual({
      kind: "provider-defaults-updated",
      defaults: { permissionPersistence: "project-default", version: 3 },
    });
  });

  it("blocks probes for disabled providers and removal with active sessions", async () => {
    const disabled = serviceFixture({ instances: [provider({ enabled: false })] });
    await expect(disabled.service.probe(windowId, instanceId)).rejects.toMatchObject({
      failure: { category: "invalid-configuration" },
    });
    expect(disabled.probe).not.toHaveBeenCalled();

    const active = serviceFixture({ instances: [provider()] });
    active.runtime.setActiveSessionCount(instanceId, 1);
    await expect(
      active.service.execute(windowId, {
        kind: "remove-provider",
        instanceId,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid-configuration" } });
    expect(active.append).not.toHaveBeenCalled();
    active.runtime.setActiveSessionCount(instanceId, 0);
    await expect(
      active.service.execute(windowId, {
        kind: "remove-provider",
        instanceId,
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({ kind: "provider-removed", instanceId });
  });

  it("stores only strict normalized probe results", async () => {
    const observed = observation();
    const fixture = serviceFixture({ instances: [provider()], probeResult: observed });
    await expect(fixture.service.probe(windowId, instanceId)).resolves.toEqual(observed);
    expect(fixture.runtime.observedStates()).toEqual([observed]);
  });

  it("persists a successful probe as a versioned provider catalog snapshot", async () => {
    const fixture = serviceFixture({ instances: [provider()], withCatalogPersistence: true });
    await fixture.service.probe(windowId, instanceId);

    expect(fixture.catalogs()).toMatchObject([
      {
        instanceId,
        version: 1,
        models: [{ id: "model-1" }],
        manualModelOrder: [],
        invalidated: false,
      },
    ]);
  });

  it("preserves configured manual model order when discovery returns those IDs", async () => {
    const fixture = serviceFixture({
      instances: [
        httpProvider({
          configuration: {
            kind: "openai-compatible-http",
            baseUrl: "https://gateway.example/v1",
            authentication: "none",
            protocol: "responses",
            manualModelIds: ["manual-a", "manual-b"],
          },
        }),
      ],
      withCatalogPersistence: true,
      probeResult: observation({
        models: [
          { ...observation().models[0]!, id: "manual-a", source: "discovered" },
          { ...observation().models[0]!, id: "discovered-z", displayName: "Discovered Z" },
        ],
      }),
    });

    await fixture.service.probe(windowId, instanceId);

    expect(fixture.catalogs()[0]).toMatchObject({
      manualModelOrder: ["manual-a", "manual-b"],
    });
  });

  it("retains a useful catalog when a non-ready probe returns no models", async () => {
    const existingCatalog = persistedCatalog();
    const fixture = serviceFixture({
      instances: [provider()],
      withCatalogPersistence: true,
      initialCatalog: existingCatalog,
      probeResult: observation({
        readiness: "unauthenticated",
        processState: "stopped",
        models: [],
        capabilities: unavailableCapabilities(),
      }),
    });

    await expect(fixture.service.probe(windowId, instanceId)).resolves.toMatchObject({
      readiness: "unauthenticated",
      models: [],
    });

    expect(fixture.catalogs()).toEqual([existingCatalog]);
  });

  it.each([
    {
      category: "unauthenticated" as const,
      readiness: "unauthenticated" as const,
    },
    { category: "unavailable" as const, readiness: "unavailable" as const },
    { category: "incompatible" as const, readiness: "incompatible" as const },
  ])("replaces prior Ready discovery after a $category probe failure", async (failure) => {
    const fixture = serviceFixture({
      instances: [provider()],
      probe: async () => {
        throw { category: failure.category, message: "secret provider diagnostic" };
      },
    });
    fixture.runtime.setObservedState(observation({ observedAt: "2026-07-14T09:00:00.000Z" }));

    await expect(fixture.service.probe(windowId, instanceId)).rejects.toMatchObject({
      failure: { category: failure.category },
    });
    const observed = fixture.runtime.observedState(instanceId);
    expect(observed).toMatchObject({
      readiness: failure.readiness,
      processState: "stopped",
      models: [],
      observedAt: now,
    });
    expect(new Set(Object.values(observed!.capabilities))).toEqual(new Set(["unavailable"]));
    expect(JSON.stringify(observed)).not.toContain("secret provider diagnostic");
  });

  it("clears prior discovery when probing a missing or disabled provider", async () => {
    const disabled = serviceFixture({ instances: [provider({ enabled: false })] });
    disabled.runtime.setObservedState(observation());
    await expect(disabled.service.probe(windowId, instanceId)).rejects.toMatchObject({
      failure: { category: "invalid-configuration" },
    });
    expect(disabled.runtime.observedState(instanceId)).toBeUndefined();

    const missing = serviceFixture();
    missing.runtime.setObservedState(observation());
    await expect(missing.service.probe(windowId, instanceId)).rejects.toMatchObject({
      failure: { category: "invalid-configuration" },
    });
    expect(missing.runtime.observedState(instanceId)).toBeUndefined();
  });

  it("probes through a scoped provider driver when one is registered", async () => {
    const fixture = serviceFixture({ instances: [provider()] });
    const probe = vi.fn(() => Effect.succeed(observation()));
    const service = new ProviderService({
      persistence: fixture.persistence,
      runtimeRegistry: fixture.runtime,
      driver: () => ({
        kind: "opencode",
        probe,
        acquire: () => Effect.fail({ category: "unsupported", message: "not used" }),
      }),
      uuid: () => crypto.randomUUID(),
      clock: () => now,
    });
    await expect(service.probe(windowId, instanceId)).resolves.toEqual(observation());
    expect(probe).toHaveBeenCalledWith({ instanceId });
  });

  it("closes the old runtime before probing an authoritative binary change", async () => {
    const fixture = serviceFixture({ instances: [provider()] });
    const close = vi.fn(async () => undefined);
    await Effect.runPromise(
      Effect.scoped(
        fixture.runtime.acquireRuntime(instanceId, {
          idleMs: 30_000,
          start: async () => ({ value: "old-runtime", close }),
        }),
      ),
    );
    await expect(
      fixture.service.execute(windowId, {
        kind: "change-provider-binary",
        instanceId,
        expectedVersion: 1,
        binaryPath: "/usr/local/bin/opencode",
      }),
    ).resolves.toMatchObject({
      instance: { configuration: { binaryPath: "/usr/local/bin/opencode" }, version: 2 },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(fixture.runtime.hasRuntime(instanceId)).toBe(false);
    await fixture.service.probe(windowId, instanceId);
    expect(fixture.probe).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: expect.objectContaining({ binaryPath: "/usr/local/bin/opencode" }),
      }),
    );
  });

  it("rejects binary invalidation with active sessions and removes no live runtime", async () => {
    const active = serviceFixture({ instances: [provider()] });
    active.runtime.setActiveSessionCount(instanceId, 1);
    await expect(
      active.service.execute(windowId, {
        kind: "change-provider-binary",
        instanceId,
        expectedVersion: 1,
        binaryPath: "/usr/local/bin/opencode",
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid-configuration" } });
    expect(active.append).not.toHaveBeenCalled();

    const removable = serviceFixture({ instances: [provider()] });
    const close = vi.fn(async () => undefined);
    await Effect.runPromise(
      Effect.scoped(
        removable.runtime.acquireRuntime(instanceId, {
          idleMs: 30_000,
          start: async () => ({ value: "runtime", close }),
        }),
      ),
    );
    await removable.service.execute(windowId, {
      kind: "remove-provider",
      instanceId,
      expectedVersion: 1,
    });
    expect(close).toHaveBeenCalledOnce();
    expect(removable.runtime.hasRuntime(instanceId)).toBe(false);
  });

  it.each([
    {
      kind: "change-provider-binary" as const,
      binaryPath: "/usr/local/bin/opencode",
    },
    { kind: "remove-provider" as const },
  ])("preserves durable configuration when $kind runtime cleanup rejects", async (command) => {
    const fixture = serviceFixture({ instances: [provider()] });
    await Effect.runPromise(
      Effect.scoped(
        fixture.runtime.acquireRuntime(instanceId, {
          idleMs: 30_000,
          start: async () => ({
            value: "runtime",
            close: async () => {
              throw new Error("private cleanup detail");
            },
          }),
        }),
      ),
    );
    await expect(
      fixture.service.execute(windowId, {
        ...command,
        instanceId,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({
      failure: {
        category: "unavailable",
        message: "Octant Provider service is unavailable.",
      },
    });
    expect(fixture.append).not.toHaveBeenCalled();
    await expect(fixture.service.bootstrap(windowId)).resolves.toMatchObject({
      instances: [{ version: 1, configuration: { binaryPath: "/opt/homebrew/bin/opencode" } }],
    });
  });

  it.each([
    {
      kind: "change-provider-binary" as const,
      binaryPath: "/usr/local/bin/opencode",
      removed: false,
    },
    { kind: "remove-provider" as const, removed: true },
  ])("does not probe old configuration during $kind invalidation", async (command) => {
    const fixture = serviceFixture({ instances: [provider()] });
    const closeStarted = deferred<void>();
    const allowClose = deferred<void>();
    await Effect.runPromise(
      Effect.scoped(
        fixture.runtime.acquireRuntime(instanceId, {
          idleMs: 30_000,
          start: async () => ({
            value: "old-runtime",
            close: async () => {
              closeStarted.resolve();
              await allowClose.promise;
            },
          }),
        }),
      ),
    );

    const mutation = fixture.service.execute(
      windowId,
      command.kind === "change-provider-binary"
        ? {
            kind: command.kind,
            instanceId,
            expectedVersion: 1,
            binaryPath: command.binaryPath,
          }
        : { kind: command.kind, instanceId, expectedVersion: 1 },
    );
    await closeStarted.promise;
    const probe = fixture.service.probe(otherWindowId, instanceId);
    await Promise.resolve();
    const probedWhileClosing = fixture.probe.mock.calls.length !== 0;

    allowClose.resolve();
    await mutation;
    expect(probedWhileClosing).toBe(false);
    if (command.removed) {
      await expect(probe).rejects.toMatchObject({
        failure: { category: "invalid-configuration" },
      });
      expect(fixture.probe).not.toHaveBeenCalled();
    } else {
      await expect(probe).resolves.toMatchObject({ instanceId });
      expect(fixture.probe).toHaveBeenCalledWith(
        expect.objectContaining({
          configuration: expect.objectContaining({ binaryPath: "/usr/local/bin/opencode" }),
        }),
      );
    }
  });

  it("prevents a stale probe observation from winning after a binary mutation", async () => {
    const pendingProbe = deferred<ReturnType<typeof observation>>();
    const fixture = serviceFixture({
      instances: [provider()],
      probe: async () => pendingProbe.promise,
    });
    const probe = fixture.service.probe(windowId, instanceId);
    await vi.waitFor(() => expect(fixture.probe).toHaveBeenCalledOnce());

    const mutation = fixture.service.execute(windowId, {
      kind: "change-provider-binary",
      instanceId,
      expectedVersion: 1,
      binaryPath: "/usr/local/bin/opencode",
    });
    await Promise.resolve();
    expect(fixture.append).not.toHaveBeenCalled();

    pendingProbe.resolve(observation());
    await probe;
    await mutation;
    expect(fixture.runtime.observedState(instanceId)).toBeUndefined();
  });

  it("keeps different instances concurrent and releases completed serialization keys", async () => {
    const pendingProbe = deferred<ReturnType<typeof observation>>();
    const fixture = serviceFixture({
      instances: [
        provider(),
        provider({
          id: otherId,
          displayName: "Other OpenCode",
          configuration: { kind: "opencode-cli", binaryPath: "/usr/local/bin/opencode" },
        }),
      ],
      probe: async (instance) =>
        instance.id === instanceId
          ? pendingProbe.promise
          : observation({ instanceId: instance.id }),
    });
    expect(fixture.service.pendingInstanceOperationCount()).toBe(0);
    const probe = fixture.service.probe(windowId, instanceId);
    await vi.waitFor(() => expect(fixture.probe).toHaveBeenCalledOnce());
    expect(fixture.service.pendingInstanceOperationCount()).toBe(1);

    await expect(
      fixture.service.execute(windowId, {
        kind: "change-provider-binary",
        instanceId: otherId,
        expectedVersion: 1,
        binaryPath: "/opt/local/bin/opencode",
      }),
    ).resolves.toMatchObject({ instance: { id: otherId, version: 2 } });
    expect(fixture.service.pendingInstanceOperationCount()).toBe(1);

    pendingProbe.resolve(observation());
    await probe;
    expect(fixture.service.pendingInstanceOperationCount()).toBe(0);
  });

  it("reports a provider no driver can serve as unusable with its reason", async () => {
    const fixture = serviceFixture({
      instances: [provider()],
      driver: () => {
        throw new ProviderDriverConfigurationError();
      },
    });

    await expect(fixture.service.bootstrap(windowId)).resolves.toMatchObject({
      observedStates: [
        {
          instanceId,
          readiness: "incompatible",
          processState: "stopped",
          models: [],
          capabilities: { streaming: "unavailable" },
          message: "Provider driver configuration is invalid.",
        },
      ],
    });
  });

  it("applies a configuration change to the running provider set without a restart", async () => {
    const fixture = serviceFixture({
      instances: [provider()],
      driver: (instance) => {
        if (
          instance.configuration.kind === "opencode-cli" &&
          instance.configuration.binaryPath === "/usr/local/bin/opencode"
        ) {
          throw new ProviderDriverConfigurationError();
        }
        return { kind: "opencode" } as never;
      },
    });
    await fixture.service.probe(windowId, instanceId);
    expect(fixture.runtime.observedState(instanceId)?.readiness).toBe("ready");

    await expect(
      fixture.service.execute(windowId, {
        kind: "change-provider-binary",
        instanceId,
        expectedVersion: 1,
        binaryPath: "/usr/local/bin/opencode",
      }),
    ).resolves.toMatchObject({ kind: "provider-updated" });

    expect(fixture.runtime.observedState(instanceId)).toMatchObject({
      readiness: "incompatible",
      message: "Provider driver configuration is invalid.",
    });
  });

  it("drops runtime state for a provider that is no longer configured", async () => {
    const fixture = serviceFixture({ instances: [provider()] });
    await fixture.service.probe(windowId, instanceId);
    fixture.runtime.setObservedState(observation({ instanceId: otherId }));

    fixture.service.reconcileConfiguredProviders();

    expect(fixture.runtime.observedState(otherId)).toBeUndefined();
    expect(fixture.runtime.observedState(instanceId)?.readiness).toBe("ready");
  });

  it("warms one runtime for every enabled provider and skips the others", async () => {
    const fixture = serviceFixture({
      instances: [
        provider(),
        provider({ id: otherId, displayName: "OpenCode spare" }),
        claudeProvider({
          id: decodeProviderInstanceId("80000000-0000-4000-8000-000000000014"),
          enabled: false,
        }),
      ],
    });

    await fixture.service.warmEnabledProviders();

    expect(fixture.probe.mock.calls.map(([instance]) => instance.id)).toEqual([
      instanceId,
      otherId,
    ]);
  });

  it("keeps a warmed provider runtime alive under its idle lease", async () => {
    const fixture = serviceFixture({ instances: [provider()] });
    const service = new ProviderService({
      persistence: fixture.persistence,
      runtimeRegistry: fixture.runtime,
      driver: (instance) => ({
        kind: "opencode",
        probe: () =>
          Effect.scoped(
            Effect.flatMap(
              fixture.runtime.acquireRuntime(instance.id, {
                idleMs: 30_000,
                start: async () => ({ value: "warm-runtime", close: async () => undefined }),
              }),
              () => Effect.succeed(observation({ instanceId: instance.id })),
            ),
          ) as never,
        acquire: () => Effect.fail({ category: "unsupported", message: "not used" }),
      }),
      uuid: () => crypto.randomUUID(),
      clock: () => now,
    });

    await service.warmEnabledProviders();

    expect(fixture.runtime.hasRuntime(instanceId)).toBe(true);
    await fixture.runtime.closeAll();
  });

  it("keeps warming the remaining providers when one refuses to start", async () => {
    const fixture = serviceFixture({
      instances: [provider(), provider({ id: otherId, displayName: "OpenCode spare" })],
      probe: async (instance) => {
        if (instance.id === instanceId) {
          throw { category: "unavailable", message: "Provider runtime is unavailable." };
        }
        return observation({ instanceId: instance.id });
      },
    });

    await expect(fixture.service.warmEnabledProviders()).resolves.toBeUndefined();

    expect(fixture.runtime.observedState(instanceId)?.readiness).toBe("unavailable");
    expect(fixture.runtime.observedState(otherId)?.readiness).toBe("ready");
  });

  it("reports a driver's refused probe as that refusal instead of a generic degraded state", async () => {
    const fixture = serviceFixture({ instances: [mistralVibeProvider()] });
    const service = new ProviderService({
      persistence: fixture.persistence,
      runtimeRegistry: fixture.runtime,
      driver: () => ({
        kind: "mistral-vibe",
        probe: () =>
          Effect.fail({
            category: "incompatible",
            message: "Mistral Vibe 2.24.1 or later is required.",
          }),
        acquire: () => Effect.die("unused"),
      }),
      uuid: () => crypto.randomUUID(),
      clock: () => now,
    });

    await expect(service.probe(windowId, instanceId)).rejects.toMatchObject({
      failure: { category: "incompatible" },
    });

    expect(fixture.runtime.observedState(instanceId)).toMatchObject({
      readiness: "incompatible",
      message: "Provider configuration is incompatible.",
    });
  });
});

function serviceFixture(
  options: {
    readonly instances?: ReadonlyArray<ProviderInstance>;
    readonly appendError?: Error;
    readonly probeResult?: ReturnType<typeof observation>;
    readonly probe?: (instance: ProviderInstance) => Promise<unknown>;
    readonly driver?: NonNullable<ProviderServiceOptions["driver"]>;
    readonly clearResumeIdentities?: (providerId: typeof instanceId) => Promise<void>;
    readonly clearRuntimeUsageLimits?: (providerId: typeof instanceId) => void;
    readonly withCatalogPersistence?: boolean;
    readonly initialCatalog?: ProviderCatalogSnapshot;
    readonly isDriverPluginEffective?: (driverKind: ProviderInstance["driverKind"]) => boolean;
  } = {},
) {
  let instances = [...(options.instances ?? [])];
  let catalogs: Array<Record<string, unknown>> = options.initialCatalog
    ? [options.initialCatalog]
    : [];
  let defaults: ProviderDefaults = {
    permissionPersistence: "current-session",
    version: 0 as never,
  };
  const append = vi.fn((request: { readonly events: ReadonlyArray<{ readonly payload: any }> }) => {
    if (options.appendError !== undefined) throw options.appendError;
    const payload = request.events[0]?.payload;
    if (payload?.instance !== undefined) {
      instances = [
        ...instances.filter((item) => item.id !== payload.instance.id),
        payload.instance,
      ];
    } else if (payload?.instanceId !== undefined) {
      instances = instances.filter((item) => item.id !== payload.instanceId);
    } else if (payload?.defaults !== undefined) defaults = payload.defaults;
    else if (payload?.snapshot !== undefined) {
      catalogs = [
        ...catalogs.filter((item) => item.instanceId !== payload.snapshot.instanceId),
        payload.snapshot,
      ];
    }
    return {
      aggregateVersion:
        payload?.instance?.version ??
        payload?.version ??
        payload?.defaults?.version ??
        payload?.snapshot?.version,
    };
  });
  const persistenceBase = {
    journal: { append },
    readProviderInstance: (id: typeof instanceId) => instances.find((item) => item.id === id),
    readProviderInstances: () => instances,
    readProviderDefaults: () => defaults,
    status: () => ({ state: "current", integrity: "ok" }),
  };
  const persistence = {
    ...persistenceBase,
    ...(options.withCatalogPersistence
      ? {
          readProviderCatalog: (id: typeof instanceId) =>
            catalogs.find((item) => item.instanceId === id),
          readProviderCatalogs: () => catalogs,
        }
      : {}),
  } as unknown as PersistenceService;
  const runtime = new ProviderRuntimeRegistry();
  const probe = vi.fn(
    options.probe ??
      (async (instance: ProviderInstance) =>
        options.probeResult ?? observation({ instanceId: instance.id })),
  );
  return {
    append,
    catalogs: () => catalogs,
    persistence,
    runtime,
    probe,
    service: new ProviderService({
      persistence,
      runtimeRegistry: runtime,
      probe,
      ...(options.driver === undefined ? {} : { driver: options.driver }),
      ...(options.clearResumeIdentities === undefined
        ? {}
        : { clearResumeIdentities: options.clearResumeIdentities }),
      ...(options.clearRuntimeUsageLimits === undefined
        ? {}
        : { clearRuntimeUsageLimits: options.clearRuntimeUsageLimits }),
      ...(options.isDriverPluginEffective === undefined
        ? {}
        : { isDriverPluginEffective: options.isDriverPluginEffective }),
      uuid: () => crypto.randomUUID(),
      clock: () => now,
    }),
  };
}

function provider(overrides: Record<string, unknown> = {}) {
  return decodeProviderInstance({
    id: instanceId,
    displayName: "OpenCode local",
    driverKind: "opencode",
    configuration: { kind: "opencode-cli", binaryPath: "/opt/homebrew/bin/opencode" },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function httpProvider(overrides: Record<string, unknown> = {}) {
  return decodeProviderInstance({
    id: instanceId,
    displayName: "Private gateway",
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://gateway.example/v1/",
      authentication: "bearer",
      protocol: "auto",
      manualModelIds: ["model-a"],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function claudeProvider(overrides: Record<string, unknown> = {}) {
  return decodeProviderInstance({
    id: instanceId,
    displayName: "Claude local",
    driverKind: "claude",
    configuration: {
      kind: "claude-agent-sdk",
      binaryPath: "/opt/homebrew/bin/claude",
      authentication: "subscription",
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function mistralVibeProvider(overrides: Record<string, unknown> = {}) {
  return decodeProviderInstance({
    id: instanceId,
    displayName: "Mistral Vibe local",
    driverKind: "mistral-vibe",
    configuration: {
      kind: "mistral-vibe-acp",
      binaryPath: "/Users/example/.local/bin/vibe-acp",
      authentication: "subscription",
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function devinProvider(overrides: Record<string, unknown> = {}) {
  return decodeProviderInstance({
    id: instanceId,
    displayName: "Devin local",
    driverKind: "devin",
    configuration: {
      kind: "devin-acp",
      binaryPath: "/Users/example/.local/bin/devin",
      authentication: "subscription",
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function piProvider(overrides: Record<string, unknown> = {}) {
  return decodeProviderInstance({
    id: instanceId,
    displayName: "Pi local",
    driverKind: "pi",
    configuration: { kind: "pi-rpc", binaryPath: "/opt/homebrew/bin/pi" },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function kiloProvider(overrides: Record<string, unknown> = {}) {
  return decodeProviderInstance({
    id: instanceId,
    displayName: "Kilo local",
    driverKind: "kilo",
    configuration: { kind: "kilo-acp", binaryPath: "/opt/homebrew/bin/kilo" },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function ollamaProvider(overrides: Record<string, unknown> = {}) {
  return decodeProviderInstance({
    id: instanceId,
    displayName: "Ollama local",
    driverKind: "ollama",
    configuration: { kind: "ollama-native-http", baseUrl: "http://127.0.0.1:11434" },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function unavailableCapabilities() {
  return Object.fromEntries(Object.keys(capabilities).map((key) => [key, "unavailable"]));
}

function observation(overrides: Record<string, unknown> = {}) {
  return decodeProviderObservedState({
    instanceId,
    readiness: "ready",
    processState: "running",
    models: [
      {
        id: "model-1",
        displayName: "Model One",
        source: "discovered",
        verification: "verified",
        reasoning: "supported",
        inputModalities: ["text"],
        options: [],
      },
    ],
    capabilities,
    observedAt: now,
    ...overrides,
  });
}

function persistedCatalog(): ProviderCatalogSnapshot {
  return decodeProviderCatalogSnapshot({
    instanceId,
    version: 1,
    models: observation().models,
    manualModelOrder: [],
    invalidated: false,
    updatedAt: now,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function rejected(value: Promise<unknown>): Promise<any> {
  try {
    await value;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}
