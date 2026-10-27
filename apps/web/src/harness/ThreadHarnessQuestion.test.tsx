import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { NativeHarnessSessionView } from "@octant/contracts";
import { ThreadHarnessCards } from "./ThreadHarnessCards";

const threadId = "00000000-0000-4000-8000-000000000020";
const question = {
  id: "00000000-0000-4000-8000-000000000071",
  prompt: "Which quarter should the summary cover?",
  options: ["Q3", "Q4"],
  status: "pending",
  askedAt: "2026-10-16T12:06:00.000Z",
};
const childQuestion = {
  ...question,
  id: "00000000-0000-4000-8000-000000000072",
  source: {
    runId: "00000000-0000-4000-8000-000000000090",
    providerInstanceId: "00000000-0000-4000-8000-000000000001",
    modelId: "worker-model",
  },
};

function view(
  overrides: {
    readonly questions?: ReadonlyArray<unknown>;
    readonly mode?: "chat" | "work" | "code";
    readonly status?: "running" | "recovery-required";
  } = {},
): NativeHarnessSessionView {
  const status = overrides.status ?? "running";
  return {
    session: {
      id: "00000000-0000-4000-8000-000000000010",
      threadId,
      mode: overrides.mode ?? "work",
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
    questions: overrides.questions ?? [question],
    approvals: [],
  } as never;
}

function clientFor(
  read: () => Promise<NativeHarnessSessionView | null>,
  answered: unknown = {
    kind: "question-answered",
    question: {
      ...question,
      status: "answered",
      answer: "Q4",
      settledAt: "2026-10-16T12:06:05.000Z",
    },
  },
) {
  return {
    session: vi.fn(read),
    answerQuestion: vi.fn(async () => answered),
  };
}

describe("the agent's question card in a Work thread", () => {
  it("shows the agent's own pending question and sends the chosen answer through the session route", async () => {
    const user = userEvent.setup();
    const client = clientFor(async () => view());
    render(<ThreadHarnessCards client={client as never} threadId={threadId} />);

    const card = await screen.findByRole("region", { name: "Provider question" });
    expect(within(card).getByText("Which quarter should the summary cover?")).toBeVisible();
    await user.click(within(card).getByRole("radio", { name: "Q4" }));
    await user.click(within(card).getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(client.answerQuestion).toHaveBeenCalledExactlyOnceWith(threadId, {
        questionId: question.id,
        answer: "Q4",
      }),
    );
  });

  it("sends an answer the person types when no option fits", async () => {
    const user = userEvent.setup();
    const client = clientFor(async () => view({ questions: [{ ...question, options: [] }] }));
    render(<ThreadHarnessCards client={client as never} threadId={threadId} />);

    const card = await screen.findByRole("region", { name: "Provider question" });
    await user.click(within(card).getByRole("radio", { name: "Type your own answer" }));
    await user.type(within(card).getByRole("textbox", { name: "Your answer" }), "Both halves");
    await user.click(within(card).getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(client.answerQuestion).toHaveBeenCalledExactlyOnceWith(threadId, {
        questionId: question.id,
        answer: "Both halves",
      }),
    );
  });

  it("says why the host refused the answer", async () => {
    const user = userEvent.setup();
    const client = clientFor(async () => view(), {
      kind: "question-refused",
      questionId: question.id,
      reason: "already-settled",
      message: "That question was already answered.",
    });
    render(<ThreadHarnessCards client={client as never} threadId={threadId} />);

    const card = await screen.findByRole("region", { name: "Provider question" });
    await user.click(within(card).getByRole("radio", { name: "Q3" }));
    await user.click(within(card).getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("That question was already answered.")).toBeVisible();
  });

  it("goes away once the question is answered from any surface", async () => {
    let current = view();
    const client = clientFor(async () => current);
    render(
      <ThreadHarnessCards client={client as never} threadId={threadId} refreshIntervalMs={20} />,
    );
    await screen.findByRole("region", { name: "Provider question" });
    current = view({
      questions: [
        { ...question, status: "answered", answer: "Q3", settledAt: "2026-10-16T12:07:00.000Z" },
      ],
    });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Provider question" })).toBeNull(),
    );
  });

  it("keeps one refresh going while the question, an approval, and the running turn's notes all show", async () => {
    const approval = {
      id: "00000000-0000-4000-8000-000000000061",
      toolName: "write",
      summary: "write: summary.md",
      approvalClass: "file-writes",
      status: "pending",
      askedAt: "2026-10-16T12:06:00.000Z",
    };
    const client = clientFor(async () => ({ ...view(), approvals: [approval] }) as never);
    render(
      <ThreadHarnessCards
        client={client as never}
        refreshIntervalMs={25}
        running
        threadId={threadId}
        waiting
      />,
    );
    await screen.findByRole("region", { name: "Provider question" });
    await screen.findByRole("region", { name: "Approval requested" });
    const before = client.session.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    // One timer reads about twelve times in 300 ms; a reader per card would
    // read about three times as often.
    expect(client.session.mock.calls.length - before).toBeLessThanOrEqual(14);
  });

  it("says nothing for a subagent's question, which the Agents tab answers", async () => {
    const client = clientFor(async () => view({ questions: [childQuestion] }));
    render(<ThreadHarnessCards client={client as never} threadId={threadId} />);
    await waitFor(() => expect(client.session).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Provider question" })).toBeNull();
  });

  it("says nothing for a question a restart left behind, which no turn can receive", async () => {
    const client = clientFor(async () => view({ status: "recovery-required" }));
    render(<ThreadHarnessCards client={client as never} threadId={threadId} />);
    await waitFor(() => expect(client.session).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Provider question" })).toBeNull();
  });

  it("says nothing for a Code or Chat session, whose own thread view shows the question", async () => {
    const code = clientFor(async () => view({ mode: "code" }));
    const { unmount } = render(<ThreadHarnessCards client={code as never} threadId={threadId} />);
    await waitFor(() => expect(code.session).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Provider question" })).toBeNull();
    unmount();

    const none = clientFor(async () => null);
    render(<ThreadHarnessCards client={none as never} threadId={threadId} />);
    await waitFor(() => expect(none.session).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Provider question" })).toBeNull();
  });
});
