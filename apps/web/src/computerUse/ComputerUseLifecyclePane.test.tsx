import { decodeComputerUseSessionView } from "@octant/contracts/computer-use";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComputerUseLifecyclePane } from "./ComputerUseLifecyclePane";

const waiting = decodeComputerUseSessionView({
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
  sequence: 2,
  pendingApproval: {
    approvalId: "80000000-0000-4000-8000-000000000001",
    actionId: "90000000-0000-4000-8000-000000000001",
    expiresAt: "2026-07-27T21:01:00.000Z",
    summary: "click in Preview",
  },
  events: [
    {
      sequence: 1,
      kind: "observation-recorded",
      occurredAt: "2026-07-27T21:00:00.000Z",
      detail: "Fresh host observation recorded.",
    },
    {
      sequence: 2,
      kind: "approval-requested",
      occurredAt: "2026-07-27T21:00:01.000Z",
      detail: "One-time approval is required.",
    },
  ],
});

describe("ComputerUseLifecyclePane", () => {
  it("shows the exact pending action with approve, deny, and immediate stop", () => {
    const approve = vi.fn();
    const deny = vi.fn();
    const stop = vi.fn();
    render(
      <ComputerUseLifecyclePane onApprove={approve} onDeny={deny} onStop={stop} view={waiting} />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Waiting for approval");
    expect(screen.getByText("click in Preview")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop computer use" }));
    expect(approve).toHaveBeenCalledOnce();
    expect(deny).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each([
    ["running", "Running"],
    ["stopping", "Stopping"],
    ["stopped", "Stopped"],
    ["interrupted", "Interrupted"],
    ["failed", "Failed"],
    ["completed", "Completed"],
  ] as const)("renders %s truthfully", (state, label) => {
    const { pendingApproval: _pending, ...base } = waiting;
    render(
      <ComputerUseLifecyclePane
        onApprove={() => undefined}
        onDeny={() => undefined}
        onStop={() => undefined}
        view={{ ...base, state }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(label);
    const stop = screen.queryByRole("button", { name: "Stop computer use" });
    if (state === "running" || state === "stopping") expect(stop).toBeInTheDocument();
    else expect(stop).not.toBeInTheDocument();
  });

  it("shows redacted lifecycle evidence without exposing action payloads", () => {
    render(
      <ComputerUseLifecyclePane
        onApprove={() => undefined}
        onDeny={() => undefined}
        onStop={() => undefined}
        view={waiting}
      />,
    );
    expect(screen.getByText("Fresh host observation recorded.")).toBeVisible();
    expect(screen.queryByText(/password|credential|secret value/i)).not.toBeInTheDocument();
  });
});
