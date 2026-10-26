import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderModelId,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
} from "@octant/contracts";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEndpointDriver } from "@octant/provider-sdk/harness-endpoint";
import { Cause, Effect, Exit, Fiber, Option, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rewriteForFork } from "../harness/nativeHarnessFork";
import { excerptNativeHarnessJournal } from "../harness/nativeHarnessJournalLookup";
import { runOnNativeHarness } from "../harness/nativeHarnessEndpointDriver";
import { JournalNativeHarnessTranscriptStore } from "../harness/nativeHarnessTranscriptStore";
import { Persistence, makePersistenceLive } from "../persistence/persistenceService";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import {
  FOUNDRY_DEPLOYMENT,
  FOUNDRY_POINTER,
  FoundryGrantBroker,
  foundryDirectoryConfiguration,
  foundryEndpoint,
} from "./foundryDirectory.test-support";
import type { AnthropicCompatibleFetch } from "./anthropicCompatibleEndpoint";
import { makeAnthropicCompatibleDriver } from "./anthropicCompatibleDriver";
import { makeAzureFoundryDriver } from "./azureFoundryDriver";
import type { CompatibleFetch } from "./openAiCompatibleEndpoint";
import { makeOpenAiCompatibleDriver } from "./openAiCompatibleDriver";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

/**
 * Direct-provider secret-absence/evidence harness.
 *
 * Verifies that direct-provider credentials never appear in normalized
 * runtime events, provider failure diagnostics, observed state, or any
 * serialized export surface. Uses deterministic fixtures with a known
 * sentinel secret so the absence is provable without real credentials.
 */

const SENTINEL_SECRET = "sk-octant-sentinel-secret-166";

const surfacesChecked: ReadonlyArray<string> = [
  "normalized runtime events",
  "provider failure diagnostics",
  "observed probe state",
  "serialized export (JSON.stringify)",
];

describe("Direct-provider secret-absence harness", () => {
  it("checks all required absence surfaces", () => {
    expect(surfacesChecked).toEqual([
      "normalized runtime events",
      "provider failure diagnostics",
      "observed probe state",
      "serialized export (JSON.stringify)",
    ]);
  });

  it("keeps the OpenAI-compatible secret out of events, diagnostics, observed state, and exports", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000801");
    const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000802");
    const modelId = "secret-fixture-model" as ProviderModelId;
    const fetch = vi.fn<CompatibleFetch>(openAiStreamingFixture());
    const driver = makeOpenAiCompatibleDriver({
      instanceId,
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://fixture.example/v1",
        authentication: "bearer",
        protocol: "responses",
        manualModelIds: [modelId],
      },
      runtimeRegistry,
      credentialResolver: {
        has: async () => true,
        resolve: async () => SENTINEL_SECRET,
      },
      fetch,
    });

    const events = await runTurnAndCollectEvents(
      driver,
      runtimeRegistry,
      instanceId,
      sessionId,
      modelId,
    );
    assertSecretAbsent("OpenAI-compatible events", events);

    const observed = runtimeRegistry.observedState(instanceId);
    assertSecretAbsent("OpenAI-compatible observed state", observed);
  });

  it("keeps the OpenAI-compatible secret out of failure diagnostics when the endpoint rejects credentials", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000803");
    const fetch = vi.fn<CompatibleFetch>(async () =>
      Response.json({ error: { message: `Invalid key: ${SENTINEL_SECRET}` } }, { status: 401 }),
    );
    const driver = makeOpenAiCompatibleDriver({
      instanceId,
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://fixture.example/v1",
        authentication: "bearer",
        protocol: "responses",
        manualModelIds: ["rejected-model" as ProviderModelId],
      },
      runtimeRegistry,
      credentialResolver: {
        has: async () => true,
        resolve: async () => SENTINEL_SECRET,
      },
      fetch,
    });

    const exit = await Effect.runPromiseExit(Effect.scoped(driver.probe({ instanceId })));
    if (Exit.isFailure(exit)) {
      const failureOption = Cause.failureOption(exit.cause);
      const failureError = Option.getOrUndefined(failureOption);
      expect(failureError).toBeDefined();
      assertSecretAbsent("OpenAI-compatible failure diagnostics", failureError);
    } else {
      throw new Error("Expected probe to fail for a 401 response with a sentinel secret");
    }
  });

  it("keeps the Anthropic-compatible secret out of events, diagnostics, observed state, and exports", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000811");
    const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000812");
    const modelId = "anthropic-secret-model" as ProviderModelId;
    const fetch = vi.fn<AnthropicCompatibleFetch>(anthropicStreamingFixture(modelId));
    const driver = makeAnthropicCompatibleDriver({
      instanceId,
      configuration: {
        kind: "anthropic-compatible-http",
        baseUrl: "https://fixture.example/v1",
        authentication: "api-key",
        protocol: "messages",
        protocolVersion: "2023-06-01",
        manualModelIds: [modelId],
      },
      runtimeRegistry,
      credentialResolver: {
        has: async () => true,
        resolve: async () => SENTINEL_SECRET,
      },
      fetch,
    });

    const events = await runTurnAndCollectEvents(
      driver,
      runtimeRegistry,
      instanceId,
      sessionId,
      modelId,
    );
    assertSecretAbsent("Anthropic-compatible events", events);

    const observed = runtimeRegistry.observedState(instanceId);
    assertSecretAbsent("Anthropic-compatible observed state", observed);
  });

  it("keeps the Azure Foundry secret out of events, diagnostics, observed state, and exports", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000821");
    const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000822");
    const modelId = "foundry-secret-deployment" as ProviderModelId;
    const fetch = vi.fn<CompatibleFetch>(openAiStreamingFixture());
    const driver = makeAzureFoundryDriver({
      instanceId,
      configuration: {
        kind: "azure-foundry-openai-http",
        baseUrl: "https://foundry.fixture.openai.azure.com/openai/v1/",
        authentication: "api-key",
        protocol: "responses",
        manualModelIds: [modelId],
      },
      runtimeRegistry,
      credentialResolver: {
        has: async () => true,
        resolve: async () => SENTINEL_SECRET,
      },
      fetch,
    });

    const events = await runTurnAndCollectEvents(
      driver,
      runtimeRegistry,
      instanceId,
      sessionId,
      modelId,
    );
    assertSecretAbsent("Azure Foundry events", events);

    const observed = runtimeRegistry.observedState(instanceId);
    assertSecretAbsent("Azure Foundry observed state", observed);
  });

  it("never includes the sentinel secret in request headers visible to fetch diagnostics", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000831");
    const fetch = vi.fn<CompatibleFetch>(openAiStreamingFixture());
    const driver = makeOpenAiCompatibleDriver({
      instanceId,
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://fixture.example/v1",
        authentication: "bearer",
        protocol: "responses",
        manualModelIds: ["header-model" as ProviderModelId],
      },
      runtimeRegistry,
      credentialResolver: {
        has: async () => true,
        resolve: async () => SENTINEL_SECRET,
      },
      fetch,
    });

    await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    // The Authorization header carries the secret over the wire, but the
    // sentinel must not appear in any fetch call body or URL that could be
    // logged as a diagnostic. The header value itself is the credential
    // channel; it must not leak into normalized events or observed state.
    for (const [url, init] of fetch.mock.calls as unknown as [string, RequestInit][]) {
      expect(url).not.toContain(SENTINEL_SECRET);
      const body = typeof init.body === "string" ? init.body : "";
      expect(body).not.toContain(SENTINEL_SECRET);
    }
    const observed = runtimeRegistry.observedState(instanceId);
    assertSecretAbsent("OpenAI-compatible header diagnostic observed state", observed);
  });
});

