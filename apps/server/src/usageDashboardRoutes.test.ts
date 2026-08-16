import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeUsageDashboardResponse,
  type UsageDashboardResponse,
  type WindowWorkspace,
} from "@octant/contracts";
import { createUsageDashboardRouteHandler } from "./usageDashboardRoutes";
import { resolveWindowProjectScope, type UsageProjectScope } from "./usageProjectScope";
import { Journal } from "./persistence/journal";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { createPhase1RuntimeRegistries } from "./persistence/runtimeRegistry";
import { openSqlite } from "./persistence/sqlitePort";
import { USAGE_PROJECTION_SCHEMA_VERSION } from "./persistence/usagePersistenceSchema";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const directories: Array<string> = [];
const now = "2026-07-24T12:00:00.000Z";
const nowMs = new Date(now).getTime();
const ids = {
  actor: "64000000-0000-4000-8000-000000000001",
  correlation: "64000000-0000-4000-8000-000000000002",
  aggregate: "64000000-0000-4000-8000-000000000003",
  provider: "64000000-0000-4000-8000-000000000004",
  entry: "64000000-0000-4000-8000-000000000005",
  manifest: "64000000-0000-4000-8000-000000000006",
  plan: "64000000-0000-4000-8000-000000000007",
  usage: "64000000-0000-4000-8000-000000000008",
  window: "64000000-0000-4000-8000-000000000009",
  projectA: "64000000-0000-4000-8000-00000000000a",
  projectB: "64000000-0000-4000-8000-00000000000b",
  threadA: "64000000-0000-4000-8000-00000000000c",
  threadB: "64000000-0000-4000-8000-00000000000d",
  unfiledThread: "64000000-0000-4000-8000-00000000000e",
} as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(projectScope: UsageProjectScope = { kind: "unfiled" }) {
  const directory = mkdtempSync(join(tmpdir(), "octant-usage-dashboard-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });

  const windowAuthorityStore = new WindowAuthorityStore();
  const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
  windowAuthorityStore.register({ windowId: ids.window as never, capability, now: nowMs });

  const handler = createUsageDashboardRouteHandler({
    connection,
    windowAuthorityStore,
    readWindowProjectScope: () => projectScope,
    now: () => nowMs,
    clock: () => now,
  });

  return { connection, journal, handler, capability, windowAuthorityStore };
}

function seedUsageData(journal: Journal): void {
  journal.append({
    aggregate: { aggregateType: "context-ledger", aggregateId: ids.aggregate },
    expectedVersion: 0,
    events: [
      {
        eventId: crypto.randomUUID(),
        eventName: "context.manifest-created@1",
        eventVersion: 1,
        correlationId: ids.correlation,
        actor: { kind: "system", actorId: ids.actor },
        occurredAt: now,
        payload: {
          manifest: {
            id: ids.manifest,
            subject: { aggregateType: "chat-thread", aggregateId: ids.aggregate },
            providerInstanceId: ids.provider,
            modelId: "gpt-4o",
            entries: [
              {
                id: ids.entry,
                source: { kind: "message", referenceId: "msg-1" },
                category: "conversation",
                label: "History",
                eligibility: {
                  providerInstanceId: ids.provider,
                  status: "eligible",
                  reason: "selected-provider",
                },
                posture: "required",
                retention: "active",
                priority: 100,
                originalSize: 200,
                includedSize: 200,
                tokens: { kind: "known", tokens: 50, accuracy: "exact-tokenizer" },
                state: "included",
                introducedAtTurn: 1,
                lastUsedAtTurn: 1,
                reuseCount: 0,
                preview: { redacted: true, label: "History" },
              },
            ],
            overrides: { pinnedEntryIds: [], excludedEntryIds: [] },
            createdAt: now,
          },
        },
      },
      {
        eventId: crypto.randomUUID(),
        eventName: "context.plan-created@1",
        eventVersion: 1,
        correlationId: ids.correlation,
        actor: { kind: "system", actorId: ids.actor },
        occurredAt: now,
        payload: {
          plan: {
            id: ids.plan,
            manifestId: ids.manifest,
            safeInputBudget: 100_000,
            plannedInputTokens: 50,
            reserves: { response: 4_096, reasoning: 0, framing: 1_000, variance: 500, safety: 0 },
            entries: [
              {
                entryId: ids.entry,
                state: "included",
                tokens: { kind: "known", tokens: 50, accuracy: "exact-tokenizer" },
                reason: "required",
              },
            ],
            health: "healthy",
            blocked: false,
            remedies: [],
            createdAt: now,
          },
        },
      },
      {
        eventId: crypto.randomUUID(),
        eventName: "context.usage-reconciled@1",
        eventVersion: 1,
        correlationId: ids.correlation,
        actor: { kind: "system", actorId: ids.actor },
        occurredAt: now,
        payload: {
          reconciliation: {
            id: ids.usage,
            planId: ids.plan,
            providerInstanceId: ids.provider,
            modelId: "gpt-4o",
            requestShape: "chat-turn",
            plannedInputTokens: 50,
            actualInputTokens: 50,
            actualOutputTokens: 25,
            reasoningTokens: 11,
            cacheReadInputTokens: 7,
            cacheWriteInputTokens: 2,
            providerExecutionDurationMs: 840,
            varianceTokens: 0,
            observedAt: now,
          },
        },
      },
    ],
  });
}

/**
 * One Chat thread per Project plus one unfiled thread, each with a usage row.
 * Written straight to the projections the dashboard reads so the fixture states
 * exactly which rows a Project-scoped window may and may not receive.
 */
function seedProjectScopedUsage(connection: ReturnType<typeof openSqlite>): void {
  const threads: ReadonlyArray<readonly [string, string | null]> = [
    [ids.threadA, ids.projectA],
    [ids.threadB, ids.projectB],
    [ids.unfiledThread, null],
  ];
  threads.forEach(([threadId, projectId], index) => {
    connection
      .prepare(`
        INSERT INTO chat_thread_projection (
          thread_id, project_id, lifecycle, schema_version, thread_json,
          aggregate_version, updated_at, last_sequence
        ) VALUES (?, ?, 'active', 1, '{}', 1, ?, 1)
      `)
      .run(threadId, projectId, now);
    connection
      .prepare(`
        INSERT INTO usage_record_projection (
          reconciliation_id, subject_type, subject_id, provider_instance_id,
          model_id, request_shape, quality, input_tokens, output_tokens,
          planned_input_tokens, variance_tokens, schema_version,
          attribution_json, observed_at, last_sequence, host_id
        ) VALUES (?, 'chat-thread', ?, ?, ?, 'chat-turn', 'exact', ?, 50, 95, 5, ?, ?, ?, ?, 'local')
      `)
      .run(
        `64000000-0000-4000-8000-0000000001${index}0`,
        threadId,
        ids.provider,
        `model-${index}`,
        100,
        USAGE_PROJECTION_SCHEMA_VERSION,
        JSON.stringify([{ category: "conversation", plannedTokens: 95, quality: "exact" }]),
        now,
        index + 1,
      );
  });
}

function makeRequest(
  options: {
    method?: string;
    body?: unknown;
    capability?: string;
    origin?: string;
    path?: string;
  } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.capability !== undefined) {
    headers["x-octant-window-capability"] = options.capability;
  }
  if (options.origin !== undefined) headers.origin = options.origin;
  return new Request(`http://127.0.0.1:3100${options.path ?? "/api/usage/dashboard"}`, {
    method: options.method ?? "POST",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

describe("usage dashboard route authority", () => {
  it("ignores paths it does not own", async () => {
    const { handler } = setup();
    expect(await handler(makeRequest({ path: "/api/usage/query" }))).toBeUndefined();
  });

  it("rejects a non-loopback request", async () => {
    const { handler, capability } = setup();
    const request = new Request("http://evil.example.com/api/usage/dashboard", {
      method: "POST",
      headers: { "content-type": "application/json", "x-octant-window-capability": capability },
      body: "{}",
    });
    expect((await handler(request))?.status).toBe(400);
  });

  it("rejects a renderer origin outside the allowlist", async () => {
    const { handler, capability } = setup();
    const response = await handler(
      makeRequest({ body: {}, capability, origin: "https://evil.example.com" }),
    );
    expect(response?.status).toBe(400);
  });

  it("rejects a request without window authority", async () => {
    const { handler } = setup();
    expect((await handler(makeRequest({ body: {}, capability: "bad" })))?.status).toBe(401);
  });

  it("answers OPTIONS preflight without reading the projection", async () => {
    const { handler, capability } = setup();
    const response = await handler(makeRequest({ method: "OPTIONS", capability }));
    expect(response?.status).toBe(204);
    expect(response?.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("rejects a method other than POST", async () => {
    const { handler, capability } = setup();
    expect((await handler(makeRequest({ method: "GET", capability })))?.status).toBe(405);
  });

  it("rejects a body larger than the bound", async () => {
    const { connection, capability, windowAuthorityStore } = setup();
    const handlerWithSmallBound = createUsageDashboardRouteHandler({
      connection,
      windowAuthorityStore,
      readWindowProjectScope: () => ({ kind: "unfiled" }),
      now: () => nowMs,
      clock: () => now,
      maxJsonBodySize: 4,
    });
    expect(
      (await handlerWithSmallBound(makeRequest({ body: { detailLimit: 10 }, capability })))?.status,
    ).toBe(413);
  });

  it("rejects a malformed request body", async () => {
    const { handler, capability } = setup();
    const response = await handler(makeRequest({ body: { detailLimit: 5_000 }, capability }));
    expect(response?.status).toBe(400);
  });
});

describe("usage dashboard route projection", () => {
  it("returns a calm empty dashboard when nothing was recorded", async () => {
    const { handler, capability } = setup();
    const response = await handler(makeRequest({ body: {}, capability }));
    expect(response?.status).toBe(200);
    const body = decodeUsageDashboardResponse(await response!.json());
    expect(body.summary.totals.totalRequests).toBe(0);
    expect(body.activity).toEqual([]);
    expect(body.breakdown).toEqual([]);
    expect(body.hosts).toEqual([]);
    expect(body.dimensionSources.length).toBeGreaterThan(0);
  });

  it("attributes a reconciled request across every recorded dimension", async () => {
    const { handler, capability, journal } = setup();
    seedUsageData(journal);

    const response = await handler(makeRequest({ body: {}, capability }));
    expect(response?.status).toBe(200);
    const body: UsageDashboardResponse = decodeUsageDashboardResponse(await response!.json());

    expect(body.summary.totals.totalInputTokens).toBe(50);
    expect(body.summary.totals.totalOutputTokens).toBe(25);
    expect(body.summary.totals.totalReasoningTokens).toBe(11);
    expect(body.summary.peakModel?.modelId).toBe("gpt-4o");
    expect(body.summary.excludedRecordCount).toBe(0);

    const dimensionOf = (dimension: string) =>
      body.breakdown.find((group) => group.dimension === dimension);
    expect(dimensionOf("provider")?.rows[0]?.key).toBe(ids.provider);
    expect(dimensionOf("model")?.rows[0]?.key).toBe("gpt-4o");
    expect(dimensionOf("host")?.rows[0]?.key).toBe("local");
    expect(dimensionOf("mode")?.rows[0]?.key).toBe("chat");
    expect(dimensionOf("thread")?.rows[0]?.key).toBe(`chat-thread/${ids.aggregate}`);
    expect(dimensionOf("context-category")?.rows[0]?.plannedTokens).toBe(50);

    expect(body.detail).toHaveLength(1);
    expect(body.detail[0]?.mode).toBe("chat");
    expect(body.detail[0]?.hostId).toBe("local");
    expect(body.hosts[0]?.status).toBe("contributing");
  });

  it("reports Project as unavailable when no thread projection places the subject", async () => {
    const { handler, capability, journal } = setup();
    seedUsageData(journal);

    const response = await handler(makeRequest({ body: {}, capability }));
    const body = decodeUsageDashboardResponse(await response!.json());
    const project = body.breakdown.find((group) => group.dimension === "project");
    expect(project?.rows[0]?.availability).toBe("unavailable");
    expect(body.detail[0]?.projectId).toBeUndefined();
  });

  it("applies the recorded filters", async () => {
    const { handler, capability, journal } = setup();
    seedUsageData(journal);

    const matching = await handler(makeRequest({ body: { filter: { mode: "chat" } }, capability }));
    expect(decodeUsageDashboardResponse(await matching!.json()).summary.totals.totalRequests).toBe(
      1,
    );

    const other = await handler(makeRequest({ body: { filter: { mode: "code" } }, capability }));
    expect(decodeUsageDashboardResponse(await other!.json()).summary.totals.totalRequests).toBe(0);

    const thread = await handler(
      makeRequest({
        body: {
          filter: { subjectAggregateType: "chat-thread", subjectAggregateId: ids.aggregate },
        },
        capability,
      }),
    );
    expect(decodeUsageDashboardResponse(await thread!.json()).summary.totals.totalRequests).toBe(1);
  });

  it("buckets activity in the requested time zone", async () => {
    const { handler, capability, journal } = setup();
    seedUsageData(journal);
    const response = await handler(
      makeRequest({ body: { timeZone: "Pacific/Auckland" }, capability }),
    );
    const body = decodeUsageDashboardResponse(await response!.json());
    expect(body.timeZone).toBe("Pacific/Auckland");
    expect(body.activity[0]?.date).toBe("2026-07-25");
  });

  it("never exposes prompt text, sources, credentials, or account identifiers", async () => {
    const { handler, capability, journal } = setup();
    seedUsageData(journal);
    const response = await handler(makeRequest({ body: {}, capability }));
    const text = await response!.text();
    expect(text).not.toContain("msg-1");
    expect(text).not.toContain("History");
    expect(text).not.toContain("credential");
    expect(text).not.toContain("accountId");
    expect(text).not.toContain("providerHeaders");
  });
});

describe("usage dashboard route Project scope", () => {
  it("scopes an empty request to the Projects the window is bound to", async () => {
    const { handler, capability, connection } = setup({
      kind: "projects",
      projectIds: [ids.projectA],
    });
    seedProjectScopedUsage(connection);

    const response = await handler(makeRequest({ body: {}, capability }));
    expect(response?.status).toBe(200);
    const text = await response!.clone().text();
    const body = decodeUsageDashboardResponse(await response!.json());

    // An empty request is scoped to the window's own Project, never widened to
    // the host ledger.
    expect(body.summary.totals.totalRequests).toBe(1);
    expect(body.detail).toHaveLength(1);
    expect(body.detail[0]?.projectId).toBe(ids.projectA);
    // No other Project's thread, model, or totals leak, and an unfiled thread
    // is not this Project's row either.
    expect(text).not.toContain(ids.projectB);
    expect(text).not.toContain(ids.threadB);
    expect(text).not.toContain(ids.unfiledThread);
    expect(text).not.toContain("model-1");
  });

  it("refuses an explicit request for a Project outside the window's scope", async () => {
    const { handler, capability, connection } = setup({
      kind: "projects",
      projectIds: [ids.projectA],
    });
    seedProjectScopedUsage(connection);

    const refused = await handler(
      makeRequest({ body: { filter: { projectId: ids.projectB } }, capability }),
    );
    expect(refused?.status).toBe(403);
    expect(await refused!.text()).not.toContain(ids.threadB);

    // The window's own Project stays answerable through the same filter.
    const allowed = await handler(
      makeRequest({ body: { filter: { projectId: ids.projectA } }, capability }),
    );
    expect(allowed?.status).toBe(200);
    expect(decodeUsageDashboardResponse(await allowed!.json()).summary.totals.totalRequests).toBe(
      1,
    );
  });

  // A window bound to nothing is in no Project. It must not read every
  // Project's rows, and refusing it outright would break the default
  // workspace, so it reads exactly the usage the host cannot place in any
  // Project — including its own.
  for (const [label, workspace] of [
    ["no persisted workspace", undefined],
    [
      "every mode context unbound",
      {
        contextByMode: {
          chat: { projectId: null },
          work: { projectId: null },
          code: { projectId: null },
        },
      } as unknown as WindowWorkspace,
    ],
  ] as const) {
    it(`gives a window with ${label} only unfiled usage`, async () => {
      const { handler, capability, connection } = setup(resolveWindowProjectScope(workspace));
      seedProjectScopedUsage(connection);

      const response = await handler(makeRequest({ body: {}, capability }));
      expect(response?.status).toBe(200);
      const text = await response!.clone().text();
      const body = decodeUsageDashboardResponse(await response!.json());

      expect(body.summary.totals.totalRequests).toBe(1);
      expect(body.detail[0]?.projectId).toBeUndefined();
      expect(text).toContain(ids.unfiledThread);
      expect(text).not.toContain(ids.projectA);
      expect(text).not.toContain(ids.projectB);
      expect(text).not.toContain(ids.threadA);
      expect(text).not.toContain(ids.threadB);
    });

    it(`refuses an explicit Project request from a window with ${label}`, async () => {
      const { handler, capability, connection } = setup(resolveWindowProjectScope(workspace));
      seedProjectScopedUsage(connection);

      const refused = await handler(
        makeRequest({ body: { filter: { projectId: ids.projectA } }, capability }),
      );
      expect(refused?.status).toBe(403);
      expect(await refused!.text()).not.toContain(ids.threadA);
    });
  }
});
