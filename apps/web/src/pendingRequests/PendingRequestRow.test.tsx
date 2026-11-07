import { decodePendingRequest, decodeUtcTimestamp } from "@octant/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  codeChildQuestion,
  codeQuestion,
  codeDecision,
  workChildApproval,
  workLeadApproval,
  workLeadQuestion,
} from "../palette/pendingRequests.test-fixtures";
import { PendingRequestRow } from "./PendingRequestRow";
import { answerPendingRequest } from "./pendingRequests";

const NOW = Date.parse("2026-10-06T08:10:00.000Z");

describe("a decision row", () => {
  it("shows the ask clamped to two lines, the recommended option first and marked, and Reply…", () => {
    render(
      <PendingRequestRow
        now={NOW}
        onAnswer={vi.fn()}
        onOpenThread={vi.fn()}
        request={codeDecision()}
      />,
    );
    const row = screen.getByRole("group", { name: "Fix the parser asks you to decide" });
    const ask = within(row).getByText("The fix is ready. Should I open the pull request now?");
    expect(ask).toHaveClass("pending-request__text");
    expect(within(row).getByText("Waiting 6m")).toBeInTheDocument();
    const actions = within(row)
      .getAllByRole("button")
      .slice(1)
      .map((button) => button.textContent);
    expect(actions).toEqual(["1Open itRecommended", "2Wait for review", "Add note", "Reply…"]);
  });

  it("puts the recommended option first in focus order and sends an option by its number", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn(async () => ({ status: "answered" as const }));
    const request = codeDecision();
    render(
      <PendingRequestRow
        embedded
        now={NOW}
        onAnswer={onAnswer}
        onOpenThread={vi.fn()}
        request={request}
      />,
    );
    await user.tab();
    expect(document.activeElement).toHaveTextContent("Open it");
    await user.keyboard("2");
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(request, {
      kind: "choice",
      label: "Wait for review",
    });
  });

  it("opens the thread from Reply… and sends nothing", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    const onOpenThread = vi.fn();
    const request = codeDecision();
    render(
      <PendingRequestRow
        now={NOW}
        onAnswer={onAnswer}
        onOpenThread={onOpenThread}
        request={request}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Reply…" }));
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(request);
    expect(onAnswer).not.toHaveBeenCalled();
  });
});

function richDecision(extra: object = {}) {
  const base = codeDecision();
  return decodePendingRequest({
    ...base,
    why: "Tests are green and the freeze starts Monday.",
    options: [
      { label: "Wait for review", recommended: false },
      { label: "Open it", recommended: true, detail: "Rollback is ready in five minutes" },
    ],
    ...extra,
  });
}

const REVIEWER = "00000000-0000-4000-8000-0000000000b1";
const ASKER = "00000000-0000-4000-8000-0000000000b2";
const askedBy = { providerInstanceId: ASKER, modelId: "claude-sonnet" };
const review = (backs: string) => ({
  status: "reviewed",
  providerInstanceId: REVIEWER,
  modelId: "gpt-5",
  providerName: "Reviewer account",
  driverKind: "codex",
  backs,
  reason: "Review is not finished.",
  reviewedAt: "2026-10-06T08:06:00.000Z",
});

