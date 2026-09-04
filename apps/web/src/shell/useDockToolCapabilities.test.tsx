import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDockToolCapabilities } from "./useDockToolCapabilities";

describe("useDockToolCapabilities", () => {
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
