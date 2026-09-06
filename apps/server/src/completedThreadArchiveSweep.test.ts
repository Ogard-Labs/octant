import { describe, expect, it, vi } from "vitest";
import {
  CompletedThreadArchiveSweep,
  type CompletedThreadArchiveOutcome,
  type CompletedThreadArchiveSource,
} from "./completedThreadArchiveSweep";

const now = "2026-09-08T10:00:00.000Z";
const nowMs = Date.parse(now);

const oldEnough = {
  id: "code-old",
  lifecycle: "active" as const,
  completedAt: "2026-09-01T09:00:00.000Z",
};
const fresh = {
  id: "code-fresh",
  lifecycle: "active" as const,
  completedAt: "2026-09-07T09:00:00.000Z",
};
const inPlay = { id: "code-in-play", lifecycle: "active" as const };
const chatOldEnough = {
  id: "chat-old",
  lifecycle: "active" as const,
  completedAt: "2026-08-20T09:00:00.000Z",
};

function fixture(options: {
  readonly afterDays?: number | null;
  readonly intervalMs?: number;
  readonly sources?: ReadonlyArray<CompletedThreadArchiveSource>;
}) {
  const clock = { nowMs };
  const archive = vi.fn((): CompletedThreadArchiveOutcome => ({ status: "archived" }));
  const sweep = new CompletedThreadArchiveSweep({
    sources: options.sources ?? [
      { mode: "code", threads: () => [oldEnough, fresh, inPlay], archive },
      { mode: "chat", threads: () => [chatOldEnough], archive },
    ],
    archiveAfterDays: () => (options.afterDays === undefined ? 7 : options.afterDays),
    clock: () => clock.nowMs,
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
  });
  return { sweep, archive, clock };
}

describe("completed thread archive sweep", () => {
  it("archives only completed threads whose completion is older than the window, in every mode", () => {
    const { sweep, archive } = fixture({});
    expect(sweep.pass()).toEqual({
      archived: [
        { mode: "code", threadId: oldEnough.id },
        { mode: "chat", threadId: chatOldEnough.id },
      ],
      skipped: [],
    });
    expect(archive).toHaveBeenCalledTimes(2);
    expect(archive).toHaveBeenCalledWith(oldEnough.id, { afterDays: 7, now });
    expect(archive).toHaveBeenCalledWith(chatOldEnough.id, { afterDays: 7, now });
  });

  it("does nothing when the person turned the timer off", () => {
    const { sweep, archive } = fixture({ afterDays: null });
    expect(sweep.pass()).toEqual({ archived: [], skipped: [] });
    expect(archive).not.toHaveBeenCalled();
  });

  it("reports a thread the host declined to archive as skipped rather than archived", () => {
    const { sweep, archive } = fixture({});
    archive.mockReturnValueOnce({ status: "skipped", reason: "not-due" });
    expect(sweep.pass()).toEqual({
      archived: [{ mode: "chat", threadId: chatOldEnough.id }],
      skipped: [{ mode: "code", threadId: oldEnough.id }],
    });
  });

  it("runs a pass on start, again each interval, and never after stop", () => {
    vi.useFakeTimers();
    try {
      const { sweep, archive, clock } = fixture({ intervalMs: 1_000 });
      sweep.start();
      expect(archive).toHaveBeenCalledTimes(2);
      clock.nowMs += 1_000;
      vi.advanceTimersByTime(1_000);
      expect(archive).toHaveBeenCalledTimes(4);
      sweep.stop();
      clock.nowMs += 5_000;
      vi.advanceTimersByTime(5_000);
      expect(archive).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a pass that throws and tries again on the next interval", () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const archive = vi.fn(
        (): CompletedThreadArchiveOutcome => ({
          status: "skipped",
          reason: "not-due",
        }),
      );
      const sweep = new CompletedThreadArchiveSweep({
        sources: [
          {
            mode: "code",
            threads: () => {
              reads += 1;
              if (reads === 1) throw new Error("store busy");
              return [oldEnough];
            },
            archive,
          },
        ],
        archiveAfterDays: () => 7,
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
