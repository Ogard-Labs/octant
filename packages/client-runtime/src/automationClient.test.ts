import { describe, expect, it, vi } from "vitest";
import { createAutomationClient } from "./automationClient";

const automationId = "aa000000-0000-4000-8000-000000000001";
const projectId = "aa000000-0000-4000-8000-000000000020";
const runNowRequestId = "aa000000-0000-4000-8000-000000000080";

const authority = {
  filesystem: true,
  shell: false,
  git: false,
  network: false,
  tools: true,
  subagents: false,
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
} as const;

const definition = {
  id: automationId,
  displayName: "Weekly summary",
  taskPrompt: "Summarize the Project's open work.",
  hostId: "local",
  mode: "work",
  projectId,
  projectVersion: 1,
  binding: {
    kind: "work",
    hostId: "local",
    projectId,
    projectVersion: 1,
    bindingRevisionId: "aa000000-0000-4000-8000-000000000030",
    bindingReceiptId: `${"A".repeat(42)}A`,
  },
  executionProfile: {
    profileId: "aa000000-0000-4000-8000-000000000040",
    profileVersion: 1,
    hostId: "local",
    mode: "work",
    projectId,
    providerInstanceId: "aa000000-0000-4000-8000-000000000070",
    modelId: "approved-model",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
  },
  authorityProfile: {
    profileId: "aa000000-0000-4000-8000-000000000050",
    profileVersion: 1,
    requested: authority,
    effective: authority,
    effectiveAuthorityDigest: "automation-authority-digest",
  },
  deliveryTarget: {
    revisionId: "aa000000-0000-4000-8000-000000000060",
    revision: 1,
    mode: "work",
    summary: "A confirmed weekly summary document exists in the Project.",
    confirmed: true,
    confirmedBy: "aa000000-0000-4000-8000-0000000000b0",
    confirmedAt: "2026-08-10T12:00:00.000Z",
  },
  trigger: { kind: "once", scheduledAt: "2026-09-01T09:00:00.000Z" },
  missedRunPolicy: "skip",
  targetPolicy: "new-thread",
  lifecycle: "enabled",
  definitionRevision: 1,
  nextDueAt: "2026-09-01T09:00:00.000Z",
  createdBy: { kind: "local-window", windowId: "window-1", capabilityGeneration: 0 },
  updatedBy: { kind: "local-window", windowId: "window-1", capabilityGeneration: 0 },
  version: 1,
  createdAt: "2026-08-10T12:00:00.000Z",
  updatedAt: "2026-08-10T12:00:00.000Z",
};

const summary = {
  id: automationId,
  displayName: "Weekly summary",
  hostId: "local",
  mode: "work",
  projectId,
  lifecycle: "enabled",
  definitionRevision: 1,
  trigger: { kind: "once", scheduledAt: "2026-09-01T09:00:00.000Z" },
  nextDueAt: "2026-09-01T09:00:00.000Z",
  version: 1,
  updatedAt: "2026-08-10T12:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function client(fetchImpl: typeof globalThis.fetch, maxAttempts?: number) {
  return createAutomationClient({
    baseUrl: "http://127.0.0.1:4310",
    fetch: fetchImpl,
    windowCapability: "capability-1",
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  });
}

