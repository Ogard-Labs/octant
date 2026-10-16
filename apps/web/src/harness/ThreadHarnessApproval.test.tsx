import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { NativeHarnessSessionView } from "@octant/contracts";
import { ThreadHarnessApproval } from "./ThreadHarnessApproval";

const threadId = "00000000-0000-4000-8000-000000000020";
const approval = {
  id: "00000000-0000-4000-8000-000000000061",
  toolName: "bash",
  summary: "bash: bun run test",
  approvalClass: "shell-commands",
  status: "pending",
  askedAt: "2026-10-16T12:06:00.000Z",
};
const childApproval = {
  ...approval,
  id: "00000000-0000-4000-8000-000000000062",
  approvalClass: "child-provider-action",
  source: {
    runId: "00000000-0000-4000-8000-000000000090",
    providerInstanceId: "00000000-0000-4000-8000-000000000001",
    modelId: "worker-model",
  },
};

function view(
  overrides: {
    readonly approvals?: ReadonlyArray<unknown>;
    readonly status?: "idle" | "running" | "recovery-required";
  } = {},
): NativeHarnessSessionView {
  const status = overrides.status ?? "running";
  return {
    session: {
      id: "00000000-0000-4000-8000-000000000010",
      threadId,
      mode: "code",
      leadSlotId: "default",
      lead: {
        hostId: "00000000-0000-4000-8000-0000000000aa",
        providerInstanceId: "00000000-0000-4000-8000-000000000001",
        modelId: "frontier-large",
      },
      status,
      ...(status === "recovery-required"
        ? { detail: "Octant restarted while the lead was waiting for an answer." }
        : {}),
      turnsRun: 1,
      cutovers: 0,
      startedAt: "2026-10-16T12:00:00.000Z",
      updatedAt: "2026-10-16T12:05:00.000Z",
      version: 4,
    },
    routes: [],
    turns: [],
    reductions: [],
    interventions: [],
    activatedFollowUpIds: [],
    questions: [],
    approvals: overrides.approvals ?? [approval],
  } as never;
}

function clientFor(read: () => Promise<NativeHarnessSessionView | null>) {
  return {
    session: vi.fn(read),
    command: vi.fn(),
    decideApproval: vi.fn(async () => ({
      kind: "approval-decided",
      approval: { ...approval, status: "approved", settledAt: "2026-10-16T12:06:05.000Z" },
    })),
  };
}

