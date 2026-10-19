import { act, renderHook, waitFor } from "@testing-library/react";
import { createPlanClient } from "@octant/client-runtime/plan-client";
import { usePlanController } from "../plan/usePlanController";
import { describe, expect, it, vi } from "vitest";
import { useDockToolCapabilities } from "./useDockToolCapabilities";

describe("useDockToolCapabilities", () => {
  it("keeps the dock and another plan reader current after this window proposes and withdraws", async () => {
    const threadId = "10000000-0000-4000-8000-000000000001";
    let withdrawn = false;
    const planClient = createPlanClient({
      baseUrl: "http://127.0.0.1:14783",
      windowCapability: "test-capability",
      fetch: vi.fn(async (_input, init) => {
        if (init?.method === "GET") return Response.json({ plan: null, history: [] });
        const plan = {
          id: "20000000-0000-4000-8000-000000000001",
          threadId,
          revisionId: "30000000-0000-4000-8000-000000000001",
          title: "Check the proposal",
          status: withdrawn ? "withdrawn" : "proposed",
          steps: [
            {
              stepId: "40000000-0000-4000-8000-000000000001",
              position: 0,
              title: "Inspect",
              status: "pending",
            },
          ],
          proposedAt: "2026-10-19T20:00:00.000Z",
          updatedAt: "2026-10-19T20:00:00.000Z",
          version: withdrawn ? 2 : 1,
        };
        return Response.json({ plan, history: [] });
      }),
    });
    const { result } = renderHook(() => ({
      author: usePlanController({ client: planClient, enabled: true, threadId }),
      reader: usePlanController({ client: planClient, enabled: true, threadId }),
      dock: useDockToolCapabilities({
        planClient,
        threadId,
        mode: "code",
        addAgentInvoked: false,
        hasAppleSimulator: false,
        hasWrittenDocument: false,
      }),
    }));
    await waitFor(() => expect(result.current.author.status).toBe("ready"));
    expect(result.current.dock.hasPlanArtifact).toBe(false);
    await act(async () => {
      await result.current.author.propose("Check the proposal", [{ title: "Inspect" }]);
    });
    expect(result.current.dock.hasPlanArtifact).toBe(true);
    expect(result.current.reader.plan?.status).toBe("proposed");
    withdrawn = true;
    await act(async () => {
      await result.current.reader.withdraw();
    });
    expect(result.current.dock.hasPlanArtifact).toBe(false);
    expect(result.current.author.plan?.status).toBe("withdrawn");
  });

  it("defers auxiliary capability reads until the primary thread is display-ready", async () => {
    const planClient = { read: vi.fn(async () => ({ plan: null, history: [] })) };
    const shipClient = { targets: vi.fn(async () => []) };
    const canvasClient = { threadReferenceCards: vi.fn(async () => ({ cards: [] })) };
    const agentRunClient = { parentSummary: vi.fn(async () => ({ entries: [] })) };
    const { rerender } = renderHook(
      ({ enabled }) =>
        useDockToolCapabilities({
          enabled,
          addAgentInvoked: false,
          hasAppleSimulator: false,
          hasWrittenDocument: false,
          mode: "code",
          threadId: "10000000-0000-4000-8000-000000000001",
          planClient: planClient as never,
          shipClient: shipClient as never,
          canvasClient: canvasClient as never,
          agentRunClient: agentRunClient as never,
        }),
      { initialProps: { enabled: false } },
    );

    expect(planClient.read).not.toHaveBeenCalled();
    expect(shipClient.targets).not.toHaveBeenCalled();
    expect(canvasClient.threadReferenceCards).not.toHaveBeenCalled();
    expect(agentRunClient.parentSummary).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(planClient.read).toHaveBeenCalledOnce());
    expect(shipClient.targets).toHaveBeenCalledOnce();
    expect(canvasClient.threadReferenceCards).toHaveBeenCalledOnce();
    expect(agentRunClient.parentSummary).toHaveBeenCalledOnce();
  });
});