describe("a decision's second opinion", () => {
  it("names the asking model under the recommended option and the reviewer under the option it backs", () => {
    render(
      <PendingRequestRow
        now={NOW}
        onAnswer={vi.fn()}
        onOpenThread={vi.fn()}
        request={richDecision({ askedBy, review: review("Wait for review") })}
      />,
    );
    expect(screen.getByText("claude-sonnet · asking thread")).toBeInTheDocument();
    expect(screen.getByText("gpt-5 · Second opinion: Review is not finished.")).toBeInTheDocument();
    expect(screen.getByText("Second opinion differs")).toBeInTheDocument();
  });

  it("puts both lines under one option and shows no tag when the reviewer backs the recommendation", () => {
    render(
      <PendingRequestRow
        now={NOW}
        onAnswer={vi.fn()}
        onOpenThread={vi.fn()}
        request={richDecision({ askedBy, review: review("Open it") })}
      />,
    );
    const lines = screen.getAllByText(/ · (asking thread|Second opinion: )/);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.closest(".pending-request__option")).toBe(
      lines[1]?.closest(".pending-request__option"),
    );
    expect(screen.queryByText("Second opinion differs")).not.toBeInTheDocument();
  });

  it("says a second opinion is on its way, and why none came, in one muted line each", () => {
    const view = render(
      <PendingRequestRow
        now={NOW}
        onAnswer={vi.fn()}
        onOpenThread={vi.fn()}
        request={richDecision({ review: { status: "pending" } })}
      />,
    );
    expect(screen.getByText("Getting a second opinion…")).toBeInTheDocument();
    const reasons = {
      failed: "The reviewer's answer could not be read",
      withheld: "The reviewer read outside content, so its answer was not used",
      "not-allowed": "This Project doesn't allow the chosen provider",
    } as const;
    for (const [status, reason] of Object.entries(reasons)) {
      view.rerender(
        <PendingRequestRow
          now={NOW}
          onAnswer={vi.fn()}
          onOpenThread={vi.fn()}
          request={richDecision({ review: { status } })}
        />,
      );
      expect(screen.getByText("No second opinion")).toHaveAttribute("title", reason);
    }
  });

  it("shows nothing about a second opinion when there is none", () => {
    render(
      <PendingRequestRow
        now={NOW}
        onAnswer={vi.fn()}
        onOpenThread={vi.fn()}
        request={richDecision()}
      />,
    );
    expect(screen.queryByText(/second opinion/i)).not.toBeInTheDocument();
  });
});

