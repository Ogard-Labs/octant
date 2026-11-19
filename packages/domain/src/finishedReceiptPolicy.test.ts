import {
  MAX_FINISHED_CHECK_OUTPUT_TAIL_LENGTH,
  decodeFinishedReceiptId,
  decodeFinishedReceiptRecorded,
  decodeProjectId,
  decodeUtcTimestamp,
  type FinishedReceiptRecorded,
  type ThreadGoalCriterionId,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  boundFinishedCheckOutputTail,
  deriveClaimedGoalCriterionItem,
  deriveFinishedReceiptCheckItem,
  deriveFinishedReceiptStatus,
  evaluateFinishedReport,
  finishedBoardMarkFromReceipts,
  formatFinishedReceiptSendBackPrefill,
  isReceiptStaleAfterJournalEvents,
  projectThreadFinishedReceipts,
  selectCompletionReceiptId,
} from "./finishedReceiptPolicy";

const RECEIPT_1 = decodeFinishedReceiptId("11111111-1111-4111-8111-111111111111");
const RECEIPT_2 = decodeFinishedReceiptId("11111111-1111-4111-8111-111111111112");
const THREAD_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = decodeProjectId("33333333-3333-4333-8333-333333333333");
const RECORDED_AT = decodeUtcTimestamp("2026-11-19T12:00:00.000Z");

function sampleReceipt(overrides: Partial<FinishedReceiptRecorded> = {}): FinishedReceiptRecorded {
  return decodeFinishedReceiptRecorded({
    receiptId: RECEIPT_1,
    threadId: THREAD_ID,
    mode: "code",
    projectId: PROJECT_ID,
    turnId: "turn-1",
    summary: "Implemented the change and ran the test suite.",
    items: [
      {
        kind: "check",
        label: "bun run test",
        command: "bun run test",
        status: "proven",
        exitCode: 0,
        outputTail: "all passed",
      },
    ],
    diff: { status: "observed", changedFiles: 2, insertions: 15, deletions: 4 },
    recordedAt: RECORDED_AT,
    ...overrides,
  });
}

