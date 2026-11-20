import { describe, expect, it } from "vitest";
import {
  MAX_REPLAYABLE_RUN_CASES,
  decodeReplayableRunCase,
  decodeReplayableRunCases,
} from "./replayableRunCases";

const RECEIPT_ID = "11111111-1111-4111-8111-111111111111";
const THREAD_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const PROVIDER_ID = "44444444-4444-4444-8444-444444444444";
const RECORDED_AT = "2026-11-19T12:00:00.000Z";

function sampleCase(receiptId = RECEIPT_ID) {
  return {
    receiptId,
    threadId: THREAD_ID,
    mode: "code" as const,
    request: "Fix the parser edge case and run unit tests.",
    project: { id: PROJECT_ID, name: "Octant" },
    model: { providerInstanceId: PROVIDER_ID, modelId: "claude-sonnet-4-5" },
    receipt: {
      receiptId,
      threadId: THREAD_ID,
      mode: "code" as const,
      projectId: PROJECT_ID,
      turnId: "turn-1",
      summary: "Fixed the parser edge case and verified unit tests.",
      items: [
        {
          kind: "check" as const,
          label: "bun run test parser",
          command: "bun run test parser",
          status: "proven" as const,
          exitCode: 0,
        },
      ],
      diff: {
        status: "observed" as const,
        changedFiles: 2,
        insertions: 18,
        deletions: 4,
      },
      recordedAt: RECORDED_AT,
    },
    changedFileCount: 2,
    recordedAt: RECORDED_AT,
  };
}

describe("replayable run case contracts", () => {
  it("round-trips a replayable run case with request, Project, mode, model, receipt, and changed-file count", () => {
    const decoded = decodeReplayableRunCase(sampleCase());
    expect(decoded.mode).toBe("code");
    expect(decoded.project).toEqual({ id: PROJECT_ID, name: "Octant" });
    expect(decoded.model).toEqual({
      providerInstanceId: PROVIDER_ID,
      modelId: "claude-sonnet-4-5",
    });
    expect(decoded.changedFileCount).toBe(2);
    expect(MAX_REPLAYABLE_RUN_CASES).toBe(200);
  });

  it("refuses blank requests, negative changed-file counts, and collections past the 200-case ceiling", () => {
    expect(() => decodeReplayableRunCase({ ...sampleCase(), request: "   " })).toThrow();
    expect(() => decodeReplayableRunCase({ ...sampleCase(), changedFileCount: -1 })).toThrow();
    const tooMany = Array.from({ length: MAX_REPLAYABLE_RUN_CASES + 1 }, (_, index) =>
      sampleCase(`11111111-1111-4111-8111-${String(index).padStart(12, "0")}`),
    );
    expect(() => decodeReplayableRunCases(tooMany)).toThrow();
  });
});
