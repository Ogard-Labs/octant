import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUsageRouteHandler } from "./usageRoutes";
import { resolveWindowProjectScope, type UsageProjectScope } from "./usageProjectScope";
import { Journal } from "./persistence/journal";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { createPhase1RuntimeRegistries } from "./persistence/runtimeRegistry";
import { openSqlite } from "./persistence/sqlitePort";
import { USAGE_PROJECTION_SCHEMA_VERSION } from "./persistence/usagePersistenceSchema";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import type { UsageQueryResponse } from "@octant/contracts/usage-rpc";
import type { WindowWorkspace } from "@octant/contracts";

const directories: Array<string> = [];
const now = "2026-07-24T12:00:00.000Z";
const nowMs = new Date(now).getTime();
const ids = {
  actor: "65000000-0000-4000-8000-000000000001",
  correlation: "65000000-0000-4000-8000-000000000002",
  aggregate: "65000000-0000-4000-8000-000000000003",
  provider: "65000000-0000-4000-8000-000000000004",
  entry: "65000000-0000-4000-8000-000000000005",
  manifest: "65000000-0000-4000-8000-000000000006",
  plan: "65000000-0000-4000-8000-000000000007",
  usage: "65000000-0000-4000-8000-000000000008",
  window: "65000000-0000-4000-8000-000000000009",
  projectA: "65000000-0000-4000-8000-00000000000a",
  projectB: "65000000-0000-4000-8000-00000000000b",
  threadA: "65000000-0000-4000-8000-00000000000c",
  threadB: "65000000-0000-4000-8000-00000000000d",
  unfiledThread: "65000000-0000-4000-8000-00000000000e",
} as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(projectScope: UsageProjectScope = { kind: "unfiled" }) {
  const directory = mkdtempSync(join(tmpdir(), "octant-usage-routes-"));
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
  windowAuthorityStore.register({
    windowId: ids.window as never,
    capability,
    now: nowMs,
  });

  const handler = createUsageRouteHandler({
    connection,
    windowAuthorityStore,
    readWindowProjectScope: () => projectScope,
    now: () => nowMs,
    clock: () => now,
  });

  return { connection, journal, handler, capability };
}

