import {
  MAX_REPLAYABLE_RUN_CASES,
  decodeFinishedReceiptId,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeUtcTimestamp,
  type FinishedReceiptItem,
  type FinishedReceiptRecorded,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  isFinishedReceiptAllProven,
  projectReplayableRunCases,
  summarizeAllProvenShare,
  type ReplayableRunCaseCandidate,
} from "./replayableRunCasePolicy";

const PROJECT_ID = decodeProjectId("11111111-1111-4111-8111-111111111111");
const PROVIDER_ID = decodeProviderInstanceId("22222222-2222-4222-8222-222222222222");
const MODEL_ID = decodeProviderModelId("claude-sonnet-4-5");

function receiptUuid(index: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`;
}

function threadUuid(index: number): string {
  return `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, "0")}`;
}

function makeReceipt(input: {
  readonly index: number;
  readonly mode?: "work" | "code";
  readonly threadId?: string;
  readonly items?: ReadonlyArray<FinishedReceiptItem>;
  readonly diff?: FinishedReceiptRecorded["diff"];
}): FinishedReceiptRecorded {
  return {
    receiptId: decodeFinishedReceiptId(receiptUuid(input.index)),
    threadId: input.threadId ?? threadUuid(input.index),
    mode: input.mode ?? "code",
    projectId: PROJECT_ID,
    turnId: `turn-${String(input.index)}`,
    summary: `Finished task ${String(input.index)}`,
    items: input.items ?? [
      {
        kind: "check",
        label: "bun run test",
        command: "bun run test",
        status: "proven",
        exitCode: 0,
      },
    ],
    diff: input.diff ?? {
      status: "observed",
      changedFiles: input.index % 5,
      insertions: 10,
      deletions: 2,
    },
    recordedAt: decodeUtcTimestamp(
      `2026-11-19T12:${String(Math.floor(input.index / 60)).padStart(2, "0")}:${String(input.index % 60).padStart(2, "0")}.000Z`,
    ),
  };
}

function makeCandidate(
  index: number,
  overrides: Partial<ReplayableRunCaseCandidate> = {},
): ReplayableRunCaseCandidate {
  const receipt = overrides.receipt ?? makeReceipt({ index });
  return {
    sequence: index,
    receipt,
    request: `Handle request ${String(index)}`,
    projectName: "Octant",
    model: { providerInstanceId: PROVIDER_ID, modelId: MODEL_ID },
    ...overrides,
  };
}

describe("replayable run case projection policy", () => {
  it("extracts replayable cases from Work and Code finished receipts with request, Project, mode, model, receipt, and changed-file count", () => {
    const workReceipt = makeReceipt({
      index: 1,
      mode: "work",
      diff: { status: "unavailable", reason: "This thread has no folder." },
    });
    const codeReceipt = makeReceipt({
      index: 2,
      mode: "code",
      diff: { status: "observed", changedFiles: 4, insertions: 30, deletions: 5 },
    });

    const cases = projectReplayableRunCases({
      candidates: [
        makeCandidate(1, {
          receipt: workReceipt,
          request: "  Draft the quarterly memo  ",
          projectName: "Operations",
        }),
        makeCandidate(2, {
          receipt: codeReceipt,
          request: "Fix parser crash on empty input",
          projectName: "Octant",
        }),
      ],
    });

    expect(cases).toHaveLength(2);
    // Ordered newest first.
    expect(cases[0]).toEqual({
      receiptId: codeReceipt.receiptId,
      threadId: codeReceipt.threadId,
      mode: "code",
      request: "Fix parser crash on empty input",
      project: { id: PROJECT_ID, name: "Octant" },
      model: { providerInstanceId: PROVIDER_ID, modelId: MODEL_ID },
      receipt: codeReceipt,
      changedFileCount: 4,
      recordedAt: codeReceipt.recordedAt,
    });
    expect(cases[1]).toEqual({
      receiptId: workReceipt.receiptId,
      threadId: workReceipt.threadId,
      mode: "work",
      request: "Draft the quarterly memo",
      project: { id: PROJECT_ID, name: "Operations" },
      model: { providerInstanceId: PROVIDER_ID, modelId: MODEL_ID },
      receipt: workReceipt,
      recordedAt: workReceipt.recordedAt,
    });
    expect("changedFileCount" in (cases[1] ?? {})).toBe(false);
  });

  it("keeps at most the newest 200 cases and evicts older ones across unordered or duplicate inputs", () => {
    const total = MAX_REPLAYABLE_RUN_CASES + 15;
    const candidates: ReplayableRunCaseCandidate[] = [];
    for (let i = total; i >= 1; i -= 1) {
      candidates.push(makeCandidate(i));
    }
    // Duplicate replay of the newest receipt should not create a second entry.
    candidates.push(makeCandidate(total));

    const cases = projectReplayableRunCases({ candidates });

    expect(cases).toHaveLength(MAX_REPLAYABLE_RUN_CASES);
    expect(String(cases[0]?.receiptId)).toBe(receiptUuid(total));
    expect(String(cases.at(-1)?.receiptId)).toBe(receiptUuid(16));
  });

  it("never produces cases from Leave no trace threads and does not let excluded threads consume cap slots", () => {
    const candidates: ReplayableRunCaseCandidate[] = [];
    for (let i = 1; i <= MAX_REPLAYABLE_RUN_CASES; i += 1) {
      candidates.push(makeCandidate(i));
    }
    // Add two Leave no trace receipts newer than the 200 normal receipts:
    // one marked at record time, one marked afterwards via untracedThreads.
    const untracedAtRecord = makeCandidate(MAX_REPLAYABLE_RUN_CASES + 1, {
      leavesNoTraceAtRecord: true,
    });
    const markedLater = makeCandidate(MAX_REPLAYABLE_RUN_CASES + 2);
    candidates.push(untracedAtRecord, markedLater);

    const cases = projectReplayableRunCases({
      candidates,
      untracedThreads: [{ mode: markedLater.receipt.mode, threadId: markedLater.receipt.threadId }],
    });

    expect(cases).toHaveLength(MAX_REPLAYABLE_RUN_CASES);
    const ids = new Set(cases.map((entry) => String(entry.receiptId)));
    expect(ids.has(String(untracedAtRecord.receipt.receiptId))).toBe(false);
    expect(ids.has(String(markedLater.receipt.receiptId))).toBe(false);
    // The oldest eligible receipt (1) survived because untraced receipts were excluded before capping.
    expect(ids.has(receiptUuid(1))).toBe(true);
  });

  it("drops purged threads and omits candidates without an initial request", () => {
    const kept = makeCandidate(1);
    const purged = makeCandidate(2);
    const noRequest = makeCandidate(3, { request: "   " });

    const cases = projectReplayableRunCases({
      candidates: [kept, purged, noRequest],
      purgedThreads: [{ mode: purged.receipt.mode, threadId: purged.receipt.threadId }],
    });

    expect(cases.map((entry) => String(entry.receiptId))).toEqual([receiptUuid(1)]);
  });

  it("computes the share of cases whose receipt was all proven, requiring at least one proven item and rejecting mixed, stale, or missing receipts", () => {
    const allProven = makeReceipt({
      index: 1,
      items: [
        { kind: "check", label: "test", command: "bun test", status: "proven", exitCode: 0 },
        {
          kind: "goal-criterion",
          label: "lint",
          command: "bun lint",
          status: "proven",
          exitCode: 0,
        },
      ],
    });
    const mixedClaimed = makeReceipt({
      index: 2,
      items: [
        { kind: "check", label: "test", command: "bun test", status: "proven", exitCode: 0 },
        { kind: "goal-criterion", label: "reads clearly", status: "claimed" },
      ],
    });
    const zeroItems = makeReceipt({ index: 3, items: [] });
    const unavailable = makeReceipt({
      index: 4,
      items: [
        {
          kind: "check",
          label: "test",
          command: "bun test",
          status: "unavailable",
          reason: "No folder.",
        },
      ],
    });

    expect(isFinishedReceiptAllProven(allProven)).toBe(true);
    expect(isFinishedReceiptAllProven(allProven, { stale: true })).toBe(false);
    expect(isFinishedReceiptAllProven(mixedClaimed)).toBe(false);
    expect(isFinishedReceiptAllProven(zeroItems)).toBe(false);
    expect(isFinishedReceiptAllProven(unavailable)).toBe(false);
    expect(isFinishedReceiptAllProven(undefined)).toBe(false);

    const summary = summarizeAllProvenShare([
      { receipt: allProven },
      { receipt: allProven, stale: true },
      { receipt: mixedClaimed },
      { receipt: undefined },
    ]);
    expect(summary).toEqual({
      allProvenCount: 1,
      totalCount: 4,
      share: 0.25,
      formatted: "1/4 (25.0%) all proven",
    });

    expect(summarizeAllProvenShare([])).toEqual({
      allProvenCount: 0,
      totalCount: 0,
      share: undefined,
      formatted: "0/0 (n/a) all proven",
    });
  });
});