describe("the agent's approval card in a thread", () => {
  it("shows the agent's own pending approval beside the composer and sends the person's decision", async () => {
    const user = userEvent.setup();
    const client = clientFor(async () => view());
    render(<ThreadHarnessApproval client={client as never} threadId={threadId} />);

    const card = await screen.findByRole("region", { name: "Approval requested" });
    expect(within(card).getByText("bun run test")).toBeVisible();
    await user.click(within(card).getByRole("button", { name: "Allow" }));
    await waitFor(() =>
      expect(client.decideApproval).toHaveBeenCalledExactlyOnceWith(threadId, {
        approvalId: approval.id,
        decision: "approve",
      }),
    );
  });

  it("sends a denial and the hosts ticked for a marked thread's command", async () => {
    const user = userEvent.setup();
    const listed = {
      ...approval,
      singleUse: true,
      commandHosts: [
        { host: "api.example.com", port: 443, from: "thread-rule", preselected: true },
        { host: "cdn.example.com", port: 443, from: "project-rule", preselected: false },
      ],
    };
    const client = clientFor(async () => view({ approvals: [listed] }));
    render(<ThreadHarnessApproval client={client as never} threadId={threadId} />);

    const card = await screen.findByRole("region", { name: "Approval requested" });
    expect(within(card).queryByRole("button", { name: "Allow for this session" })).toBeNull();
    await user.click(within(card).getByRole("checkbox", { name: /cdn\.example\.com/ }));
    await user.click(within(card).getByRole("button", { name: "Allow" }));
    await waitFor(() =>
      expect(client.decideApproval).toHaveBeenCalledWith(threadId, {
        approvalId: approval.id,
        decision: "approve",
        commandHosts: [
          { host: "api.example.com", port: 443 },
          { host: "cdn.example.com", port: 443 },
        ],
      }),
    );
  });

  it("says nothing for a subagent's approval, which the Agents tab answers", async () => {
    const client = clientFor(async () => view({ approvals: [childApproval] }));
    render(<ThreadHarnessApproval client={client as never} threadId={threadId} />);
    await waitFor(() => expect(client.session).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Approval requested" })).toBeNull();
  });

  it("says nothing for a thread with no session or an approval already decided", async () => {
    const none = clientFor(async () => null);
    const { unmount } = render(
      <ThreadHarnessApproval client={none as never} threadId={threadId} />,
    );
    await waitFor(() => expect(none.session).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Approval requested" })).toBeNull();
    unmount();

    const settled = clientFor(async () =>
      view({
        approvals: [{ ...approval, status: "approved", settledAt: "2026-10-16T12:07:00.000Z" }],
      }),
    );
    render(<ThreadHarnessApproval client={settled as never} threadId={threadId} />);
    await waitFor(() => expect(settled.session).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Approval requested" })).toBeNull();
  });

  it("goes away when another surface answers it", async () => {
    let pending = true;
    const client = clientFor(async () =>
      view({
        approvals: pending
          ? [approval]
          : [{ ...approval, status: "denied", settledAt: "2026-10-16T12:07:00.000Z" }],
      }),
    );
    render(
      <ThreadHarnessApproval client={client as never} refreshIntervalMs={20} threadId={threadId} />,
    );
    await screen.findByRole("region", { name: "Approval requested" });
    pending = false;
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Approval requested" })).toBeNull(),
    );
  });

  it("shows the host's refusal and keeps the card when the decision is refused", async () => {
    const user = userEvent.setup();
    const client = clientFor(async () => view());
    client.decideApproval.mockResolvedValueOnce({
      kind: "approval-refused",
      approvalId: approval.id,
      reason: "already-settled",
      message: "That approval was already decided.",
    } as never);
    render(<ThreadHarnessApproval client={client as never} threadId={threadId} />);
    await user.click(await screen.findByRole("button", { name: "Allow" }));
    expect(await screen.findByText("That approval was already decided.")).toBeVisible();
  });

  it("reads once for a thread that is not waiting and polls only while a hint or an approval says it is", async () => {
    const client = clientFor(async () => null);
    const { rerender } = render(
      <ThreadHarnessApproval
        client={client as never}
        refreshIntervalMs={20}
        threadId={threadId}
        waiting={false}
      />,
    );
    await waitFor(() => expect(client.session).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.session).toHaveBeenCalledTimes(1);

    rerender(
      <ThreadHarnessApproval
        client={client as never}
        refreshIntervalMs={20}
        threadId={threadId}
        waiting
      />,
    );
    await waitFor(() => expect(client.session.mock.calls.length).toBeGreaterThan(2));
  });

  describe("after a host restart", () => {
    it("says the call did not run and offers only Resume, never Allow or Deny", async () => {
      const user = userEvent.setup();
      const client = clientFor(async () => view({ status: "recovery-required" }));
      client.command.mockResolvedValue({
        kind: "native-harness-session",
        session: view().session,
      });
      render(<ThreadHarnessApproval client={client as never} threadId={threadId} />);

      const card = await screen.findByRole("region", { name: "Approval was waiting at restart" });
      expect(card).toHaveTextContent("Octant restarted while this was waiting, so it did not run.");
      expect(within(card).getByText("bun run test")).toBeVisible();
      expect(within(card).queryByRole("button", { name: "Allow" })).toBeNull();
      expect(within(card).queryByRole("button", { name: "Deny" })).toBeNull();
      await user.click(within(card).getByRole("button", { name: "Resume" }));
      await waitFor(() =>
        expect(client.command).toHaveBeenCalledExactlyOnceWith(threadId, {
          kind: "resume-native-harness-session",
          sessionId: "00000000-0000-4000-8000-000000000010",
          expectedVersion: 4,
        }),
      );
      expect(client.decideApproval).not.toHaveBeenCalled();
    });

    it("shows what stands in the way when the resume is refused", async () => {
      const user = userEvent.setup();
      const client = clientFor(async () => view({ status: "recovery-required" }));
      client.command.mockResolvedValue({
        kind: "native-harness-session-refused",
        reason: "not-ready",
        message: "Not ready to resume: The thread's folder is gone.",
      });
      render(<ThreadHarnessApproval client={client as never} threadId={threadId} />);
      await user.click(await screen.findByRole("button", { name: "Resume" }));
      expect(await screen.findByText(/The thread's folder is gone\./)).toBeVisible();
    });
  });
});