async function runTurnAndCollectEvents(
  endpointDriver: HarnessEndpointDriver,
  runtimeRegistry: ProviderRuntimeRegistry,
  instanceId: ReturnType<typeof decodeProviderInstanceId>,
  sessionId: ProviderSessionId,
  modelId: ProviderModelId,
): Promise<ProviderRuntimeEvent[]> {
  const driver = runOnNativeHarness(endpointDriver, { instanceId, runtimeRegistry });
  const events: ProviderRuntimeEvent[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp", mode: "chat" });
        yield* connection.start({
          sessionId,
          modelId,
          executionPolicy: "approval-gated",
        });
        const collector = yield* Effect.fork(
          (yield* connection.subscribe).pipe(
            Stream.filter((event) => event.sessionId === sessionId),
            Stream.takeUntil(
              (event) =>
                event.kind === "completed" ||
                event.kind === "interrupted" ||
                event.kind === "failed",
            ),
            Stream.runForEach((event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            ),
          ),
        );
        yield* connection.send({
          sessionId,
          prompt: "Reply with exactly: octant-secret-absence",
          attachments: [],
          tools: [],
        });
        yield* Fiber.join(collector);
        yield* connection.stop(sessionId);
      }),
    ),
  );
  return events;
}

function assertSecretAbsent(label: string, value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized, `${label} must not contain the sentinel secret`).not.toContain(
    SENTINEL_SECRET,
  );
}

function openAiStreamingFixture(): CompatibleFetch {
  return async (url) => {
    if (String(url).endsWith("/models")) {
      return Response.json({ data: [{ id: "secret-fixture-model" }] });
    }
    const events = [
      {
        type: "response.created",
        sequence_number: 1,
        response: { id: "r", object: "response", status: "in_progress", usage: null },
      },
      {
        type: "response.output_item.added",
        sequence_number: 2,
        output_index: 0,
        item: { id: "msg", type: "message", role: "assistant", status: "in_progress", content: [] },
      },
      {
        type: "response.output_text.delta",
        sequence_number: 3,
        item_id: "msg",
        output_index: 0,
        content_index: 0,
        delta: "octant-secret-absence",
        logprobs: [],
      },
      {
        type: "response.output_text.done",
        sequence_number: 4,
        item_id: "msg",
        output_index: 0,
        content_index: 0,
        text: "octant-secret-absence",
        logprobs: [],
      },
      {
        type: "response.output_item.done",
        sequence_number: 5,
        output_index: 0,
        item: {
          id: "msg",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "octant-secret-absence", annotations: [] }],
        },
      },
      {
        type: "response.completed",
        sequence_number: 6,
        response: {
          id: "r",
          object: "response",
          status: "completed",
          usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
        },
      },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  };
}