describe("createAutomationClient", () => {
  it("lists automations with bounded query parameters and strict decoding", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ kind: "automation-list", items: [summary], nextCursor: "cursor-1" }),
    );
    const result = await client(fetchImpl as never).list({
      mode: "work",
      projectId,
      search: "weekly",
      limit: 10,
      cursor: "cursor-0",
    });
    expect(result.kind).toBe("automation-list");
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBe("cursor-1");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/automations/list");
    expect(parsed.searchParams.get("mode")).toBe("work");
    expect(parsed.searchParams.get("projectId")).toBe(projectId);
    expect(parsed.searchParams.get("search")).toBe("weekly");
    expect(parsed.searchParams.get("limit")).toBe("10");
    expect(parsed.searchParams.get("cursor")).toBe("cursor-0");
    expect((init.headers as Record<string, string>)["x-octant-window-capability"]).toBe(
      "capability-1",
    );
  });

  it("fetches detail and paged history with strict decoding", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/automations/get")) {
        return jsonResponse({ kind: "automation-detail", automation: definition, runs: [] });
      }
      return jsonResponse({
        kind: "automation-history",
        automationId,
        runs: [],
        nextCursor: "cursor-2",
      });
    });
    const detail = await client(fetchImpl as never).get(automationId as never);
    expect(detail.kind).toBe("automation-detail");
    expect(String(detail.automation.id)).toBe(automationId);
    const history = await client(fetchImpl as never).history({
      automationId: automationId as never,
      limit: 5,
      cursor: "cursor-1",
    });
    expect(history.kind).toBe("automation-history");
    expect(history.nextCursor).toBe("cursor-2");
  });

  it("sends commands without principal or origin and decodes typed results", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        kind: "automation-run-active-conflict",
        automationId,
        runId: "aa000000-0000-4000-8000-000000000010",
        lifecycle: "running",
      }),
    );
    const result = await client(fetchImpl as never).execute({
      kind: "run-now-automation",
      automationId: automationId as never,
      expectedVersion: 1 as never,
      runNowRequestId: runNowRequestId as never,
    });
    expect(result.kind).toBe("automation-run-active-conflict");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/automations/commands");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // Identity is transport-authenticated; the wire body never carries it.
    expect(body["principal"]).toBeUndefined();
    expect(body["origin"]).toBeUndefined();
    expect(body["runNowRequestId"]).toBe(runNowRequestId);
  });

  it("reconnects and replays the same idempotent command after a network failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network dropped"))
      .mockResolvedValueOnce(
        jsonResponse({
          kind: "automation-command-failed",
          reason: "stale-version",
          message: "The Automation changed while the request was replayed.",
          automationId,
        }),
      );
    const result = await client(fetchImpl as never, 2).execute({
      kind: "run-now-automation",
      automationId: automationId as never,
      expectedVersion: 1 as never,
      runNowRequestId: runNowRequestId as never,
    });
    expect(result.kind).toBe("automation-command-failed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String((fetchImpl.mock.calls[0] as never[])[1]!["body"]));
    const secondBody = JSON.parse(String((fetchImpl.mock.calls[1] as never[])[1]!["body"]));
    // The replay reuses the identical request ID so the server can return the
    // original receipt instead of a second side effect.
    expect(secondBody).toEqual(firstBody);
  });

  it("gives up with a typed network failure once reconnect attempts are exhausted", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("network dropped"));
    await expect(client(fetchImpl as never, 2).list()).rejects.toMatchObject({
      name: "AutomationClientFailure",
      category: "network",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("honors cancellation without replaying the request", async () => {
    const abortError = new DOMException("aborted", "AbortError");
    const fetchImpl = vi.fn().mockRejectedValue(abortError);
    const controller = new AbortController();
    controller.abort();
    await expect(
      client(fetchImpl as never, 3).execute(
        {
          kind: "cancel-current-automation-run",
          automationId: automationId as never,
          expectedVersion: 1 as never,
          runId: "aa000000-0000-4000-8000-000000000010" as never,
          cancelRunRequestId: "aa000000-0000-4000-8000-000000000090" as never,
          expectedRunVersion: 1 as never,
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AutomationClientFailure", category: "aborted" });
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it("rejects unauthorized responses and contract violations with typed failures", async () => {
    const unauthorized = vi.fn(async () =>
      jsonResponse(
        { category: "unauthorized", message: "Automation request is unauthorized." },
        401,
      ),
    );
    await expect(client(unauthorized as never).list()).rejects.toMatchObject({
      name: "AutomationClientFailure",
      category: "http",
      status: 401,
    });

    const hostile = vi.fn(async () =>
      jsonResponse({ kind: "automation-list", items: [{ id: "not-a-summary" }] }),
    );
    await expect(client(hostile as never).list()).rejects.toMatchObject({
      name: "AutomationClientFailure",
      category: "contract",
    });

    const wrongKind = vi.fn(async () =>
      jsonResponse({ kind: "automation-history", automationId, runs: [] }),
    );
    await expect(client(wrongKind as never).list()).rejects.toMatchObject({
      name: "AutomationClientFailure",
      category: "contract",
    });
  });
});
