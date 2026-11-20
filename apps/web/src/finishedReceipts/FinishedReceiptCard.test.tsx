import {
  decodeFinishedReceiptId,
  decodeProjectId,
  decodeUtcTimestamp,
  type ThreadFinishedReceipt,
  type ThreadGoalCriterionId,
} from "@octant/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  FinishedReceiptCard,
  FinishedReceiptInline,
  FinishedReceiptProvider,
} from "./FinishedReceiptCard";

const RECEIPT_ID = decodeFinishedReceiptId("11111111-1111-4111-8111-111111111111");
const THREAD_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = decodeProjectId("33333333-3333-4333-8333-333333333333");
const RECORDED_AT = decodeUtcTimestamp("2026-11-19T12:00:00.000Z");

function sampleReceipt(overrides: Partial<ThreadFinishedReceipt> = {}): ThreadFinishedReceipt {
  return {
    receipt: {
      receiptId: RECEIPT_ID,
      threadId: THREAD_ID,
      mode: "code",
      projectId: PROJECT_ID,
      turnId: "turn-1",
      summary: "Fixed the parser edge case and verified every test.",
      items: [
        {
          kind: "check",
          label: "bun run test parser",
          command: "bun run test parser",
          status: "proven",
          exitCode: 0,
          outputTail: "12 passed (12)",
        },
        {
          kind: "goal-criterion",
          criterionId: "c1" as ThreadGoalCriterionId,
          label: "Review wording with the team",
          status: "claimed",
        },
      ],
      diff: {
        status: "observed",
        changedFiles: 3,
        insertions: 42,
        deletions: 7,
      },
      recordedAt: RECORDED_AT,
    },
    status: "proven",
    stale: false,
    provenCount: 1,
    claimedCount: 1,
    failedCount: 0,
    unavailableCount: 0,
    ...overrides,
  };
}

describe("FinishedReceiptCard", () => {
  it("shows summary, checks with statuses, diff counts, and expands check output on keyboard or click", async () => {
    const user = userEvent.setup();
    render(<FinishedReceiptCard receipt={sampleReceipt()} />);

    const card = screen.getByRole("region", { name: "Finished, with proof" });
    expect(within(card).getByText("Finished, with proof")).toBeVisible();
    expect(within(card).getByText("1 proven · 1 claimed")).toBeVisible();
    expect(
      within(card).getByText("Fixed the parser edge case and verified every test."),
    ).toBeVisible();
    expect(within(card).getByText("3 files")).toBeVisible();
    expect(within(card).getByText("+42")).toBeVisible();
    expect(within(card).getByText("−7")).toBeVisible();
    expect(within(card).getByText("bun run test parser")).toBeVisible();
    expect(within(card).getByText("Proven")).toBeVisible();
    expect(within(card).getByText("Review wording with the team")).toBeVisible();
    expect(within(card).getByText("Claimed")).toBeVisible();

    // Output starts collapsed and expands cleanly.
    expect(within(card).queryByText("12 passed (12)")).toBeNull();
    const toggle = within(card).getByRole("button", { name: "Output" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(card).getByText("12 passed (12)")).toBeVisible();
  });

  it("shows stale status and unavailable diff when files changed or no folder exists", () => {
    const base = sampleReceipt();
    render(
      <FinishedReceiptCard
        receipt={{
          ...base,
          receipt: {
            ...base.receipt,
            diff: { status: "unavailable", reason: "This thread has no folder." },
          },
          status: "stale",
          stale: true,
        }}
      />,
    );

    const card = screen.getByRole("region", { name: "Finished, with proof" });
    expect(card).toHaveAttribute("data-stale", "true");
    expect(within(card).getByText("Stale")).toBeVisible();
    expect(within(card).getByText(/files changed after this report was recorded/i)).toBeVisible();
    expect(within(card).getByText("Diff unavailable")).toBeVisible();
  });

  it("renders inline at the end of the turn that produced the receipt", async () => {
    const receipt = sampleReceipt();
    const client = { receipts: vi.fn(async () => [receipt]) };

    render(
      <FinishedReceiptProvider client={client} threadId={THREAD_ID}>
        <FinishedReceiptInline
          last={false}
          loadedTurnIds={new Set(["turn-1", "turn-2"])}
          turnId="turn-1"
        />
        <FinishedReceiptInline last loadedTurnIds={new Set(["turn-1", "turn-2"])} turnId="turn-2" />
      </FinishedReceiptProvider>,
    );

    await waitFor(() => expect(client.receipts).toHaveBeenCalledWith(THREAD_ID, expect.anything()));
    expect(await screen.findAllByRole("region", { name: "Finished, with proof" })).toHaveLength(1);
  });
});
