import type { ComputerUseClient } from "@octant/client-runtime/computer-use-client";
import { decodeComputerUseSessionView } from "@octant/contracts/computer-use";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useComputerUseLifecycle } from "./useComputerUseLifecycle";

const view = decodeComputerUseSessionView({
  sessionId: "10000000-0000-4000-8000-000000000001",
  threadId: "20000000-0000-4000-8000-000000000001",
  requestedBy: { kind: "local-user", actorId: "30000000-0000-4000-8000-000000000001" },
  authority: {
    hostId: "40000000-0000-4000-8000-000000000001",
    mode: "work",
    projectId: "50000000-0000-4000-8000-000000000001",
    rootId: "60000000-0000-4000-8000-000000000001",
    providerInstanceId: "70000000-0000-4000-8000-000000000001",
    extension: { kind: "core" },
  },
  state: "waiting-for-approval",
  sequence: 1,
  pendingApproval: {
    approvalId: "80000000-0000-4000-8000-000000000001",
    actionId: "90000000-0000-4000-8000-000000000001",
    expiresAt: "2026-07-27T21:01:00.000Z",
    summary: "click in Preview",
  },
  events: [
    {
      sequence: 1,
      kind: "approval-requested",
      occurredAt: "2026-07-27T21:00:00.000Z",
      detail: "One-time approval is required.",
    },
  ],
});
const scope = { sessionId: view.sessionId, threadId: view.threadId, authority: view.authority };

function fixture(): ComputerUseClient {
  const { pendingApproval: _pending, ...terminal } = view;
  return {
    list: vi.fn(async () => [view]),
    inspect: vi.fn(async () => view),
    decide: vi.fn(async () => ({ ...terminal, state: "completed" })),
    stop: vi.fn(async () => ({ ...terminal, state: "stopped" })),
  } as ComputerUseClient;
}

describe("useComputerUseLifecycle", () => {
  it("loads replay state and submits the exact pending approval", async () => {
    const client = fixture();
    const { result } = renderHook(() => useComputerUseLifecycle({ client, scope }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.view).toEqual(view);

    await act(() => result.current.approve());
    expect(client.decide).toHaveBeenCalledWith({
      ...scope,
      actionId: view.pendingApproval!.actionId,
      approvalId: view.pendingApproval!.approvalId,
      decision: "approved",
    });
    expect(result.current.view?.state).toBe("completed");
  });

  it("denies or stops through the exact session scope", async () => {
    const denyClient = fixture();
    const denied = renderHook(() => useComputerUseLifecycle({ client: denyClient, scope }));
    await waitFor(() => expect(denied.result.current.status).toBe("ready"));
    await act(() => denied.result.current.deny());
    expect(denyClient.decide).toHaveBeenCalledWith(
      expect.objectContaining({ ...scope, decision: "denied" }),
    );

    const stopClient = fixture();
    const stopped = renderHook(() => useComputerUseLifecycle({ client: stopClient, scope }));
    await waitFor(() => expect(stopped.result.current.status).toBe("ready"));
    await act(() => stopped.result.current.stop());
    expect(stopClient.stop).toHaveBeenCalledWith(scope);
    expect(stopped.result.current.view?.state).toBe("stopped");
  });

  it("keeps denial and interrupted transport failures truthful", async () => {
    const denied = fixture();
    vi.mocked(denied.inspect).mockRejectedValue(
      Object.assign(new Error("Approval expired."), { category: "approval-denied" }),
    );
    const deniedResult = renderHook(() => useComputerUseLifecycle({ client: denied, scope }));
    await waitFor(() => expect(deniedResult.result.current.status).toBe("failed"));
    expect(deniedResult.result.current.errorMessage).toBe("Approval expired.");

    const interrupted = fixture();
    vi.mocked(interrupted.inspect).mockRejectedValue(
      Object.assign(new Error("Interrupted."), { category: "interrupted" }),
    );
    const interruptedResult = renderHook(() =>
      useComputerUseLifecycle({ client: interrupted, scope }),
    );
    await waitFor(() => expect(interruptedResult.result.current.status).toBe("interrupted"));
  });
});
