import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeAggregateVersion,
  decodeChatThread,
  decodeProject,
  decodeProviderInstance,
  decodeProviderModel,
  decodeSpendCeilingReservationId,
  decodeUtcTimestamp,
  decodeWorkThread,
  type WorkProject,
} from "@octant/contracts";
import type { ShellSettings, ThreadTitleSettings } from "@octant/contracts/shell";
import { defaultShellSettings } from "@octant/domain";
import { encodeSubscriptionOAuthCredential } from "@octant/provider-sdk/subscription-oauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runOnNativeHarness } from "../harness/nativeHarnessEndpointDriver";
import { readAggregateVersion, readChatThread } from "../persistence/chatProjection";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { readAllUsageRecords } from "../persistence/usageProjection";
import { makeOpenAiCompatibleDriver } from "../providers/openAiCompatibleDriver";
import type { CompatibleFetch } from "../providers/openAiCompatibleEndpoint";
import { ProviderRuntimeRegistry } from "../providers/providerRuntimeRegistry";
import { SpendCeilingService } from "../spendCeilingService";
import { WorkThreadProjection } from "../work/workThreadProjection";
import { createThreadTitleGenerator, threadTitleSubscriptionCredentials } from "./threadTitle";

const now = decodeUtcTimestamp("2026-11-23T12:00:00.000Z");
const version = decodeAggregateVersion(1);
const prompt = "Fix launch retries. api_key=example-private-value";
const apiKey = "fixture-api-key";
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function titleStream(text: string): Response {
  const chunks = [
    { choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 19, completion_tokens: 4, total_tokens: 23 } },
  ];
  return new Response(
    chunks
      .map(
        (chunk) =>
          `data: ${JSON.stringify({ id: "title-chunk", object: "chat.completion.chunk", ...chunk })}\n\n`,
      )
      .join("") + "data: [DONE]\n\n",
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function planTitleStream(): Response {
  const text = "Fix launch retries";
  const item = { id: "title-message", type: "message", role: "assistant" };
  const events = [
    {
      type: "response.created",
      sequence_number: 1,
      response: { id: "title-response", object: "response", status: "in_progress", usage: null },
    },
    {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 3,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
    },
    {
      type: "response.output_text.done",
      sequence_number: 4,
      item_id: item.id,
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
        ...item,
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      sequence_number: 6,
      response: {
        id: "title-response",
        object: "response",
        status: "completed",
        usage: { input_tokens: 19, output_tokens: 4, total_tokens: 23 },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function fixture(
  plan?: { readonly usageGranted?: boolean; readonly plainKey?: boolean },
  workProject?: WorkProject,
) {
  const directory = mkdtempSync(join(tmpdir(), "octant-thread-title-"));
  const connection = openSqlite(join(directory, "journal.sqlite"));
  cleanups.push(() => {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  });
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const provider = decodeProviderInstance({
    id: randomUUID(),
    displayName: "Title API",
    enabled: true,
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: plan === undefined ? "https://title.example/v1" : "https://api.openai.com/v1",
      authentication: "bearer",
      protocol: plan === undefined ? "chat-completions" : "responses",
      ...(plan === undefined ? {} : { oauthDescriptorId: "chatgpt-plan" }),
      manualModelIds: ["title-mini"],
    },
    environmentPolicy: "inherit-host",
    version,
    createdAt: now,
    updatedAt: now,
  });
  if (provider.driverKind !== "openai-compatible")
    throw new Error("Expected a direct API provider");
  const model = decodeProviderModel({
    id: "title-mini",
    displayName: "Title Mini",
    options: [],
    reasoning: "unavailable",
    inputModalities: ["text"],
    source: "manual",
    verification: "unverified",
  });
  const thread = decodeChatThread({
    id: randomUUID(),
    title: prompt,
    lifecycle: "active",
    providerInstanceId: randomUUID(),
    modelId: "agent-subscription-model",
    researchEnabled: false,
    researchRouting: "automatic",
    personalityInstructions: "Agent-only instructions",
    version,
    createdAt: now,
    updatedAt: now,
  });
  function writeTitle(title: string) {
    const expectedVersion = readAggregateVersion(connection, "chat-thread", thread.id);
    const created = expectedVersion === 0;
    journal.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: thread.id },
      expectedVersion,
      events: [
        {
          eventId: randomUUID(),
          eventName: created ? "chat.thread-created@1" : "chat.thread-updated@1",
          eventVersion: 1,
          correlationId: randomUUID(),
          actor: { kind: "local-user", actorId: randomUUID() },
          occurredAt: now,
          payload: {
            kind: created ? "thread-created" : "thread-updated",
            thread: { ...thread, title, version: expectedVersion + 1 },
          },
        },
      ],
    });
  }
  writeTitle(prompt);
  const workThreads = new WorkThreadProjection();
  const workThread =
    workProject === undefined
      ? undefined
      : decodeWorkThread({
          id: randomUUID(),
          projectId: workProject.id,
          title: prompt,
          lifecycle: "active",
          providerInstanceId: thread.providerInstanceId,
          modelId: thread.modelId,
          version,
          createdAt: now,
          updatedAt: now,
        });
  if (workThread !== undefined) workThreads.apply({ kind: "thread-created", thread: workThread });
  const fetch = vi.fn<CompatibleFetch>(async () =>
    plan === undefined ? titleStream('"Fix launch retries"') : planTitleStream(),
  );
  const registry = new ProviderRuntimeRegistry();
  const broker = {
    has: async () => true,
    resolve: vi.fn(async () =>
      plan === undefined || plan.plainKey === true
        ? apiKey
        : encodeSubscriptionOAuthCredential({
            kind: "subscription-oauth",
            credentialRef: "7c1e1d3f-1e4b-4051-8d2b-7f6e5d4c3b2a",
            descriptorId: "chatgpt-plan",
            accountLabel: "ChatGPT plan",
          }),
    ),
  };
  const makeDriver = (requestFetch: CompatibleFetch) =>
    runOnNativeHarness(
      makeOpenAiCompatibleDriver({
        instanceId: provider.id,
        configuration: provider.configuration,
        runtimeRegistry: registry,
        fetch: requestFetch,
        credentialResolver:
          plan === undefined ? broker : threadTitleSubscriptionCredentials(broker),
        ...(plan === undefined
          ? {}
          : {
              subscriptionOAuth: {
                refresh: async () => ({ kind: "refreshed" as const }),
                access: async () => ({
                  kind: "granted" as const,
                  accessToken: "plan-access-token",
                  subscriptionUsageGranted: plan.usageGranted ?? true,
                }),
              },
            }),
      }),
      { instanceId: provider.id, runtimeRegistry: registry },
    );
  const choice = { providerInstanceId: provider.id, modelId: model.id };
  const startingSettings: ShellSettings = {
    ...defaultShellSettings(),
    threadTitles:
      plan === undefined
        ? { source: "api", apiModel: choice }
        : { source: "subscription", subscriptionModel: choice },
  };
  let settings: ShellSettings = startingSettings;
  const spendCeiling = new SpendCeilingService({
    connection,
    journal,
    clock: () => now,
    uuid: randomUUID,
  });
  const generate = createThreadTitleGenerator({
    persistence: {
      connection,
      journal,
      readShellSettings: () => ({ settings, aggregateVersion: version }),
      readChatThread: (id) => readChatThread(connection, id),
      readCodeThread: () => undefined,
      readProviderInstance: (id) => (id === provider.id ? provider : undefined),
      readProviderCatalog: () => ({
        instanceId: provider.id,
        version,
        updatedAt: now,
        invalidated: false,
        manualModelOrder: [model.id],
        models: [model],
      }),
      readProject: (id) => (workProject?.id === id ? workProject : undefined),
    },
    workThreads,
    fetch,
    resolveDriver: (id, _source, requestFetch) =>
      id === provider.id ? makeDriver(requestFetch) : undefined,
    accountUnavailable: () => undefined,
    isHeld: () => false,
    leavesNoTrace: () => false,
    spendCeiling,
    scratchRoot: "/tmp",
  });

  return {
    fetch,
    generate: (message = prompt) =>
      workThread === undefined
        ? generate("chat", thread.id, message)
        : generate("work", workThread.id, message),
    readTitle: () =>
      workThread === undefined
        ? readChatThread(connection, thread.id)?.title
        : workThreads.read(workThread.id)?.title,
    writeTitle,
    readUsage: () => readAllUsageRecords(connection),
    resolveCredentials: broker.resolve,
    setWorkProject: (project: WorkProject) => {
      workProject = project;
    },
    setTokenCeiling: () =>
      spendCeiling.execute("local-window", {
        kind: "set-spend-ceiling",
        scope: { kind: "thread", threadType: "chat-thread", threadId: thread.id },
        expectedVersion: decodeAggregateVersion(0),
        policy: { tokenBudget: 100_000, maxTokensPerTurn: 10_000 },
        window: { kind: "lifetime" },
      }),
    admitLastTurn: () => {
      const scope = { kind: "thread", threadType: "chat-thread", threadId: thread.id } as const;
      spendCeiling.execute("local-window", {
        kind: "set-spend-ceiling",
        scope,
        expectedVersion: decodeAggregateVersion(0),
        policy: { turnBudget: 1 },
        window: { kind: "lifetime" },
      });
      return spendCeiling.admit({
        reservationId: decodeSpendCeilingReservationId(randomUUID()),
        threadId: scope.threadId,
        threadType: scope.threadType,
      });
    },
    setSource: (source: ThreadTitleSettings["source"]) => {
      settings = {
        ...settings,
        threadTitles: { apiModel: choice, subscriptionModel: choice, source },
      };
    },
  };
}

describe("Model-backed thread titles", () => {
  it("uses the selected API endpoint and records usage under the thread", async () => {
    const test = fixture();
    await test.generate();
    expect(test.readTitle()).toBe("Fix launch retries");
    expect(test.fetch).toHaveBeenCalledTimes(1);
    const request = test.fetch.mock.calls[0];
    expect(request?.[0]).toBe("https://title.example/v1/chat/completions");
    const init = request?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "title-mini",
      messages: [
        { role: "system", content: expect.stringContaining("short, plain-text title") },
        { role: "user", content: "Fix launch retries. [redacted]" },
      ],
    });
    expect(body).not.toHaveProperty("tools");
    expect(test.readUsage()).toMatchObject([
      {
        requestShape: "thread-title",
        subject: { aggregateType: "chat-thread" },
        inputTokens: 19,
      },
    ]);
  });

  it("uses the authorized ChatGPT plan for a subscription title", async () => {
    const test = fixture({});
    await test.generate();
    expect(test.readTitle()).toBe("Fix launch retries");
    expect(test.fetch).toHaveBeenCalledTimes(1);
    const request = test.fetch.mock.calls[0];
    expect(request?.[0]).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(request?.[1]?.headers).get("authorization")).toBe(
      "Bearer plan-access-token",
    );
    const body = JSON.parse(String(request?.[1]?.body));
    expect(body).toMatchObject({ model: "title-mini", store: false, stream: true });
    expect(JSON.stringify(body)).toContain("Fix launch retries. [redacted]");
    expect(body).not.toHaveProperty("tools");
  });

  it("keeps the first-message title when the saved account belongs to the other source", async () => {
    const test = fixture({});
    test.setSource("api");
    await test.generate();
    expect(test.fetch).not.toHaveBeenCalled();
    expect(test.readTitle()).toBe(prompt);
  });

  it.each([{ usageGranted: false }, { plainKey: true }])(
    "does not send a subscription request with missing plan authorization (%j)",
    async (plan) => {
      const test = fixture(plan);
      await test.generate();
      expect(test.fetch).not.toHaveBeenCalled();
      expect(test.readTitle()).toBe(prompt);
      expect(test.readUsage()).toEqual([]);
    },
  );

  it("keeps the first-message title when the thread has a token ceiling", async () => {
    const test = fixture();
    expect(test.setTokenCeiling().kind).toBe("set");
    await test.generate();
    expect(test.fetch).not.toHaveBeenCalled();
    expect(test.readTitle()).toBe(prompt);
    expect(test.readUsage()).toEqual([]);
  });

  it("rechecks Project provider policy after resolving credentials", async () => {
    const binding = { canonicalRoot: "/tmp/title-project" };
    const project = decodeProject({
      id: randomUUID(),
      type: "work",
      name: "Title Project",
      lifecycle: "active",
      pinned: false,
      rank: "0/1",
      version,
      createdAt: now,
      updatedAt: now,
      binding,
      bindingHistory: [
        {
          revisionId: randomUUID(),
          revision: 1,
          currentBinding: binding,
          actor: { kind: "local-user", actorId: randomUUID() },
          changedAt: now,
        },
      ],
    });
    if (project.type !== "work") throw new Error("Expected a Work Project.");
    const test = fixture(undefined, project);
    test.resolveCredentials.mockImplementationOnce(async () => {
      test.setWorkProject({
        ...project,
        providerPolicy: { mode: "eu-zdr", providerInstanceIds: [] },
      });
      return apiKey;
    });
    await test.generate();
    expect(test.resolveCredentials).toHaveBeenCalledOnce();
    expect(test.fetch).not.toHaveBeenCalled();
    expect(test.readUsage()).toEqual([]);
    expect(test.readTitle()).toBe(prompt);
  });

  it("replaces the first-message title from a paired to-do draft", async () => {
    const test = fixture();
    const message =
      "Please investigate the launch retries and add regression coverage for reconnecting.";
    test.writeTitle(message.slice(0, 60));
    await test.generate(message);
    expect(test.readTitle()).toBe("Fix launch retries");
  });

  it("names the thread when its active turn uses the last turn allowance", async () => {
    const test = fixture();
    expect(test.admitLastTurn().status).toBe("admitted");
    await test.generate();
    expect(test.readTitle()).toBe("Fix launch retries");
    expect(test.readUsage()).toHaveLength(1);
  });

  it("allows one endpoint request across concurrent calls and an explicit retry", async () => {
    const test = fixture();
    test.fetch.mockResolvedValue(new Response(null, { status: 401 }));
    await Promise.all([test.generate(), test.generate()]);
    await test.generate();
    expect(test.readTitle()).toBe(prompt);
    expect(test.fetch).toHaveBeenCalledOnce();
    expect(test.readUsage()).toHaveLength(1);
  });

  it("keeps a manual rename made while the endpoint is answering", async () => {
    const test = fixture();
    test.fetch.mockImplementationOnce(async () => {
      test.writeTitle("My release prep");
      return titleStream("A title from the endpoint");
    });
    await test.generate();
    expect(test.fetch).toHaveBeenCalledTimes(1);
    expect(test.readTitle()).toBe("My release prep");
    expect(test.readUsage()).toHaveLength(1);
  });

  it("keeps the prompt title if the API refuses the key or the setting is off", async () => {
    const test = fixture();
    test.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await test.generate();
    expect(test.readTitle()).toBe(prompt);
    test.setSource("first-message");
    await test.generate();
    expect(test.fetch).toHaveBeenCalledTimes(1);
    expect(test.readTitle()).toBe(prompt);
    expect(test.readUsage()).toHaveLength(1);
  });
});