function seedUsageData(journal: Journal) {
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
 * Written straight to the projections the query and export read, so the fixture
 * states exactly which rows a Project-scoped window may and may not receive.
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
        `65000000-0000-4000-8000-0000000001${index}0`,
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
  path: string,
  options: { method?: string; body?: unknown; capability?: string } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.capability !== undefined) {
    headers["x-octant-window-capability"] = options.capability;
  }
  return new Request(`http://127.0.0.1:3100${path}`, {
    method: options.method ?? "POST",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

describe("usage routes", () => {
  it("returns undefined for non-usage paths", async () => {
    const { handler } = setup();
    const response = await handler(makeRequest("/api/other"));
    expect(response).toBeUndefined();
  });

  it("rejects non-loopback requests", async () => {
    const { handler, capability } = setup();
    const request = new Request("http://evil.example.com/api/usage/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-window-capability": capability,
      },
      body: JSON.stringify({}),
    });
    const response = await handler(request);
    expect(response).toBeDefined();
    expect(response!.status).toBe(400);
  });

  it("rejects unauthorized requests", async () => {
    const { handler } = setup();
    const response = await handler(
      makeRequest("/api/usage/query", { body: {}, capability: "bad-token" }),
    );
    expect(response).toBeDefined();
    expect(response!.status).toBe(401);
  });

  it("handles OPTIONS preflight", async () => {
    const { handler, capability } = setup();
    const response = await handler(
      makeRequest("/api/usage/query", { method: "OPTIONS", capability }),
    );
    expect(response).toBeDefined();
    expect(response!.status).toBe(204);
  });

  it("rejects non-POST methods", async () => {
    const { handler, capability } = setup();
    const response = await handler(makeRequest("/api/usage/query", { method: "GET", capability }));
    expect(response).toBeDefined();
    expect(response!.status).toBe(405);
  });

  it("returns empty results when no usage data exists", async () => {
    const { handler, capability } = setup();
    const response = await handler(makeRequest("/api/usage/query", { body: {}, capability }));
    expect(response).toBeDefined();
    expect(response!.status).toBe(200);
    const body = await response!.json();
    expect(body.records).toEqual([]);
    expect(body.totals.totalRequests).toBe(0);
    expect(body.hasMore).toBe(false);
  });

  it("returns usage records with totals and aggregations", async () => {
    const { handler, capability, journal } = setup();
    seedUsageData(journal);

    const response = await handler(makeRequest("/api/usage/query", { body: {}, capability }));
    expect(response).toBeDefined();
    expect(response!.status).toBe(200);
    const body = await response!.json();

    expect(body.records).toHaveLength(1);
    expect(body.records[0].reconciliationId).toBe(ids.usage);
    expect(body.records[0].quality).toBe("exact");
    expect(body.records[0].inputTokens).toBe(50);
    expect(body.records[0].outputTokens).toBe(25);

    expect(body.totals.totalInputTokens).toBe(50);
    expect(body.totals.totalOutputTokens).toBe(25);
    expect(body.totals.totalRequests).toBe(1);
    expect(body.totals.totalReasoningTokens).toBe(11);
    expect(body.totals.totalCacheReadInputTokens).toBe(7);
    expect(body.totals.totalCacheWriteInputTokens).toBe(2);
    expect(body.totals.totalProviderExecutionDurationMs).toBe(840);
    expect(body.totals.exactCount).toBe(1);

    expect(body.byProvider).toHaveLength(1);
    expect(body.byProvider[0].providerInstanceId).toBe(ids.provider);
    expect(body.byProvider[0].modelId).toBe("gpt-4o");

    expect(body.byCategory).toHaveLength(1);
    expect(body.byCategory[0].category).toBe("conversation");
    expect(body.byCategory[0].plannedTokens).toBe(50);

    expect(body.hasMore).toBe(false);
    expect(body.queryAt).toBe(now);
  });

  it("returns measured advanced dimensions and honors a validated timezone-aware range", async () => {
    const { handler, capability, journal } = setup();
    seedUsageData(journal);
    const response = await handler(
      makeRequest("/api/usage/query", {
        body: {
          filter: {
            from: "2026-07-24T00:00:00.000Z",
            to: "2026-07-24T23:59:59.999Z",
          },
          timeZone: "Europe/Oslo",
        },
        capability,
      }),
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as UsageQueryResponse;
    expect(body.totals.totalRequests).toBe(1);
    expect(body.byDay[0]?.bucketStart).toBe("2026-07-24T00:00:00.000Z");
  });

  it("rejects an inverted custom usage range", async () => {
    const { handler, capability } = setup();
    const response = await handler(
      makeRequest("/api/usage/query", {
        body: {
          filter: {
            from: "2026-07-25T00:00:00.000Z",
            to: "2026-07-24T23:59:59.999Z",
          },
        },
        capability,
      }),
    );
    expect(response?.status).toBe(400);
  });

  it("filters by provider instance id", async () => {
    const { handler, capability, journal } = setup();
    seedUsageData(journal);

    const response = await handler(
      makeRequest("/api/usage/query", {
        body: { filter: { providerInstanceId: ids.provider } },
        capability,
      }),
    );
    const body = await response!.json();
    expect(body.records).toHaveLength(1);

    const noMatch = await handler(
      makeRequest("/api/usage/query", {
        body: { filter: { providerInstanceId: "00000000-0000-4000-8000-000000000099" } },
        capability,
      }),
    );
    const noMatchBody = await noMatch!.json();
    expect(noMatchBody.records).toHaveLength(0);
  });

  it("rejects invalid request bodies", async () => {
    const { handler, capability } = setup();
    const response = await handler(
      makeRequest("/api/usage/query", {
        body: { filter: { quality: "bogus" } },
        capability,
      }),
    );
    expect(response).toBeDefined();
    expect(response!.status).toBe(400);
  });

  it("does not expose prompt bodies, file contents, or credentials", async () => {
    const { handler, capability, journal } = setup();
    seedUsageData(journal);

    const response = await handler(makeRequest("/api/usage/query", { body: {}, capability }));
    const text = await response!.text();
    expect(text).not.toContain("promptBody");
    expect(text).not.toContain("fileContents");
    expect(text).not.toContain("credentials");
    expect(text).not.toContain("providerHeaders");
    expect(text).not.toContain("accountId");
    expect(text).not.toContain("msg-1");
  });

  it("returns time buckets, cumulative, and top consumers in the query response", async () => {
    const { handler, capability, journal } = setup();
    seedUsageData(journal);

    const response = await handler(makeRequest("/api/usage/query", { body: {}, capability }));
    const body = await response!.json();
    expect(body.byDay).toHaveLength(1);
    expect(body.byDay[0].inputTokens).toBe(50);
    expect(body.byWeek).toHaveLength(1);
    expect(body.cumulative).toHaveLength(1);
    expect(body.cumulative[0].cumulativeInputTokens).toBe(50);
    expect(body.topConsumers).toHaveLength(1);
    expect(body.topConsumers[0].subjectType).toBe("chat-thread");
  });

  it("filters by mode derived from subject type", async () => {
    const { handler, capability, journal } = setup();
    seedUsageData(journal);

    const response = await handler(
      makeRequest("/api/usage/query", { body: { filter: { mode: "chat" } }, capability }),
    );
    const body = await response!.json();
    expect(body.records).toHaveLength(1);

    const codeResponse = await handler(
      makeRequest("/api/usage/query", { body: { filter: { mode: "code" } }, capability }),
    );
    const codeBody = await codeResponse!.json();
    expect(codeBody.records).toHaveLength(0);
  });

  it("filters by host id and returns empty for a non-local host", async () => {
    const { handler, capability, journal } = setup();
    seedUsageData(journal);

    const local = await handler(
      makeRequest("/api/usage/query", { body: { filter: { hostId: "local" } }, capability }),
    );
    const localBody = await local!.json();
    expect(localBody.records).toHaveLength(1);

    const remote = await handler(
      makeRequest("/api/usage/query", {
        body: { filter: { hostId: "remote-host" } },
        capability,
      }),
    );
    const remoteBody = await remote!.json();
    expect(remoteBody.records).toHaveLength(0);
  });

  it("filters by request shape", async () => {
    const { handler, capability, journal } = setup();
    seedUsageData(journal);

    const response = await handler(
      makeRequest("/api/usage/query", {
        body: { filter: { requestShape: "chat-turn" } },
        capability,
      }),
    );
    const body = await response!.json();
    expect(body.records).toHaveLength(1);
  });
});

describe("usage export routes", () => {
  it("exports CSV with confirmation and no sensitive content", async () => {
    const { handler, capability, journal } = setup();
    seedUsageData(journal);

    const response = await handler(
      makeRequest("/api/usage/export", {
        body: { format: "csv", confirm: true },
        capability,
      }),
    );
    expect(response).toBeDefined();
    expect(response!.status).toBe(200);
    expect(response!.headers.get("content-type")).toBe("text/csv");
    const text = await response!.text();
    expect(text).toContain("reconciliationId");
    expect(text).toContain(ids.usage);
    expect(text).not.toContain("promptBody");
    expect(text).not.toContain("fileContents");
    expect(text).not.toContain("credentials");
    expect(text).not.toContain("providerHeaders");
    expect(text).not.toContain("accountId");
    expect(text).not.toContain("msg-1");
  });

  it("exports JSON with confirmation and no sensitive content", async () => {
    const { handler, capability, journal } = setup();
    seedUsageData(journal);

    const response = await handler(
      makeRequest("/api/usage/export", {
        body: { format: "json", confirm: true },
        capability,
      }),
    );
    expect(response!.status).toBe(200);
    const text = await response!.text();
    const parsed = JSON.parse(text) as ReadonlyArray<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    const keys = Object.keys(parsed[0]!);
    expect(keys).not.toContain("promptBody");
    expect(keys).not.toContain("fileContents");
    expect(keys).not.toContain("credentials");
    expect(keys).not.toContain("providerHeaders");
    expect(keys).not.toContain("accountId");
  });

  it("rejects export without confirmation", async () => {
    const { handler, capability } = setup();
    const response = await handler(
      makeRequest("/api/usage/export", {
        body: { format: "csv", confirm: false },
        capability,
      }),
    );
    expect(response!.status).toBe(400);
  });

  it("rejects export without authentication", async () => {
    const { handler } = setup();
    const response = await handler(
      makeRequest("/api/usage/export", { body: { format: "csv", confirm: true } }),
    );
    expect(response!.status).toBe(401);
  });
});

describe("usage route Project scope", () => {
  it("scopes an empty query to the Projects the window is bound to", async () => {
    const { handler, capability, connection } = setup({
      kind: "projects",
      projectIds: [ids.projectA],
    });
    seedProjectScopedUsage(connection);

    const response = await handler(makeRequest("/api/usage/query", { body: {}, capability }));
    expect(response?.status).toBe(200);
    const text = await response!.clone().text();
    const body = (await response!.json()) as UsageQueryResponse;

    // An empty request reads the window's own Project, never the host ledger.
    expect(body.records).toHaveLength(1);
    expect(body.records[0]?.subject.aggregateId).toBe(ids.threadA);
    expect(body.totals.totalRequests).toBe(1);
    // Neither the other Project's thread nor an unfiled thread is this
    // Project's row, in the records or in any aggregate.
    expect(text).not.toContain(ids.projectB);
    expect(text).not.toContain(ids.threadB);
    expect(text).not.toContain(ids.unfiledThread);
    expect(text).not.toContain("model-1");
    expect(text).not.toContain("model-2");
  });

  it("refuses an explicit query for a Project outside the window's scope", async () => {
    const { handler, capability, connection } = setup({
      kind: "projects",
      projectIds: [ids.projectA],
    });
    seedProjectScopedUsage(connection);

    const refused = await handler(
      makeRequest("/api/usage/query", {
        body: { filter: { projectId: ids.projectB } },
        capability,
      }),
    );
    expect(refused?.status).toBe(403);
    expect(await refused!.text()).not.toContain(ids.threadB);

    const allowed = await handler(
      makeRequest("/api/usage/query", {
        body: { filter: { projectId: ids.projectA } },
        capability,
      }),
    );
    expect(allowed?.status).toBe(200);
    expect(((await allowed!.json()) as UsageQueryResponse).records).toHaveLength(1);
  });

  it("scopes an empty export to the Projects the window is bound to", async () => {
    const { handler, capability, connection } = setup({
      kind: "projects",
      projectIds: [ids.projectA],
    });
    seedProjectScopedUsage(connection);

    for (const format of ["csv", "json"] as const) {
      const response = await handler(
        makeRequest("/api/usage/export", { body: { format, confirm: true }, capability }),
      );
      expect(response?.status).toBe(200);
      const text = await response!.text();
      // Every serialized field is scoped: the export row carries subject id,
      // provider, and model, so a Project B row must be absent entirely.
      expect(text).toContain(ids.threadA);
      expect(text).toContain("model-0");
      expect(text).not.toContain(ids.projectB);
      expect(text).not.toContain(ids.threadB);
      expect(text).not.toContain(ids.unfiledThread);
      expect(text).not.toContain("model-1");
      expect(text).not.toContain("model-2");
    }
  });

  it("refuses an explicit export for a Project outside the window's scope", async () => {
    const { handler, capability, connection } = setup({
      kind: "projects",
      projectIds: [ids.projectA],
    });
    seedProjectScopedUsage(connection);

    const refused = await handler(
      makeRequest("/api/usage/export", {
        body: { format: "csv", confirm: true, filter: { projectId: ids.projectB } },
        capability,
      }),
    );
    expect(refused?.status).toBe(403);
    const text = await refused!.text();
    expect(text).not.toContain(ids.threadB);
    expect(text).not.toContain("model-1");

    const allowed = await handler(
      makeRequest("/api/usage/export", {
        body: { format: "csv", confirm: true, filter: { projectId: ids.projectA } },
        capability,
      }),
    );
    expect(allowed?.status).toBe(200);
    expect(await allowed!.text()).toContain(ids.threadA);
  });

  it("reads nothing for a window whose scope resolves to no Project", async () => {
    const { handler, capability, connection } = setup({ kind: "projects", projectIds: [] });
    seedProjectScopedUsage(connection);

    const response = await handler(makeRequest("/api/usage/query", { body: {}, capability }));
    expect(response?.status).toBe(200);
    expect(((await response!.json()) as UsageQueryResponse).records).toHaveLength(0);
  });
});

describe("usage route scope for a window bound to no Project", () => {
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
    it(`gives a window with ${label} only unfiled usage from the query`, async () => {
      const { handler, capability, connection } = setup(resolveWindowProjectScope(workspace));
      seedProjectScopedUsage(connection);

      const response = await handler(makeRequest("/api/usage/query", { body: {}, capability }));
      expect(response?.status).toBe(200);
      const text = await response!.clone().text();
      const body = (await response!.json()) as UsageQueryResponse;

      expect(body.records).toHaveLength(1);
      expect(body.records[0]?.subject.aggregateId).toBe(ids.unfiledThread);
      expect(text).not.toContain(ids.projectA);
      expect(text).not.toContain(ids.projectB);
      expect(text).not.toContain(ids.threadA);
      expect(text).not.toContain(ids.threadB);
      expect(text).not.toContain("model-0");
      expect(text).not.toContain("model-1");
    });

    it(`gives a window with ${label} only unfiled usage from the export`, async () => {
      const { handler, capability, connection } = setup(resolveWindowProjectScope(workspace));
      seedProjectScopedUsage(connection);

      const response = await handler(
        makeRequest("/api/usage/export", { body: { format: "csv", confirm: true }, capability }),
      );
      expect(response?.status).toBe(200);
      const text = await response!.text();
      expect(text).toContain(ids.unfiledThread);
      expect(text).not.toContain(ids.threadA);
      expect(text).not.toContain(ids.threadB);
      expect(text).not.toContain("model-0");
      expect(text).not.toContain("model-1");
    });

    it(`refuses an explicit Project request from a window with ${label}`, async () => {
      const { handler, capability, connection } = setup(resolveWindowProjectScope(workspace));
      seedProjectScopedUsage(connection);

      const query = await handler(
        makeRequest("/api/usage/query", {
          body: { filter: { projectId: ids.projectA } },
          capability,
        }),
      );
      expect(query?.status).toBe(403);

      const exported = await handler(
        makeRequest("/api/usage/export", {
          body: { format: "csv", confirm: true, filter: { projectId: ids.projectA } },
          capability,
        }),
      );
      expect(exported?.status).toBe(403);
      expect(await exported!.text()).not.toContain(ids.threadA);
    });
  }
});