describe("finished receipt policy", () => {
  it("derives proven, failed, claimed, and unavailable item statuses and caps output to the last 2,000 characters", () => {
    const longOutput = `prefix-${"a".repeat(2_500)}-tail`;
    expect(boundFinishedCheckOutputTail(longOutput)).toHaveLength(
      MAX_FINISHED_CHECK_OUTPUT_TAIL_LENGTH,
    );
    expect(boundFinishedCheckOutputTail(longOutput).endsWith("-tail")).toBe(true);

    const proven = deriveFinishedReceiptCheckItem({
      kind: "check",
      label: "bun run test",
      command: "bun run test",
      outcome: { status: "ran", exitCode: 0, output: "ok" },
    });
    expect(proven.status).toBe("proven");
    expect(proven.exitCode).toBe(0);

    const failedExit = deriveFinishedReceiptCheckItem({
      kind: "check",
      label: "bun run lint",
      command: "bun run lint",
      outcome: { status: "ran", exitCode: 1, output: longOutput },
    });
    expect(failedExit.status).toBe("failed");
    expect(failedExit.outputTail).toHaveLength(MAX_FINISHED_CHECK_OUTPUT_TAIL_LENGTH);
    expect(failedExit.outputTail?.endsWith("-tail")).toBe(true);

    const timedOut = deriveFinishedReceiptCheckItem({
      kind: "check",
      label: "bun run slow",
      command: "bun run slow",
      outcome: { status: "timed-out", output: "still running" },
    });
    expect(timedOut.status).toBe("failed");
    expect(timedOut.reason).toContain("timed out");

    const denied = deriveFinishedReceiptCheckItem({
      kind: "check",
      label: "bun run deploy",
      command: "bun run deploy",
      outcome: { status: "approval-denied" },
    });
    expect(denied.status).toBe("failed");
    expect(denied.reason).toContain("denied");

    const unavailable = deriveFinishedReceiptCheckItem({
      kind: "check",
      label: "bun run test",
      command: "bun run test",
      outcome: { status: "unavailable", reason: "This thread has no folder." },
    });
    expect(unavailable.status).toBe("unavailable");

    const claimed = deriveClaimedGoalCriterionItem({
      id: "c1" as ThreadGoalCriterionId,
      text: "Tone matches the team guide",
    });
    expect(claimed.status).toBe("claimed");
    expect(claimed.command).toBeUndefined();
  });

  it("refuses to accept a finished report when any check failed and never treats words alone as proven", () => {
    const failed = deriveFinishedReceiptCheckItem({
      kind: "check",
      label: "bun run test",
      command: "bun run test",
      outcome: { status: "ran", exitCode: 2, output: "assertion failed" },
    });
    const proven = deriveFinishedReceiptCheckItem({
      kind: "check",
      label: "bun run fmt:check",
      command: "bun run fmt:check",
      outcome: { status: "ran", exitCode: 0, output: "" },
    });

    const rejected = evaluateFinishedReport([proven, failed]);
    expect(rejected.accepted).toBe(false);
    if (!rejected.accepted) {
      expect(rejected.failedItems).toHaveLength(1);
      expect(rejected.failedItems[0]?.label).toBe("bun run test");
    }

    // With zero checks or only claimed criteria, the report is claimed, never proven.
    expect(deriveFinishedReceiptStatus({ items: [], stale: false })).toBe("claimed");
    expect(
      deriveFinishedReceiptStatus({
        items: [
          deriveClaimedGoalCriterionItem({
            id: "c1" as ThreadGoalCriterionId,
            text: "Looks good",
          }),
        ],
        stale: false,
      }),
    ).toBe("claimed");

    expect(
      deriveFinishedReceiptStatus({
        items: [
          deriveFinishedReceiptCheckItem({
            kind: "check",
            label: "check",
            command: "check",
            outcome: { status: "unavailable", reason: "No folder" },
          }),
        ],
        stale: false,
      }),
    ).toBe("unavailable");

    expect(deriveFinishedReceiptStatus({ items: [proven], stale: true })).toBe("stale");
  });

  it("marks receipts stale strictly from later journal file-change events while ignoring the reporting turn's own end-of-turn summary", () => {
    // Earlier file change (seq 5) and same-turn summary (seq 12, turn-1) do not stale receipt at seq 10.
    expect(
      isReceiptStaleAfterJournalEvents({
        receiptSequence: 10,
        receiptTurnId: "turn-1",
        fileChanges: [{ sequence: 5 }, { sequence: 12, turnId: "turn-1" }],
      }),
    ).toBe(false);

    // Direct file change after receipt (seq 11, no turnId) stales even within the same turn.
    expect(
      isReceiptStaleAfterJournalEvents({
        receiptSequence: 10,
        receiptTurnId: "turn-1",
        fileChanges: [{ sequence: 11 }],
      }),
    ).toBe(true);

    // A later turn's file summary (seq 20, turn-2) stales the earlier receipt.
    expect(
      isReceiptStaleAfterJournalEvents({
        receiptSequence: 10,
        receiptTurnId: "turn-1",
        fileChanges: [{ sequence: 20, turnId: "turn-2" }],
      }),
    ).toBe(true);
  });

  it("clears the board mark and completion receipt evidence when stale and restores them on a newer fresh receipt", () => {
    const receipt1 = sampleReceipt({ receiptId: RECEIPT_1, turnId: "turn-1" });
    const receipt2 = sampleReceipt({ receiptId: RECEIPT_2, turnId: "turn-2" });

    const fresh = projectThreadFinishedReceipts({
      receipts: [{ sequence: 10, receipt: receipt1 }],
      fileChanges: [{ sequence: 12, turnId: "turn-1" }],
    });
    expect(fresh[0]?.stale).toBe(false);
    expect(fresh[0]?.status).toBe("proven");
    expect(finishedBoardMarkFromReceipts(fresh)).toEqual({
      receiptId: RECEIPT_1,
      provenCount: 1,
      claimedCount: 0,
      recordedAt: RECORDED_AT,
    });
    expect(selectCompletionReceiptId(fresh)).toBe(RECEIPT_1);

    const staled = projectThreadFinishedReceipts({
      receipts: [{ sequence: 10, receipt: receipt1 }],
      fileChanges: [{ sequence: 15, turnId: "turn-2" }],
    });
    expect(staled[0]?.stale).toBe(true);
    expect(staled[0]?.status).toBe("stale");
    expect(finishedBoardMarkFromReceipts(staled)).toBeUndefined();
    expect(selectCompletionReceiptId(staled)).toBeUndefined();

    const refreshed = projectThreadFinishedReceipts({
      receipts: [
        { sequence: 10, receipt: receipt1 },
        { sequence: 25, receipt: receipt2 },
      ],
      fileChanges: [{ sequence: 15, turnId: "turn-2" }],
    });
    expect(refreshed[0]?.stale).toBe(true);
    expect(refreshed[1]?.stale).toBe(false);
    expect(finishedBoardMarkFromReceipts(refreshed)?.receiptId).toBe(RECEIPT_2);
    expect(selectCompletionReceiptId(refreshed)).toBe(RECEIPT_2);
  });

  it("prefills send-back feedback only from failed or claimed receipt items", () => {
    const onlyProven = projectThreadFinishedReceipts({
      receipts: [{ sequence: 10, receipt: sampleReceipt() }],
      fileChanges: [],
    })[0];
    expect(formatFinishedReceiptSendBackPrefill(onlyProven)).toBe("");

    const withClaimed = projectThreadFinishedReceipts({
      receipts: [
        {
          sequence: 10,
          receipt: sampleReceipt({
            items: [
              {
                kind: "check",
                label: "bun run test",
                command: "bun run test",
                status: "proven",
                exitCode: 0,
              },
              {
                kind: "goal-criterion",
                criterionId: "c1" as ThreadGoalCriterionId,
                label: "Verify visual alignment in dark mode",
                status: "claimed",
              },
            ],
          }),
        },
      ],
      fileChanges: [],
    })[0];
    expect(formatFinishedReceiptSendBackPrefill(withClaimed)).toBe(
      "Please address before finishing: Verify visual alignment in dark mode (unverified)",
    );
  });
});
