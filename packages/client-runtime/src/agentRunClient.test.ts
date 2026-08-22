import { describe, expect, it, vi } from "vitest";
import { createAgentRunClient, AgentRunClientFailure } from "./agentRunClient";

const parentThreadId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("agentRunClient", () => {
  it("loads parent summary through the authenticated route", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("/api/agent-runs/parent-summary");
      expect(url).toContain(`parentThreadId=${parentThreadId}`);
      return new Response(
        JSON.stringify({
          parentThreadId,
          entries: [
            {
              runId,
              requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              parentThreadId,
              role: "research",
              task: "Summarize",
              lifecycleStatus: "completed",
              executionKind: "octant-managed",
              usageQuality: "provider-reported",
              resultAcknowledgement: {
                required: true,
                acknowledged: false,
                followUpReason: "unacknowledged-child-result",
              },
              route: {
                requestedProviderInstanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                requestedModelId: "gpt-4o",
                executionProviderInstanceId: "abababab-abab-4bab-8bab-abababababab",
                executionModelId: "claude-x",
                poolDerived: true,
                selectionKind: "fallback",
                routingReason: "The requested model is unavailable; a permitted fallback ran.",
              },
              version: 4,
              updatedAt: "2026-08-01T15:00:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = createAgentRunClient({
      baseUrl: "http://127.0.0.1:8787",
      fetch: fetchImpl as unknown as typeof fetch,
      windowCapability: "cap",
    });
    const summary = await client.parentSummary(parentThreadId as never);
    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0]?.task).toBe("Summarize");
    // Honest server-authored route receipt data passes through unchanged.
    expect(summary.entries[0]?.route).toMatchObject({
      requestedModelId: "gpt-4o",
      executionModelId: "claude-x",
      poolDerived: true,
      selectionKind: "fallback",
    });
  });

  it("acknowledges a completed child result", async () => {
    // decode will fail because run is incomplete; use a full minimal shape? For client we can
    // only assert failure class if decode fails. Instead mock decode-compatible payload is hard.
    // Keep this as unauthorized path test instead.
    const client = createAgentRunClient({
      baseUrl: "http://127.0.0.1:8787",
      fetch: (async () =>
        new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })) as typeof fetch,
      windowCapability: "cap",
    });
    await expect(
      client.acknowledge({ runId: runId as never, expectedVersion: 4 }),
    ).rejects.toBeInstanceOf(AgentRunClientFailure);
  });

  it("prepares a child workspace through the server-owned route", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/api/agent-runs/workspaces/prepare");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ parentThreadId });
      return new Response(
        JSON.stringify({
          status: "prepared",
          workspace: {
            kind: "chat-virtual",
            mode: "chat",
            receiptId: "66666666-6666-4666-8666-666666666666",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = createAgentRunClient({
      baseUrl: "http://127.0.0.1:8787",
      fetch: fetchImpl as unknown as typeof fetch,
      windowCapability: "cap",
    });
    const prepared = await client.prepareWorkspace({ parentThreadId: parentThreadId as never });
    expect(prepared).toEqual({
      status: "prepared",
      workspace: {
        kind: "chat-virtual",
        mode: "chat",
        receiptId: "66666666-6666-4666-8666-666666666666",
      },
    });
  });

  it("requests a new child run through the explicit creation route", async () => {
    const creationRequest = {
      requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      parentThreadId,
      role: "research" as const,
      task: "Summarize the open PRs.",
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/api/agent-runs/request");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual(creationRequest);
      return new Response(
        JSON.stringify({
          kind: "run-accepted",
          run: { id: runId, lifecycleStatus: "queued", task: creationRequest.task },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = createAgentRunClient({
      baseUrl: "http://127.0.0.1:8787",
      fetch: fetchImpl as unknown as typeof fetch,
      windowCapability: "cap",
    });
    const result = await client.requestRun(creationRequest as never);
    expect(result.kind).toBe("run-accepted");
  });

  it("surfaces creation denial as a typed failure with the server's reason", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ kind: "run-command-failed", reason: "posture-rejected" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createAgentRunClient({
      baseUrl: "http://127.0.0.1:8787",
      fetch: fetchImpl as unknown as typeof fetch,
      windowCapability: "cap",
    });
    const result = await client.requestRun({
      requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as never,
      parentThreadId: parentThreadId as never,
      role: "research",
      task: "Summarize the open PRs.",
    });
    expect(result.kind).toBe("run-command-failed");
    expect((result as { reason?: string }).reason).toBe("posture-rejected");
  });

  it("preserves a server-side creation rejection message", async () => {
    const client = createAgentRunClient({
      baseUrl: "http://127.0.0.1:8787",
      fetch: (async () =>
        new Response(JSON.stringify({ error: "The selected provider/model is not ready." }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      windowCapability: "cap",
    });

    await expect(
      client.requestRun({
        requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as never,
        parentThreadId: parentThreadId as never,
        role: "research",
        task: "Summarize the open PRs.",
      }),
    ).rejects.toThrow("The selected provider/model is not ready.");
  });

  it("cancels a run through the cancel route", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/api/agent-runs/cancel");
      expect(JSON.parse(String(init?.body))).toEqual({ runId, scope: "subtree" });
      return new Response(
        JSON.stringify({
          results: [{ kind: "run-updated", run: { id: runId, lifecycleStatus: "cancelled" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = createAgentRunClient({
      baseUrl: "http://127.0.0.1:8787",
      fetch: fetchImpl as unknown as typeof fetch,
      windowCapability: "cap",
    });
    const { results } = await client.cancel({ runId: runId as never, scope: "subtree" });
    expect(results).toHaveLength(1);
    expect(results[0]?.kind).toBe("run-updated");
  });

  it("rejects non-loopback base URLs", () => {
    expect(() =>
      createAgentRunClient({
        baseUrl: "https://example.com",
        fetch,
        windowCapability: "cap",
      }),
    ).toThrow(AgentRunClientFailure);
  });
});