describe("usage reset routes", () => {
  it("resets usage records with confirmation and reports the purged count", async () => {
    const { handler, capability, journal } = setup();
    seedUsageData(journal);

    const response = await handler(
      makeRequest("/api/usage/reset", { body: { confirm: true }, capability }),
    );
    expect(response!.status).toBe(200);
    const body = await response!.json();
    expect(body.purgedCount).toBe(1);

    const queryResponse = await handler(makeRequest("/api/usage/query", { body: {}, capability }));
    const queryBody = await queryResponse!.json();
    expect(queryBody.records).toHaveLength(0);
  });

  it("rejects reset without confirmation", async () => {
    const { handler, capability } = setup();
    const response = await handler(
      makeRequest("/api/usage/reset", { body: { confirm: false }, capability }),
    );
    expect(response!.status).toBe(400);
  });
});

describe("usage retention routes", () => {
  it("purges records older than a threshold with confirmation", async () => {
    const { handler, capability, journal } = setup();
    seedUsageData(journal);

    const response = await handler(
      makeRequest("/api/usage/retain", {
        body: { olderThan: "2026-07-25T00:00:00.000Z", confirm: true },
        capability,
      }),
    );
    expect(response!.status).toBe(200);
    const body = await response!.json();
    expect(body.purgedCount).toBe(1);
  });

  it("rejects retention without confirmation", async () => {
    const { handler, capability } = setup();
    const response = await handler(
      makeRequest("/api/usage/retain", {
        body: { olderThan: "2026-07-25T00:00:00.000Z", confirm: false },
        capability,
      }),
    );
    expect(response!.status).toBe(400);
  });
});