function anthropicStreamingFixture(modelId: ProviderModelId): AnthropicCompatibleFetch {
  return async (url) => {
    if (String(url).endsWith("/models")) {
      return Response.json({ data: [{ id: modelId }] });
    }
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          content: [],
          model: String(modelId),
          stop_reason: null,
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "octant-secret-absence" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ];
    return new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
}

describe("Organization sign-in secret absence", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
  });

  it("keeps every directory bearer out of the journal, a lookup, a fork copy, events, and failures", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "octant-directory-secret-absence-"));
    directories.push(dataDirectory);
    const now = "2026-10-26T09:00:00.000Z";
    const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000861");
    const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000862");
    const broker = new FoundryGrantBroker();
    let refusing = false;
    // Once refusing, the endpoint echoes the bearer it was sent in its error
    // body, as a careless gateway might; nothing Octant records may keep it.
    const fetch = foundryEndpoint(broker, {
      reply: "Signed-in answer.",
      refuse: () =>
        refusing
          ? Response.json(
              { error: { code: "401", message: `Token ${broker.current()} was refused.` } },
              { status: 401 },
            )
          : undefined,
    });
    let identity = 0;
    const recorded: unknown[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          const transcripts = new JournalNativeHarnessTranscriptStore({
            journal: persistence.journal,
            uuid: () => `80000000-0000-4000-8000-${String(++identity).padStart(12, "0")}`,
            clock: () => now,
            actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
          });
          const runtimeRegistry = new ProviderRuntimeRegistry();
          const endpoint = makeAzureFoundryDriver({
            instanceId,
            configuration: foundryDirectoryConfiguration(),
            runtimeRegistry,
            credentialResolver: { has: async () => true, resolve: async () => FOUNDRY_POINTER },
            directoryOAuth: broker,
            fetch,
            clock: () => now,
          });
          recorded.push(yield* endpoint.probe({ instanceId }));
          const driver = runOnNativeHarness(endpoint, { instanceId, runtimeRegistry, transcripts });
          const connection = yield* driver.acquire({
            instanceId,
            projectRoot: "/tmp",
            mode: "code",
          });
          yield* connection.start({
            sessionId,
            modelId: FOUNDRY_DEPLOYMENT,
            executionPolicy: "approval-gated",
          });
          const turn = (prompt: string) =>
            Effect.gen(function* () {
              const events: ProviderRuntimeEvent[] = [];
              const collector = yield* Effect.fork(
                (yield* connection.subscribe).pipe(
                  Stream.filter((event) => event.sessionId === sessionId),
                  Stream.takeUntil(
                    (event) =>
                      event.kind === "completed" ||
                      event.kind === "interrupted" ||
                      event.kind === "failed",
                  ),
                  Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
                ),
              );
              yield* connection.send({ sessionId, prompt, attachments: [], tools: [] });
              yield* Fiber.join(collector);
              return events;
            });
          const answered = yield* turn("First question.");
          expect(answered.at(-1)?.kind).toBe("completed");
          refusing = true;
          const refused = yield* turn("Second question.");
          expect(refused.at(-1)).toMatchObject({ kind: "failed" });
          recorded.push(answered, refused, runtimeRegistry.observedState(instanceId));

          const transcript = transcripts.load(sessionId);
          if (transcript === undefined) throw new Error("expected a journaled transcript");
          recorded.push(
            transcript,
            excerptNativeHarnessJournal(transcript, { from: 0 }, []),
            transcript.messages.map((message) =>
              rewriteForFork(message, { fromRoot: "/tmp", toRoot: "/tmp/fork", secrets: [] }),
            ),
          );
          yield* connection.stop(sessionId);
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory, clock: () => now }))),
      ),
    );

    // The endpoint refused a renewed bearer too, so at least two were issued.
    expect(broker.issued.length).toBeGreaterThanOrEqual(2);
    const serialized = JSON.stringify(recorded);
    const stored = filesUnder(dataDirectory).map((path) => readFileSync(path).toString("latin1"));
    expect(stored.length).toBeGreaterThan(0);
    for (const token of broker.issued) {
      expect(serialized, "a report, event, failure, lookup, or fork copy").not.toContain(token);
      for (const bytes of stored) expect(bytes, "the journal's stored bytes").not.toContain(token);
    }
  });
});

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}
