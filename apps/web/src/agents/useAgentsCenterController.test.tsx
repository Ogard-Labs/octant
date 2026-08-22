import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAgentsCenterController } from "./useAgentsCenterController";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";

describe("useAgentsCenterController", () => {
  it("loads authorized center rows from the server", async () => {
    const center = vi.fn(async () => ({
      items: [
        {
          runId: "11111111-1111-4111-8111-111111111111",
          requestId: "22222222-2222-4222-8222-222222222222",
          parentThreadId: "33333333-3333-4333-8333-333333333333",
          parentThreadTitle: "Design chat",
          mode: "chat",
          role: "research",
          task: "Summarize",
          lifecycleStatus: "running",
          executionKind: "octant-managed",
          authority: {
            filesystem: false,
            shell: false,
            git: false,
            network: true,
            tools: true,
            subagents: false,
            executionPolicy: "plan",
            permissionPersistence: "current-session",
          },
          workspaceKind: "chat-virtual",
          usageQuality: "provider-reported",
          route: {
            requestedProviderInstanceId: "44444444-4444-4444-8444-444444444444",
            requestedModelId: "gpt-4o",
            executionProviderInstanceId: "44444444-4444-4444-8444-444444444444",
            executionModelId: "gpt-4o",
            poolDerived: false,
          },
          resultAcknowledgement: { required: false, acknowledged: false },
          version: 2,
          createdAt: "2026-08-01T10:00:00.000Z",
          updatedAt: "2026-08-01T10:01:00.000Z",
        },
      ],
    }));
    const client = { center } as unknown as AgentRunClient;
    const { result } = renderHook(() => useAgentsCenterController({ client }));
    await waitFor(() => expect(result.current.list.status).toBe("ready"));
    expect(result.current.visibleItems).toHaveLength(1);
    expect(center).toHaveBeenCalledWith(
      expect.objectContaining({ status: "all", mode: "all", limit: 100 }),
    );
  });
});
