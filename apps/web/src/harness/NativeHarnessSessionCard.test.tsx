import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { NativeHarnessSessionView } from "@octant/contracts";
import { NativeHarnessSessionCard } from "./NativeHarnessSessionCard";

const threadId = "00000000-0000-4000-8000-000000000020";
const suggestionId = "00000000-0000-4000-8000-000000000041";

function view(): NativeHarnessSessionView {
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
      status: "idle",
      turnsRun: 3,
      cutovers: 1,
      startedAt: "2026-09-05T12:00:00.000Z",
      updatedAt: "2026-09-05T12:05:00.000Z",
      version: 4,
    },
    routes: [
      {
        kind: "failure-fallback",
        job: "researcher",
        slotId: "task",
        candidate: {
          hostId: "00000000-0000-4000-8000-0000000000aa",
          providerInstanceId: "00000000-0000-4000-8000-000000000002",
          modelId: "spare",
        },
        from: {
          hostId: "00000000-0000-4000-8000-0000000000aa",
          providerInstanceId: "00000000-0000-4000-8000-000000000003",
          modelId: "small",
        },
        reason: "rate-limited",
        cooldownUntil: "2026-09-05T12:06:00.000Z",
        decidedAt: "2026-09-05T12:05:00.000Z",
        rejected: [],
      },
    ],
    turns: [],
    reductions: [],
    interventions: [],
    followUps: {
      turnId: "00000000-0000-4000-8000-000000000031",
      suggestions: [
        {
          id: suggestionId,
          title: "Add tests",
          prompt: "Write tests for the parser.",
          target: "new-thread",
        },
      ],
    },
    activatedFollowUpIds: [],
    questions: [],
  } as never;
}

describe("NativeHarnessSessionCard", () => {
  it("shows the lead and a fallback routing decision", async () => {
    const client = {
      session: vi.fn(async () => view()),
      command: vi.fn(),
      answerQuestion: vi.fn(),
      decideApproval: vi.fn(),
    };
    render(<NativeHarnessSessionCard client={client} threadId={threadId} />);
    await waitFor(() => expect(screen.getByText(/frontier-large/)).toBeVisible());
    expect(screen.getByText(/fell back to spare after rate-limited/)).toBeVisible();
  });

  it("names a restart's recovery and says why a resume was refused", async () => {
    const recovering = view();
    const held = {
      ...recovering,
      session: {
        ...recovering.session,
        status: "recovery-required" as const,
        detail: "Octant restarted while a turn was running. Check what it did, then resume.",
      },
    };
    const client = {
      session: vi.fn(async () => held),
      command: vi.fn(async () => ({
        kind: "native-harness-session-refused" as const,
        reason: "not-ready" as const,
        message: "Not ready to resume: The thread's checkout is no longer available.",
      })),
      answerQuestion: vi.fn(),
      decideApproval: vi.fn(),
    };
    render(<NativeHarnessSessionCard client={client} threadId={threadId} />);
    await waitFor(() => expect(screen.getByText("Needs a check after restart")).toBeVisible());

    await userEvent.setup().click(screen.getByRole("button", { name: "Resume" }));

    expect(client.command).toHaveBeenCalledWith(
      threadId,
      expect.objectContaining({ kind: "resume-native-harness-session" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Not ready to resume: The thread's checkout is no longer available.",
    );
  });

  it("shows the lead's pending question and sends the picked option as the answer", async () => {
    const question = {
      id: "00000000-0000-4000-8000-000000000051",
      prompt: "Which database?",
      options: ["sqlite", "postgres"],
      status: "pending",
      askedAt: "2026-09-05T12:06:00.000Z",
    };
    const client = {
      session: vi.fn(async () => ({ ...view(), questions: [question] })),
      command: vi.fn(),
      answerQuestion: vi.fn(async () => ({
        kind: "question-answered",
        question: { ...question, status: "answered", answer: "sqlite" },
      })),
    };
    render(<NativeHarnessSessionCard client={client as never} threadId={threadId} />);
    await waitFor(() => expect(screen.getByText("Which database?")).toBeVisible());
    await userEvent.click(screen.getByRole("button", { name: "sqlite" }));
    await waitFor(() =>
      expect(client.answerQuestion).toHaveBeenCalledWith(threadId, {
        questionId: question.id,
        answer: "sqlite",
      }),
    );
  });

  it("attributes a child approval and offers a decision for only that request", async () => {
    const approval = {
      id: "00000000-0000-4000-8000-000000000061",
      toolName: "provider-action",
      summary: "Run the focused tests",
      approvalClass: "child-provider-action",
      status: "pending",
      askedAt: "2026-09-05T12:06:00.000Z",
      source: {
        runId: "00000000-0000-4000-8000-000000000062",
        providerInstanceId: "00000000-0000-4000-8000-000000000063",
        providerName: "Codex",
        modelId: "gpt-5",
      },
    };
    const client = {
      session: vi.fn(async () => ({ ...view(), approvals: [approval] })),
      command: vi.fn(),
      answerQuestion: vi.fn(),
      decideApproval: vi.fn(async () => ({
        kind: "approval-decided",
        approval: { ...approval, status: "approved", settledAt: "2026-09-05T12:06:05.000Z" },
      })),
    };
    render(<NativeHarnessSessionCard client={client as never} threadId={threadId} />);
    await waitFor(() => expect(screen.getByText(/Codex.*gpt-5/)).toBeVisible());
    expect(screen.queryByRole("button", { name: "Allow for this session" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(client.decideApproval).toHaveBeenCalledWith(threadId, {
      approvalId: approval.id,
      decision: "approve",
    });
  });

  it("shows a gated tool call and sends the person's decision", async () => {
    const approval = {
      id: "00000000-0000-4000-8000-000000000061",
      toolName: "bash",
      summary: "bash: bun run test",
      approvalClass: "shell-commands",
      status: "pending",
      askedAt: "2026-09-05T12:06:00.000Z",
    };
    const client = {
      session: vi.fn(async () => ({ ...view(), approvals: [approval] })),
      command: vi.fn(),
      answerQuestion: vi.fn(),
      decideApproval: vi.fn(async () => ({
        kind: "approval-decided",
        approval: { ...approval, status: "approved", settledAt: "2026-09-05T12:06:05.000Z" },
      })),
    };
    render(<NativeHarnessSessionCard client={client as never} threadId={threadId} />);
    await waitFor(() => expect(screen.getByText("bun run test")).toBeVisible());
    await userEvent.click(screen.getByRole("button", { name: "Allow for this session" }));
    await waitFor(() =>
      expect(client.decideApproval).toHaveBeenCalledWith(threadId, {
        approvalId: approval.id,
        decision: "approve-always",
      }),
    );
  });
});
