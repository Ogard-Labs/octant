import { describe, expect, it, vi } from "vitest";
import { decodeCanvasId, decodeProjectId } from "@octant/contracts";
import { createCanvasClient } from "./canvasClient";

const projectId = decodeProjectId("77777777-7777-4777-8777-777777777777");
const canvasId = decodeCanvasId("11111111-1111-4111-8111-111111111111");

describe("createCanvasClient", () => {
  it("requests inventory and get-by-id routes", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/history")) {
        return new Response(
          JSON.stringify({
            kind: "ready",
            history: {
              canvasId: String(canvasId),
              currentVersionId: "22222222-2222-4222-8222-222222222222",
              entries: [
                {
                  versionId: "22222222-2222-4222-8222-222222222222",
                  sequence: 1,
                  schemaVersion: 1,
                  title: "Quarterly summary",
                  createdAt: "2026-08-01T21:00:00.000Z",
                  createdBy: {
                    kind: "local-user",
                    actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                  },
                  providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                  modelId: "octant-test-model",
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/inventory")) {
        return new Response(
          JSON.stringify({
            projectId: String(projectId),
            entries: [
              {
                canvasId: String(canvasId),
                projectId: String(projectId),
                mode: "chat",
                title: "Quarterly summary",
                versionCount: 1,
                currentVersionId: "22222222-2222-4222-8222-222222222222",
                currentSequence: 1,
                updatedAt: "2026-08-01T21:00:00.000Z",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          kind: "ready",
          version: {
            schemaVersion: 1,
            canvasId: String(canvasId),
            versionId: "22222222-2222-4222-8222-222222222222",
            sequence: 1,
            definition: {
              schemaVersion: 1,
              title: "Quarterly summary",
              provenance: {
                mode: "chat",
                hostId: "local",
                projectId: String(projectId),
                threadId: "99999999-9999-4999-8999-999999999999",
                actor: { kind: "local-user", actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
                providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                modelId: "octant-test-model",
                createdAt: "2026-08-01T21:00:00.000Z",
              },
              sourceManifest: [],
              blocks: [
                {
                  blockId: "block-1",
                  schemaVersion: 1,
                  kind: "heading",
                  level: 1,
                  text: "A bounded Canvas",
                },
              ],
            },
            createdBy: { kind: "local-user", actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
            createdAt: "2026-08-01T21:00:00.000Z",
          },
        }),
        { status: 200 },
      );
    });
    const client = createCanvasClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: fetchImpl as unknown as typeof fetch,
      windowCapability: "capability",
    });
    const inventory = await client.inventory(projectId, "quarter");
    expect(inventory.entries[0]?.title).toBe("Quarterly summary");
    const outcome = await client.get(canvasId);
    expect(outcome.kind).toBe("ready");
    const history = await client.history(canvasId);
    expect(history.kind).toBe("ready");
    if (history.kind === "ready") expect(history.history.entries.length).toBeGreaterThan(0);
  });

  it("posts revise requests to the canvas revise route", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/revise")) {
        return new Response(
          JSON.stringify({
            kind: "accepted",
            receipt: {
              schemaVersion: 1,
              kind: "canvas-revise-receipt",
              receiptId: "55555555-5555-4555-8555-555555555555",
              requestId: "44444444-4444-4444-8444-444444444444",
              canvasId: String(canvasId),
              versionId: "33333333-3333-4333-8333-333333333333",
              sequence: 2,
              outcome: "ready",
              createdAt: "2026-08-01T21:01:00.000Z",
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ kind: "unauthorized", canvasId: String(canvasId) }), {
        status: 200,
      });
    });
    const client = createCanvasClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: fetchImpl as unknown as typeof fetch,
      windowCapability: "capability",
    });
    const result = await client.revise({
      schemaVersion: 1,
      kind: "canvas-revise",
      requestId: "44444444-4444-4444-8444-444444444444" as never,
      canvasId,
      expectedSequence: 1,
      prompt: "Add a summary section",
      hostId: "local" as never,
      mode: "chat",
      workspace: { kind: "chat-virtual", projectId: null },
      originThreadId: "99999999-9999-4999-8999-999999999999" as never,
      actor: { kind: "local-user", actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as never },
      providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
      modelId: "octant-test-model" as never,
      requestedAuthority: {
        filesystem: false,
        shell: false,
        git: false,
        network: false,
        tools: true,
        subagents: false,
        executionPolicy: "plan",
        permissionPersistence: "current-session",
      },
    });
    expect(result.kind).toBe("accepted");
  });

  it("posts refresh and cancellation commands with typed replay outcomes", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return new Response(
        JSON.stringify({
          kind: "accepted",
          receipt: {
            schemaVersion: 1,
            kind: "canvas-refresh-receipt",
            requestId: "44444444-4444-4444-8444-444444444444",
            recipeId: "55555555-5555-4555-8555-555555555555",
            canvasId: String(canvasId),
            outcome: url.includes("cancel") ? "cancelled" : "ready",
            sources: [],
            completedAt: "2026-08-03T10:01:00.000Z",
          },
        }),
        { status: 200 },
      );
    });
    const client = createCanvasClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: fetchImpl as unknown as typeof fetch,
      windowCapability: "capability",
    });
    if (client.refresh === undefined || client.cancelRefresh === undefined) return;
    const refresh = await client.refresh({
      schemaVersion: 1,
      kind: "canvas-refresh",
      requestId: "44444444-4444-4444-8444-444444444444" as never,
      canvasId,
      recipe: {
        schemaVersion: 1,
        kind: "canvas-refresh-recipe",
        recipeId: "55555555-5555-4555-8555-555555555555" as never,
        canvasId,
        hostId: "local" as never,
        mode: "chat",
        workspace: { kind: "chat-virtual", projectId: null },
        originThreadId: "99999999-9999-4999-8999-999999999999" as never,
        providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
        modelId: "octant-test-model" as never,
        parameters: [{ key: "range", value: "opaque:current" }] as never,
        sourceManifest: [],
      },
      expectedSequence: 1,
      hostId: "local" as never,
      mode: "chat",
      workspace: { kind: "chat-virtual", projectId: null },
      originThreadId: "99999999-9999-4999-8999-999999999999" as never,
      actor: { kind: "local-user", actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as never },
      providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
      modelId: "octant-test-model" as never,
      requestedAuthority: {
        filesystem: false,
        shell: false,
        git: false,
        network: false,
        tools: true,
        subagents: false,
        executionPolicy: "plan",
        permissionPersistence: "current-session",
      },
    });
    const cancelled = await client.cancelRefresh({
      schemaVersion: 1,
      kind: "canvas-refresh-cancel",
      requestId: "44444444-4444-4444-8444-444444444444" as never,
      recipeId: "55555555-5555-4555-8555-555555555555" as never,
      canvasId,
    });
    expect(refresh).toMatchObject({ kind: "accepted", receipt: { outcome: "ready" } });
    expect(cancelled).toMatchObject({ kind: "accepted", receipt: { outcome: "cancelled" } });
    expect(calls).toEqual([
      "http://127.0.0.1:13773/api/canvas/refresh",
      "http://127.0.0.1:13773/api/canvas/refresh-cancel",
    ]);
  });

  it("posts action execution and cancellation with typed outcomes", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return new Response(
        JSON.stringify({
          kind: "accepted",
          receipt: {
            schemaVersion: 1,
            kind: "canvas-action-receipt",
            requestId: "44444444-4444-4444-8444-444444444444",
            canvasId: String(canvasId),
            blockId: "action-1",
            capability: { command: "canvas.open-thread", effect: "read", requiresApproval: false },
            outcome: url.includes("cancel") ? "cancelled" : "completed",
            ...(url.includes("cancel")
              ? { recoveryReason: "Canvas action cancelled before it completed." }
              : { report: { kind: "opened", reference: "opaque:thread-1" } }),
            completedAt: "2026-08-03T10:01:00.000Z",
          },
        }),
        { status: 200 },
      );
    });
    const client = createCanvasClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: fetchImpl as unknown as typeof fetch,
      windowCapability: "capability",
    });
    if (client.executeAction === undefined || client.cancelAction === undefined) return;
    const executed = await client.executeAction({
      schemaVersion: 1,
      kind: "canvas-action",
      requestId: "44444444-4444-4444-8444-444444444444" as never,
      canvasId,
      block: {
        blockId: "action-1" as never,
        schemaVersion: 1,
        kind: "action",
        label: "Open thread",
        command: { command: "canvas.open-thread", threadRef: "opaque:thread-1" as never },
      },
      expectedSequence: 1,
      hostId: "local" as never,
      mode: "chat",
      workspace: { kind: "chat-virtual", projectId: null },
      originThreadId: "99999999-9999-4999-8999-999999999999" as never,
      actor: { kind: "local-user", actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as never },
      providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
      modelId: "octant-test-model" as never,
      requestedAuthority: {
        filesystem: false,
        shell: false,
        git: false,
        network: false,
        tools: true,
        subagents: false,
        executionPolicy: "plan",
        permissionPersistence: "current-session",
      },
      approval: { kind: "not-required" },
    });
    const cancelled = await client.cancelAction({
      schemaVersion: 1,
      kind: "canvas-action-cancel",
      requestId: "44444444-4444-4444-8444-444444444444" as never,
      canvasId,
      blockId: "action-1" as never,
    });
    expect(executed).toMatchObject({ kind: "accepted", receipt: { outcome: "completed" } });
    expect(cancelled).toMatchObject({ kind: "accepted", receipt: { outcome: "cancelled" } });
    expect(calls).toEqual([
      "http://127.0.0.1:13773/api/canvas/action",
      "http://127.0.0.1:13773/api/canvas/action-cancel",
    ]);
  });

  it("creates a Canvas and lists thread reference cards", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/create")) {
        return new Response(
          JSON.stringify({
            kind: "accepted",
            receipt: {
              schemaVersion: 1,
              kind: "canvas-create-receipt",
              receiptId: "55555555-5555-4555-8555-555555555555",
              requestId: "44444444-4444-4444-8444-444444444444",
              canvasId: String(canvasId),
              versionId: "33333333-3333-4333-8333-333333333333",
              intent: "blank",
              originThreadId: "99999999-9999-4999-8999-999999999999",
              scope: {
                hostId: "local",
                mode: "chat",
                workspace: { kind: "chat-virtual", projectId: String(projectId) },
              },
              title: "Created",
              effectiveAuthority: {
                filesystem: false,
                shell: false,
                git: false,
                network: false,
                tools: true,
                subagents: false,
                executionPolicy: "plan",
                permissionPersistence: "current-session",
              },
              outcome: "ready",
              createdAt: "2026-08-01T21:00:00.000Z",
            },
            card: {
              schemaVersion: 1,
              kind: "canvas-reference-card",
              cardId: "66666666-6666-4666-8666-666666666666",
              canvasId: String(canvasId),
              versionId: "33333333-3333-4333-8333-333333333333",
              title: "Created",
              scope: {
                hostId: "local",
                mode: "chat",
                workspace: { kind: "chat-virtual", projectId: String(projectId) },
              },
              originThreadId: "99999999-9999-4999-8999-999999999999",
              status: "ready",
              authority: {
                filesystem: false,
                shell: false,
                git: false,
                network: false,
                tools: true,
                subagents: false,
                executionPolicy: "plan",
                permissionPersistence: "current-session",
              },
              actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              modelId: "octant-test-model",
              createdAt: "2026-08-01T21:00:00.000Z",
              actionCount: 0,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          mode: "chat",
          threadId: "99999999-9999-4999-8999-999999999999",
          projectId: String(projectId),
          cards: [],
        }),
        { status: 200 },
      );
    });
    const client = createCanvasClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: fetchImpl as unknown as typeof fetch,
      windowCapability: "capability",
    });
    const createResult = await client.create!({
      schemaVersion: 1,
      kind: "canvas-create",
      requestId: "44444444-4444-4444-8444-444444444444" as never,
      intent: "blank",
      hostId: "local" as never,
      mode: "chat",
      workspace: { kind: "chat-virtual", projectId },
      originThreadId: "99999999-9999-4999-8999-999999999999" as never,
      title: "Created",
      sourceManifest: [],
      requestedAuthority: {
        filesystem: false,
        shell: false,
        git: false,
        network: false,
        tools: true,
        subagents: false,
        executionPolicy: "plan",
        permissionPersistence: "current-session",
      },
    });
    const cards = await client.threadReferenceCards!({
      mode: "chat",
      threadId: "99999999-9999-4999-8999-999999999999",
      projectId,
    });
    expect(createResult.kind).toBe("accepted");
    expect(cards.cards).toEqual([]);
    expect(calls.some((url) => url.includes("/api/canvas/create"))).toBe(true);
    expect(calls.some((url) => url.includes("/api/canvas/thread-reference-cards"))).toBe(true);
  });
  it("reads the share overview and posts share, revoke, and access to their routes", async () => {
    const calls: Array<string> = [];
    const snapshotId = "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a";
    const ownerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/api/canvas/share-access")) {
        return new Response(
          JSON.stringify({
            kind: "unavailable",
            denialCode: "revoked",
            message: "This share was withdrawn.",
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/canvas/share-revoke")) {
        return new Response(
          JSON.stringify({
            kind: "denied",
            denialCode: "revoked",
            message: "This share is already revoked.",
          }),
          { status: 200 },
        );
      }
      if ((init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            kind: "canvas-share-overview",
            canvasId: String(canvasId),
            hostId: "local",
            projectId: String(projectId),
            sharingEnabled: true,
            owner: { kind: "local-user", actorId: ownerId },
            snapshots: [],
            accessLog: [],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          kind: "denied",
          denialCode: "consent-required",
          message: "Sharing needs your explicit consent.",
        }),
        { status: 200 },
      );
    });
    const client = createCanvasClient({
      baseUrl: "http://127.0.0.1:8123",
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      windowCapability: "capability",
    });

    const overview = await client.shareOverview!(canvasId);
    expect(overview.owner.actorId).toBe(ownerId);
    expect(overview.sharingEnabled).toBe(true);
    const shared = await client.share!({ canvasId } as never);
    expect(shared).toMatchObject({ kind: "denied", denialCode: "consent-required" });
    const revoked = await client.revokeShare!({ snapshotId } as never);
    expect(revoked).toMatchObject({ kind: "denied", denialCode: "revoked" });
    const accessed = await client.accessShare!({ snapshotId } as never);
    expect(accessed).toMatchObject({ kind: "unavailable", denialCode: "revoked" });
    expect(calls).toEqual([
      `GET http://127.0.0.1:8123/api/canvas/share?canvasId=${String(canvasId)}`,
      "POST http://127.0.0.1:8123/api/canvas/share",
      "POST http://127.0.0.1:8123/api/canvas/share-revoke",
      "POST http://127.0.0.1:8123/api/canvas/share-access",
    ]);
  });
});
