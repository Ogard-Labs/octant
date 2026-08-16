import type { ComputerUseClient } from "@octant/client-runtime/computer-use-client";
import { decodeComputerUseSessionView } from "@octant/contracts/computer-use";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComputerUseActivitySurface } from "./ComputerUseActivitySurface";

const view = decodeComputerUseSessionView({
  sessionId: "10000000-0000-4000-8000-000000000001",
  threadId: "20000000-0000-4000-8000-000000000001",
  requestedBy: {
    kind: "local-user",
    actorId: "30000000-0000-4000-8000-000000000001",
  },
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

describe("ComputerUseActivitySurface", () => {
  it("keeps background window sessions visible", async () => {
    const client = clientWith([view]);
    render(<ComputerUseActivitySurface client={client} pollIntervalMs={60_000} />);

    expect(
      await screen.findByRole("complementary", {
        name: "Background computer use",
      }),
    ).toBeVisible();
    expect(await screen.findByText("click in Preview")).toBeVisible();
  });

  it("suppresses a session already represented by the visible thread PiP", async () => {
    const client = clientWith([view]);
    const { container } = render(
      <ComputerUseActivitySurface
        client={client}
        excludedSessions={new Map([[String(view.threadId), new Set([String(view.sessionId)])]])}
        pollIntervalMs={60_000}
      />,
    );
    await vi.waitFor(() => expect(client.list).toHaveBeenCalledOnce());
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps an unrepresented active session visible when one thread owns multiple sessions", async () => {
    const second = decodeComputerUseSessionView({
      ...view,
      sessionId: "10000000-0000-4000-8000-000000000002",
      pendingApproval: {
        ...view.pendingApproval!,
        approvalId: "70000000-0000-4000-8000-000000000002",
        actionId: "80000000-0000-4000-8000-000000000002",
        summary: "type in Preview",
      },
    });
    const client = clientWith([view, second]);

    render(
      <ComputerUseActivitySurface
        client={client}
        excludedSessions={new Map([[String(view.threadId), new Set([String(view.sessionId)])]])}
        pollIntervalMs={60_000}
      />,
    );

    expect(
      await screen.findByRole("complementary", {
        name: "Background computer use",
      }),
    ).toBeVisible();
    expect(await screen.findByText("type in Preview")).toBeVisible();
    expect(screen.queryByText("click in Preview")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Stop computer use" })).toHaveLength(1);
  });

  it("does not treat a retained terminal session as a second active session", async () => {
    const { pendingApproval: _pendingApproval, ...withoutApproval } = view;
    const terminal = decodeComputerUseSessionView({
      ...withoutApproval,
      sessionId: "10000000-0000-4000-8000-000000000003",
      state: "completed",
      sequence: 2,
      events: [
        ...view.events,
        {
          sequence: 2,
          kind: "action-completed",
          occurredAt: "2026-07-27T21:00:01.000Z",
          detail: "The retained action completed.",
        },
      ],
    });
    const client = clientWith([view, terminal]);
    const { container } = render(
      <ComputerUseActivitySurface
        client={client}
        excludedSessions={new Map([[String(view.threadId), new Set([String(view.sessionId)])]])}
        pollIntervalMs={60_000}
      />,
    );

    await waitFor(() => expect(client.list).toHaveBeenCalledOnce());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("clears lifecycle authority when the host session list becomes unavailable", async () => {
    const client = clientWith([view]);
    client.list.mockResolvedValueOnce([view]).mockRejectedValue(new Error("host disconnected"));

    const { rerender } = render(
      <ComputerUseActivitySurface client={client} pollIntervalMs={60_000} />,
    );

    expect(await screen.findByText("click in Preview")).toBeVisible();
    rerender(<ComputerUseActivitySurface client={client} pollIntervalMs={59_999} />);
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("click in Preview")).not.toBeInTheDocument());
    expect(
      screen.queryByRole("complementary", { name: "Background computer use" }),
    ).not.toBeInTheDocument();
  });
});

function clientWith(sessions: ReadonlyArray<typeof view>) {
  return {
    list: vi.fn(async () => sessions),
    inspect: vi.fn(async (scope: { readonly sessionId: string }) => {
      const session = sessions.find((candidate) => candidate.sessionId === scope.sessionId);
      if (session === undefined) throw new Error("session not found");
      return session;
    }),
    decide: vi.fn(),
    stop: vi.fn(),
  } as unknown as ComputerUseClient & {
    readonly list: ReturnType<typeof vi.fn>;
  };
}
