import type { ComputerUseClient } from "@octant/client-runtime/computer-use-client";
import { decodeComputerUseSessionView } from "@octant/contracts/computer-use";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComputerUseLifecycleSurface } from "./ComputerUseLifecycleSurface";

const view = decodeComputerUseSessionView({
  sessionId: "10000000-0000-4000-8000-000000000001",
  threadId: "20000000-0000-4000-8000-000000000001",
  requestedBy: { kind: "local-user", actorId: "30000000-0000-4000-8000-000000000001" },
  authority: {
    hostId: "40000000-0000-4000-8000-000000000001",
    mode: "work",
    projectId: "50000000-0000-4000-8000-000000000001",
    providerInstanceId: "60000000-0000-4000-8000-000000000001",
    extension: { kind: "core" },
  },
  state: "waiting-for-approval",
  sequence: 1,
  pendingApproval: {
    approvalId: "70000000-0000-4000-8000-000000000001",
    actionId: "80000000-0000-4000-8000-000000000001",
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

describe("ComputerUseLifecycleSurface", () => {
  it("connects replay, visible approval, and stop through the shared client", async () => {
    const { pendingApproval: _pending, ...terminal } = view;
    const client = {
      list: vi.fn(async () => [view]),
      inspect: vi.fn(async () => view),
      decide: vi.fn(async () => ({ ...terminal, state: "completed" })),
      stop: vi.fn(async () => ({ ...terminal, state: "stopped" })),
    } as ComputerUseClient;
    render(<ComputerUseLifecycleSurface client={client} scope={scope} />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    await screen.findByText("click in Preview");
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    await waitFor(() => expect(client.decide).toHaveBeenCalledOnce());
    expect(client.decide).toHaveBeenCalledWith({
      ...scope,
      actionId: view.pendingApproval!.actionId,
      approvalId: view.pendingApproval!.approvalId,
      decision: "approved",
    });
  });

  it("shows an interrupted reconnect truthfully with retry", async () => {
    const client = {
      list: vi.fn(async () => [view]),
      inspect: vi.fn(async () => {
        throw Object.assign(new Error("Host connection interrupted."), {
          category: "interrupted",
        });
      }),
      decide: vi.fn(),
      stop: vi.fn(),
    } as ComputerUseClient;
    render(<ComputerUseLifecycleSurface client={client} scope={scope} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Host connection interrupted.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(client.inspect).toHaveBeenCalledTimes(2));
  });
});