describe("a decision card", () => {
  it("shows the why, each option's detail and an Urgent tag", () => {
    render(
      <PendingRequestRow
        now={NOW}
        onAnswer={vi.fn()}
        onOpenThread={vi.fn()}
        request={richDecision({ urgent: true })}
      />,
    );
    expect(screen.getByText("Tests are green and the freeze starts Monday.")).toBeInTheDocument();
    expect(screen.getByText("Rollback is ready in five minutes")).toBeInTheDocument();
    expect(screen.getByText("Urgent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open it/ })).toHaveTextContent("Recommended");
  });

  it("sends the note with the picked option and keeps number keys for text while typing", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn(async () => ({ status: "answered" as const }));
    const request = richDecision();
    render(
      <PendingRequestRow now={NOW} onAnswer={onAnswer} onOpenThread={vi.fn()} request={request} />,
    );
    await user.click(screen.getByRole("button", { name: "Add note" }));
    await user.type(screen.getByRole("textbox", { name: "Note sent with your choice" }), "2 days");
    expect(onAnswer).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Open it/ }));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(request, {
      kind: "choice",
      label: "Open it",
      note: "2 days",
    });
  });

  it("closes the note on Escape and offers no note inside an embedding card", async () => {
    const user = userEvent.setup();
    const view = render(
      <PendingRequestRow
        now={NOW}
        onAnswer={vi.fn()}
        onOpenThread={vi.fn()}
        request={richDecision()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add note" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    view.rerender(
      <PendingRequestRow
        embedded
        now={NOW}
        onAnswer={vi.fn()}
        onOpenThread={vi.fn()}
        request={richDecision()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Add note" })).not.toBeInTheDocument();
  });

  it("offers the same defer controls for a decision as for a question, and brings a deferred one back", async () => {
    const user = userEvent.setup();
    const request = { ...richDecision(), deferralKey: "b".repeat(64) };
    const onDefer = vi.fn(async () => true);
    const props = { onAnswer: vi.fn(), onDefer, onOpenThread: vi.fn() };
    const view = render(<PendingRequestRow {...props} now={NOW} request={request} />);
    expect(screen.getByRole("combobox", { name: "Defer decision until" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Defer decision" })).toBeDisabled();
    view.rerender(
      <PendingRequestRow
        {...props}
        now={NOW}
        request={{ ...request, deferredUntil: decodeUtcTimestamp("2026-10-06T12:00:00.000Z") }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("The decision remains unanswered.");
    await user.click(screen.getByRole("button", { name: "Bring back now" }));
    expect(onDefer).toHaveBeenCalledExactlyOnceWith(expect.anything(), null);
    expect(props.onAnswer).not.toHaveBeenCalled();
  });
});

describe("answering a decision", () => {
  function answerClients() {
    return {
      chatClient: { execute: vi.fn() },
      codeClient: {
        executeOperation: vi.fn(async () => ({
          kind: "provider-turn-state",
          state: "running",
        })),
        putEvidence: vi.fn(async () => ({ evidenceId: "evidence-1" })),
      },
      workRequestClient: { execute: vi.fn() },
      workTurnClient: { startFirstTurn: vi.fn(async () => ({ kind: "accepted" })) },
    };
  }

  it("sends the label alone, or the label and the trimmed note as the next turn", async () => {
    const clients = answerClients();
    const request = richDecision();
    const send = (response: Parameters<typeof answerPendingRequest>[2]) =>
      answerPendingRequest(clients as never, request, response);
    await send({ kind: "choice", label: "Open it" });
    await send({ kind: "choice", label: "Open it", note: "  " });
    await send({ kind: "choice", label: "Open it", note: " after the smoke tests " });
    const evidence = clients.codeClient.putEvidence.mock.calls as ReadonlyArray<
      ReadonlyArray<unknown>
    >;
    expect(evidence.map((call) => call[1])).toEqual([
      "Open it",
      "Open it",
      "Open it\n\nafter the smoke tests",
    ]);
    expect(await send({ kind: "choice", label: "Not an option", note: "x" })).toMatchObject({
      status: "refused",
    });
  });
});

describe("a waiting subagent row", () => {
  it("names the parent thread and the subagent and offers only Review request", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    const onOpenThread = vi.fn();
    const request = workChildApproval();
    render(
      <PendingRequestRow
        now={NOW}
        onAnswer={onAnswer}
        onOpenThread={onOpenThread}
        request={request}
      />,
    );
    const row = screen.getByRole("group", {
      name: "Quarterly report has a subagent waiting for you",
    });
    expect(within(row).getByText("Research subagent needs your approval")).toBeInTheDocument();
    expect(within(row).getByText(/Collect last quarter's figures\./)).toBeInTheDocument();
    expect(within(row).getByText("shell: bun run collect")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Deny" })).toBeNull();
    expect(
      within(row)
        .getAllByRole("button")
        .slice(1)
        .map((button) => button.textContent),
    ).toEqual(["Review request"]);
    await user.click(screen.getByRole("button", { name: "Review request" }));
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(request);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("says a subagent asked a question and answers nothing from a number key", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(
      <PendingRequestRow
        now={NOW}
        onAnswer={onAnswer}
        onOpenThread={vi.fn()}
        request={codeChildQuestion()}
      />,
    );
    expect(screen.getByText("Review subagent asked a question")).toBeInTheDocument();
    await user.tab();
    await user.keyboard("1");
    expect(onAnswer).not.toHaveBeenCalled();
  });
});

describe("an agent approval row", () => {
  it("says the agent needs approval and offers only Review request, never Approve or Deny", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    const onOpenThread = vi.fn();
    const request = workLeadApproval();
    render(
      <PendingRequestRow
        now={NOW}
        onAnswer={onAnswer}
        onOpenThread={onOpenThread}
        request={request}
      />,
    );
    const row = screen.getByRole("group", { name: "Quarterly report needs your approval" });
    expect(within(row).getByText("edit: summary.md")).toBeInTheDocument();
    expect(within(row).getByText("Waiting 3m")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Deny" })).toBeNull();
    expect(
      within(row)
        .getAllByRole("button")
        .slice(1)
        .map((button) => button.textContent),
    ).toEqual(["Review request"]);
    await user.click(screen.getByRole("button", { name: "Review request" }));
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(request);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("says a Work agent's own question is waiting and offers only Review request, never a choice", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    const onOpenThread = vi.fn();
    const request = workLeadQuestion();
    render(
      <PendingRequestRow
        now={NOW}
        onAnswer={onAnswer}
        onOpenThread={onOpenThread}
        request={request}
      />,
    );
    const row = screen.getByRole("group", { name: "Quarterly report is waiting for your answer" });
    expect(within(row).getByText("Which quarter should the summary cover?")).toBeInTheDocument();
    expect(
      within(row)
        .getAllByRole("button")
        .slice(1)
        .map((button) => button.textContent),
    ).toEqual(["Review request"]);
    await user.tab();
    await user.keyboard("1");
    await user.click(screen.getByRole("button", { name: "Review request" }));
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(request);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("says an approval a restart left behind did not run", () => {
    render(
      <PendingRequestRow
        now={NOW}
        onAnswer={vi.fn()}
        onOpenThread={vi.fn()}
        request={workLeadApproval(true)}
      />,
    );
    expect(
      screen.getByText("Octant restarted while this was waiting, so it did not run."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review request" })).toBeInTheDocument();
  });

  it("answers nothing from a number key", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(
      <PendingRequestRow
        now={NOW}
        onAnswer={onAnswer}
        onOpenThread={vi.fn()}
        request={workLeadApproval()}
      />,
    );
    await user.tab();
    await user.keyboard("1");
    expect(onAnswer).not.toHaveBeenCalled();
  });
});

it("brings a deferred question back without answering it and restores choices when its time passes", async () => {
  const user = userEvent.setup();
  const request = decodePendingRequest({
    mode: "chat",
    kind: "question",
    threadId: "00000000-0000-4000-8000-000000000001",
    threadTitle: "Plan",
    text: "Which approach?",
    options: [{ label: "First" }],
    requestedAt: "2026-10-06T08:00:00.000Z",
    deferralKey: "a".repeat(64),
    deferredUntil: "2026-10-06T09:00:00.000Z",
    answer: {
      threadId: "00000000-0000-4000-8000-000000000001",
      turnId: "00000000-0000-4000-8000-000000000002",
      attemptId: "00000000-0000-4000-8000-000000000003",
      requestId: "q-one",
      expectedVersion: 1,
    },
  });
  const answer = vi.fn();
  const defer = vi.fn(async () => true);
  const view = render(
    <PendingRequestRow
      request={request}
      now={NOW}
      onAnswer={answer}
      onDefer={defer}
      onOpenThread={vi.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: /First/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Bring back now" }));
  expect(defer).toHaveBeenCalledExactlyOnceWith(request, null);
  expect(answer).not.toHaveBeenCalled();
  view.rerender(
    <PendingRequestRow
      request={request}
      now={Date.parse("2026-10-06T10:00:00Z")}
      onAnswer={answer}
      onDefer={defer}
      onOpenThread={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: /First/ })).toBeInTheDocument();
});

it("keeps the chosen reminder across clock ticks and clears it after deferral", async () => {
  const user = userEvent.setup();
  const request = { ...codeQuestion(), deferralKey: "a".repeat(64) };
  const onDefer = vi.fn(async () => true);
  const onAnswer = vi.fn();
  const props = { request, onDefer, onAnswer, onOpenThread: vi.fn() };
  const view = render(<PendingRequestRow {...props} now={NOW} />);
  await user.click(screen.getByRole("combobox", { name: "Defer question until" }));
  await user.click(screen.getByRole("option", { name: "In 1 hour" }));
  const later = NOW + 60_000;
  view.rerender(<PendingRequestRow {...props} now={later} />);
  expect(screen.getByRole("combobox")).toHaveTextContent("In 1 hour");
  const clock = vi.spyOn(Date, "now").mockReturnValue(later + 10_000);
  try {
    await user.click(screen.getByRole("button", { name: "Defer question" }));
    expect(onDefer).toHaveBeenCalledExactlyOnceWith(
      request,
      new Date(later + 10_000 + 3_600_000).toISOString(),
    );
    view.rerender(<PendingRequestRow {...props} now={later + 3_600_000 + 20_000} />);
    expect(screen.getByRole("combobox")).toHaveTextContent("Remind me…");
    expect(screen.getByRole("button", { name: "Defer question" })).toBeDisabled();
    expect(onAnswer).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});
