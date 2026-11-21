import { describe, expect, it } from "vitest";
import {
  MAX_FINISHED_CHECKS,
  MAX_FINISHED_CHECK_COMMAND_LENGTH,
  MAX_FINISHED_CHECK_OUTPUT_TAIL_LENGTH,
  MAX_FINISHED_SUMMARY_LENGTH,
  REPORT_FINISHED_TOOL_NAME,
  THREAD_FINISHED_RECEIPT_EVENT_NAMES,
  decodeFinishedReceiptRecorded,
  decodeReportFinishedInput,
  decodeThreadBoardFinishedMark,
  decodeThreadFinishedReceipt,
  decodeThreadFinishedReceiptsResponse,
} from "./finishedReceipt";

const RECEIPT_ID = "11111111-1111-4111-8111-111111111111";
const THREAD_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const RECORDED_AT = "2026-11-19T12:00:00.000Z";

describe("finished receipt contracts", () => {
  it("accepts report-finished input at the exact summary, check count, and command length bounds", () => {
    const input = {
      summary: "x".repeat(MAX_FINISHED_SUMMARY_LENGTH),
      checks: Array.from({ length: MAX_FINISHED_CHECKS }, (_, index) =>
        `cmd-${String(index)}-`.padEnd(MAX_FINISHED_CHECK_COMMAND_LENGTH, "a"),
      ),
    };
    const decoded = decodeReportFinishedInput(input);
    expect(decoded.summary).toHaveLength(MAX_FINISHED_SUMMARY_LENGTH);
    expect(decoded.checks).toHaveLength(MAX_FINISHED_CHECKS);
    expect(decoded.checks?.[0]).toHaveLength(MAX_FINISHED_CHECK_COMMAND_LENGTH);
    expect(REPORT_FINISHED_TOOL_NAME).toBe("octant_report_finished");
    expect(THREAD_FINISHED_RECEIPT_EVENT_NAMES.recorded).toBe("thread.finished-receipt-recorded@1");
  });

  it("refuses report-finished inputs that exceed summary, check count, or check command bounds", () => {
    expect(() =>
      decodeReportFinishedInput({ summary: "x".repeat(MAX_FINISHED_SUMMARY_LENGTH + 1) }),
    ).toThrow();
    expect(() => decodeReportFinishedInput({ summary: "   " })).toThrow();
    expect(() =>
      decodeReportFinishedInput({
        summary: "Done",
        checks: Array.from({ length: MAX_FINISHED_CHECKS + 1 }, (_, i) => `test ${String(i)}`),
      }),
    ).toThrow();
    expect(() =>
      decodeReportFinishedInput({
        summary: "Done",
        checks: ["a".repeat(MAX_FINISHED_CHECK_COMMAND_LENGTH + 1)],
      }),
    ).toThrow();
    expect(() =>
      decodeReportFinishedInput({
        summary: "Done",
        checks: [""],
      }),
    ).toThrow();
  });

  it("round-trips a journaled finished receipt and projected thread receipt response", () => {
    const recorded = decodeFinishedReceiptRecorded({
      receiptId: RECEIPT_ID,
      threadId: THREAD_ID,
      mode: "code",
      projectId: PROJECT_ID,
      turnId: "turn-1",
      summary: "Implemented the requested parser fix and verified tests.",
      items: [
        {
          kind: "check",
          label: "bun run test parser",
          command: "bun run test parser",
          status: "proven",
          exitCode: 0,
          outputTail: "ok".repeat(MAX_FINISHED_CHECK_OUTPUT_TAIL_LENGTH / 2),
        },
        {
          kind: "goal-criterion",
          label: "Copy reads clearly to a human reviewer",
          criterionId: "c1",
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
    });
    expect(recorded.items).toHaveLength(2);
    expect(recorded.diff).toEqual({
      status: "observed",
      changedFiles: 3,
      insertions: 42,
      deletions: 7,
    });

    const projected = decodeThreadFinishedReceipt({
      receipt: recorded,
      status: "proven",
      stale: false,
      provenCount: 1,
      claimedCount: 1,
      failedCount: 0,
      unavailableCount: 0,
    });
    expect(decodeThreadFinishedReceiptsResponse({ receipts: [projected] }).receipts).toEqual([
      projected,
    ]);

    const mark = decodeThreadBoardFinishedMark({
      receiptId: RECEIPT_ID,
      provenCount: 1,
      claimedCount: 1,
      recordedAt: RECORDED_AT,
    });
    expect(mark.provenCount).toBe(1);
  });

  it("rejects check output tails longer than 2,000 characters", () => {
    expect(() =>
      decodeFinishedReceiptRecorded({
        receiptId: RECEIPT_ID,
        threadId: THREAD_ID,
        mode: "work",
        projectId: PROJECT_ID,
        summary: "Finished drafting report.",
        items: [
          {
            kind: "check",
            label: "check-script",
            command: "check-script",
            status: "proven",
            exitCode: 0,
            outputTail: "x".repeat(MAX_FINISHED_CHECK_OUTPUT_TAIL_LENGTH + 1),
          },
        ],
        diff: { status: "unavailable", reason: "This thread has no folder." },
        recordedAt: RECORDED_AT,
      }),
    ).toThrow();
  });
});
