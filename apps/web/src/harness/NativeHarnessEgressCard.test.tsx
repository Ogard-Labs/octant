import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  ToolEgressCommand,
  ToolEgressCommandResult,
  ToolEgressThreadView,
} from "@octant/contracts";
import { NativeHarnessClientFailure } from "@octant/client-runtime/native-harness-client";
import { NativeHarnessEgressCard } from "./NativeHarnessEgressCard";

const threadId = "00000000-0000-4000-8000-000000000020";
const now = Date.parse("2026-10-14T12:00:00.000Z");

function view(overrides: Partial<ToolEgressThreadView> = {}): ToolEgressThreadView {
  return {
    threadId,
    projectId: "00000000-0000-4000-8000-000000000030",
    enforced: false,
    learnMode: true,
    threadTainted: false,
    projectGrant: "allowed",
    threadRules: [
      {
        ruleId: "00000000-0000-4000-8000-000000000041",
        host: "*.githubusercontent.com",
        port: 443,
        scope: "thread",
        expiresAt: "2026-10-14T19:00:00.000Z",
        grantedAt: "2026-10-14T11:00:00.000Z",
        grantedBy: "local-window",
      },
    ],
    projectRules: [],
    proposals: [
      {
        proposalId: "00000000-0000-4000-8000-000000000051",
        host: "registry.npmjs.org",
        port: 443,
        reason: "no-rule",
        attempts: 3,
        raisedAt: "2026-10-14T11:59:00.000Z",
        threadTainted: false,
      },
      {
        proposalId: "00000000-0000-4000-8000-000000000052",
        host: "collector.example.com",
        port: 8443,
        reason: "no-rule",
        attempts: 1,
        raisedAt: "2026-10-14T11:59:00.000Z",
        threadTainted: false,
        childThreadId: "00000000-0000-4000-8000-0000000000c1",
      },
    ],
    ...overrides,
  } as ToolEgressThreadView;
}

function client(initial: ToolEgressThreadView | null) {
  const sent: ToolEgressCommand[] = [];
  return {
    sent,
    egress: vi.fn(async () => initial),
    egressCommand: vi.fn(
      async (_threadId: string, command: ToolEgressCommand): Promise<ToolEgressCommandResult> => {
        sent.push(command);
        return { kind: "tool-egress-updated", view: view({ proposals: [] }) };
      },
    ),
  };
}

function renderCard(fake: ReturnType<typeof client>) {
  return render(
    <NativeHarnessEgressCard
      client={fake}
      now={() => now}
      refreshIntervalMs={60_000}
      threadId={threadId}
    />,
  );
}

describe("NativeHarnessEgressCard", () => {
  it("shows nothing for a thread with no rules and no proposals while commands bypass them", async () => {
    const fake = client(view({ threadRules: [], proposals: [] }));
    const { container } = renderCard(fake);
    await waitFor(() => expect(fake.egress).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("grants nothing until the person answers, then sends each host's choice", async () => {
    const user = userEvent.setup();
    const fake = client(view());
    renderCard(fake);
    expect(await screen.findByText("registry.npmjs.org")).toBeInTheDocument();
    expect(screen.getByText("collector.example.com:8443")).toBeInTheDocument();
    expect(screen.getByText(/subagent 00000000/)).toBeInTheDocument();
    expect(fake.egressCommand).not.toHaveBeenCalled();

    await user.click(screen.getByLabelText("Allow collector.example.com:8443"));
    await user.click(await screen.findByRole("option", { name: "Don't allow" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]).toEqual({
      kind: "grant-rules",
      grants: [
        { host: "registry.npmjs.org", port: 443, choice: { kind: "thread", lifetime: "8h" } },
      ],
      declineProposalIds: ["00000000-0000-4000-8000-000000000052"],
    });
  });

  it("offers a tainted thread no standing rule, only a way to turn the hosts down", async () => {
    const user = userEvent.setup();
    const fake = client(
      view({
        threadTainted: true,
        projectGrant: "thread-tainted",
        proposals: view().proposals.map((proposal) => ({ ...proposal, threadTainted: true })),
      }),
    );
    renderCard(fake);
    expect(await screen.findByText(/only for one command you confirm/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.queryByLabelText("Host")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Decline all" }));
    await waitFor(() =>
      expect(fake.sent).toEqual([
        {
          kind: "decline-proposals",
          proposalIds: [
            "00000000-0000-4000-8000-000000000051",
            "00000000-0000-4000-8000-000000000052",
          ],
        },
      ]),
    );
  });

  it("keeps Project scopes out of reach of a caller who may not grant them", async () => {
    const user = userEvent.setup();
    const fake = client(view({ projectGrant: "needs-local-window" }));
    renderCard(fake);
    await user.click(await screen.findByLabelText("How long"));
    expect(await screen.findByRole("option", { name: "Project, 7 days" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("revokes a rule and adds a typed host with its lifetime", async () => {
    const user = userEvent.setup();
    const fake = client(view({ proposals: [] }));
    renderCard(fake);
    expect(await screen.findByText(/7 h left/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke *.githubusercontent.com" }));
    await waitFor(() =>
      expect(fake.sent).toEqual([
        { kind: "revoke-rule", ruleId: "00000000-0000-4000-8000-000000000041" },
      ]),
    );

    await user.type(screen.getByLabelText("Host"), "pypi.org");
    await user.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(fake.sent).toHaveLength(2));
    expect(fake.sent[1]).toEqual({
      kind: "grant-rules",
      grants: [{ host: "pypi.org", port: 443, choice: { kind: "thread", lifetime: "8h" } }],
      declineProposalIds: [],
    });
  });

  it("offers a host a tainted subagent asked for no standing rule, even on a clean thread", async () => {
    const user = userEvent.setup();
    const [clean, tainted] = view().proposals;
    const fake = client(
      view({
        proposals: [
          clean,
          { ...tainted, threadTainted: true },
        ] as ToolEgressThreadView["proposals"],
      }),
    );
    renderCard(fake);
    expect(await screen.findByText(/one command only/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Allow collector.example.com:8443")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]).toEqual({
      kind: "grant-rules",
      grants: [
        { host: "registry.npmjs.org", port: 443, choice: { kind: "thread", lifetime: "8h" } },
      ],
      declineProposalIds: [],
    });
  });

  it("drops a failed read's warning once a later read succeeds", async () => {
    const fake = client(view({ proposals: [] }));
    fake.egress.mockRejectedValueOnce(
      new NativeHarnessClientFailure("The native harness service is unavailable.", 0),
    );
    render(
      <NativeHarnessEgressCard
        client={fake}
        now={() => now}
        refreshIntervalMs={50}
        threadId={threadId}
      />,
    );
    expect(
      await screen.findByText("The native harness service is unavailable."),
    ).toBeInTheDocument();
    expect(await screen.findByText("*.githubusercontent.com")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("The native harness service is unavailable.")).toBeNull(),
    );
  });

  it("shows a refusal the host gave in its own words", async () => {
    const user = userEvent.setup();
    const fake = client(view({ proposals: [] }));
    fake.egressCommand.mockResolvedValueOnce({
      kind: "tool-egress-refused",
      reason: "invalid-host",
      message: "That host cannot be a rule.",
    });
    renderCard(fake);
    await user.type(await screen.findByLabelText("Host"), "localhost");
    await user.click(screen.getByRole("button", { name: "Allow" }));
    expect(await screen.findByText("That host cannot be a rule.")).toBeInTheDocument();
  });
});
