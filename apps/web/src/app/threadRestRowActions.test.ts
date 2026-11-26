import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inverseThreadRestChange,
  threadRestRowActions,
  type ThreadRestUndoNotice,
} from "./threadRestRowActions";

const CODE_ID = "00000000-0000-4000-8000-0000000000c1";
const WORK_ID = "00000000-0000-4000-8000-0000000000d1";

function shellActions() {
  const offered: ThreadRestUndoNotice[] = [];
  return {
    offered,
    completeChatThread: vi.fn(async () => ({ status: "ok" as const })),
    reopenChatThread: vi.fn(async () => ({ status: "ok" as const })),
    snoozeChatThread: vi.fn(async () => ({ status: "ok" as const })),
    wakeChatThread: vi.fn(async () => ({ status: "ok" as const })),
    completeCodeThread: vi.fn(
      async (): Promise<
        { readonly status: "ok" } | { readonly status: "refused"; readonly message: string }
      > => ({ status: "ok" }),
    ),
    reopenCodeThread: vi.fn(
      async (): Promise<
        { readonly status: "ok" } | { readonly status: "refused"; readonly message: string }
      > => ({ status: "ok" }),
    ),
    snoozeCodeThread: vi.fn(async () => ({ status: "ok" as const })),
    wakeCodeThread: vi.fn(async () => ({ status: "ok" as const })),
    pinCodeThread: vi.fn(async () => true),
    markCodeThreadDone: vi.fn(async () => ({ status: "ok" as const })),
    tryWorkRestCommand: vi.fn(async () => ({ status: "ok" as const })),
    setThreadExportNotice: vi.fn(),
    offerThreadRestUndo: vi.fn((notice: ThreadRestUndoNotice) => {
      offered.push(notice);
    }),
    threadRestRow: vi.fn(
      (): { title: string; snooze?: { until: string; at: string }; markedDone?: boolean } => ({
        title: "Controller foundation",
      }),
    ),
  };
}

afterEach(() => vi.useRealTimers());

describe("Undo after a sidebar state change", () => {
  it("Undo within five seconds sends the inverse command and shows a refusal", async () => {
    const shell = shellActions();
    threadRestRowActions(shell).code.onCompleteThread?.(CODE_ID);
    await vi.waitFor(() => expect(shell.offered).toHaveLength(1));
    expect(shell.offered[0]).toMatchObject({ title: "Settled", detail: "Controller foundation" });

    shell.reopenCodeThread.mockResolvedValueOnce({
      status: "refused",
      message: "This thread is waiting on you.",
    });
    shell.offered[0]?.undo();
    await vi.waitFor(() =>
      expect(shell.setThreadExportNotice).toHaveBeenCalledWith("This thread is waiting on you."),
    );
    expect(shell.reopenCodeThread).toHaveBeenCalledWith(CODE_ID);
    // An Undo is itself a person's command, not a change that offers another Undo.
    expect(shell.offered).toHaveLength(1);
  });

  it("offers no Undo for a change the host refused", async () => {
    const shell = shellActions();
    shell.completeCodeThread.mockResolvedValueOnce({ status: "refused", message: "Not done." });
    threadRestRowActions(shell).code.onCompleteThread?.(CODE_ID);
    await vi.waitFor(() => expect(shell.setThreadExportNotice).toHaveBeenCalledWith("Not done."));
    expect(shell.offerThreadRestUndo).not.toHaveBeenCalled();
  });

  it("sends each mode's own inverse, with Work through its versioned command", async () => {
    const shell = shellActions();
    const actions = threadRestRowActions(shell);
    actions.code.onPinThread?.(CODE_ID, true);
    actions.work.onCompleteThread?.(WORK_ID);
    await vi.waitFor(() => expect(shell.offered).toHaveLength(2));
    for (const notice of shell.offered) notice.undo();
    await vi.waitFor(() => expect(shell.tryWorkRestCommand).toHaveBeenCalledTimes(2));
    expect(shell.pinCodeThread.mock.calls).toEqual([
      [CODE_ID, true],
      [CODE_ID, false],
    ]);
    const built = (shell.tryWorkRestCommand.mock.calls as unknown[][]).map(
      (call) => (call[1] as (version: number) => { kind: string })(3).kind,
    );
    expect(built).toEqual(["complete-work-thread", "reopen-work-thread"]);
  });

  it("re-snoozes a woken thread only while its old wake time is still ahead", () => {
    const now = new Date("2026-11-26T10:00:00.000Z");
    const asleep = { title: "T", snooze: { until: "2026-11-26T12:00:00.000Z", at: "x" } };
    expect(inverseThreadRestChange({ kind: "wake" }, asleep, now)).toEqual({
      kind: "snooze",
      until: "2026-11-26T12:00:00.000Z",
    });
    const passed = { title: "T", snooze: { until: "2026-11-26T09:00:00.000Z", at: "x" } };
    expect(inverseThreadRestChange({ kind: "wake" }, passed, now).kind).toBe("none");
  });

  it("marks a reopened thread Done again when it was marked Done", () => {
    const now = new Date();
    expect(
      inverseThreadRestChange({ kind: "reopen" }, { title: "T", markedDone: true }, now),
    ).toEqual({ kind: "mark-done" });
    expect(inverseThreadRestChange({ kind: "reopen" }, { title: "T" }, now)).toEqual({
      kind: "settle",
    });
    expect(inverseThreadRestChange({ kind: "mark-done" }, undefined, now)).toEqual({
      kind: "reopen",
    });
  });
});
