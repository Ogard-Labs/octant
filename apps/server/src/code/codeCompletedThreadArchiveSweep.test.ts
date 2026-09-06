import {
  decodeCodeThread,
  decodeCodeThreadId,
  decodeProjectId,
  decodeUtcTimestamp,
  type CodeThread,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { CodeCompletedThreadArchiveSweep } from "./codeCompletedThreadArchiveSweep";
import type { CodeCompletedThreadArchiveOutcome } from "./codeService";

const now = "2026-09-08T10:00:00.000Z";
const nowMs = Date.parse(now);

function thread(id: string, overrides: Partial<CodeThread> = {}): CodeThread {
  return decodeCodeThread({
    id: decodeCodeThreadId(id),
    projectId: decodeProjectId("00000000-0000-4000-8000-000000002001"),
    bindingRevisionId: "00000000-0000-4000-8000-000000002002",
    repositoryId: `repo_${"a".repeat(64)}`,
    checkoutId: "00000000-0000-4000-8000-000000002003",
    title: "Finished work",
    lifecycle: "active",
    providerInstanceId: "00000000-0000-4000-8000-000000002004",
    modelId: "model-a",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/done",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "main",
      outcomeKind: "opened-pr",
      confirmedAt: now,
    },
    version: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  });
}

const oldEnough = thread("00000000-0000-4000-8000-000000002101", {
  completedAt: decodeUtcTimestamp("2026-09-01T09:00:00.000Z"),
});
const fresh = thread("00000000-0000-4000-8000-000000002102", {
  completedAt: decodeUtcTimestamp("2026-09-07T09:00:00.000Z"),
});
const inPlay = thread("00000000-0000-4000-8000-000000002103");

function fixture(options: {
  readonly threads?: ReadonlyArray<CodeThread>;
  readonly afterDays?: number | null;
  readonly intervalMs?: number;
}) {
  const clock = { nowMs };
  const archive = vi.fn(
    (threadId: CodeThread["id"]): CodeCompletedThreadArchiveOutcome => ({
      status: "archived",
      thread: thread(String(threadId), { lifecycle: "archived" }),
    }),
  );
  const sweep = new CodeCompletedThreadArchiveSweep({
    threads: () => options.threads ?? [oldEnough, fresh, inPlay],
    archiveAfterDays: () => (options.afterDays === undefined ? 7 : options.afterDays),
    archive,
    clock: () => clock.nowMs,
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
  });
  return { sweep, archive, clock };
}

describe("completed thread archive sweep", () => {
  it("archives only completed threads whose completion is older than the window", () => {
    const { sweep, archive } = fixture({});
    expect(sweep.pass()).toEqual({ archived: [oldEnough.id], skipped: [] });
    expect(archive).toHaveBeenCalledTimes(1);
    expect(archive).toHaveBeenCalledWith(oldEnough.id, { afterDays: 7, now });
  });

  it("does nothing when the person turned the timer off", () => {
    const { sweep, archive } = fixture({ afterDays: null });
    expect(sweep.pass()).toEqual({ archived: [], skipped: [] });
    expect(archive).not.toHaveBeenCalled();
  });

  it("reports a thread the host declined to archive as skipped rather than archived", () => {
    const { sweep, archive } = fixture({});
    archive.mockReturnValueOnce({ status: "skipped", reason: "not-due" });
    expect(sweep.pass()).toEqual({ archived: [], skipped: [oldEnough.id] });
  });

  it("runs a pass on start, again each interval, and never after stop", () => {
    vi.useFakeTimers();
    try {
      const { sweep, archive, clock } = fixture({ intervalMs: 1_000 });
      sweep.start();
      expect(archive).toHaveBeenCalledTimes(1);
      clock.nowMs += 1_000;
      vi.advanceTimersByTime(1_000);
      expect(archive).toHaveBeenCalledTimes(2);
      sweep.stop();
      clock.nowMs += 5_000;
      vi.advanceTimersByTime(5_000);
      expect(archive).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a pass that throws and tries again on the next interval", () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const archive = vi.fn(() => ({ status: "skipped" as const, reason: "not-due" as const }));
      const sweep = new CodeCompletedThreadArchiveSweep({
        threads: () => {
          reads += 1;
          if (reads === 1) throw new Error("store busy");
          return [oldEnough];
        },
        archiveAfterDays: () => 7,
        archive,
        clock: () => nowMs,
        intervalMs: 1_000,
      });
      sweep.start();
      expect(archive).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(archive).toHaveBeenCalledTimes(1);
      sweep.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
