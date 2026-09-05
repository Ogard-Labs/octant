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
  it("shows the lead, a fallback routing decision, and the suggested follow-ups", async () => {
    const client = {
      session: vi.fn(async () => view()),
      command: vi.fn(),
      previewFollowUp: vi.fn(),
      activateFollowUp: vi.fn(),
      answerQuestion: vi.fn(),
    };
    render(<NativeHarnessSessionCard client={client} threadId={threadId} />);
    await waitFor(() => expect(screen.getByText(/frontier-large/)).toBeVisible());
    expect(screen.getByText(/fell back to spare after rate-limited/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Add tests" })).toBeVisible();
  });

  it("previews a follow-up and only activates it after an explicit confirmation", async () => {
    const activated = vi.fn();
    const client = {
      session: vi.fn(async () => view()),
      command: vi.fn(),
      previewFollowUp: vi.fn(async () => ({
        suggestion: view().followUps!.suggestions[0]!,
        wouldCreate: { kind: "new-thread", mode: "code", title: "Add tests" },
      })),
      activateFollowUp: vi.fn(async () => ({
        kind: "follow-up-activated",
        suggestionId,
        created: { kind: "new-thread", mode: "code", title: "Add tests" },
      })),
    };
    render(
      <NativeHarnessSessionCard
        client={client as never}
        onFollowUpActivated={activated}
        threadId={threadId}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Add tests" })).toBeVisible());
    await userEvent.click(screen.getByRole("button", { name: "Add tests" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Follow-up preview" })).toBeVisible(),
    );
    expect(client.activateFollowUp).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(client.activateFollowUp).toHaveBeenCalledTimes(1));
    expect((client.activateFollowUp.mock.calls[0] as unknown[] | undefined)?.[1]).toMatchObject({
      confirmed: true,
    });
    expect(activated).toHaveBeenCalledTimes(1);
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
      previewFollowUp: vi.fn(),
      activateFollowUp: vi.fn(),
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
});
