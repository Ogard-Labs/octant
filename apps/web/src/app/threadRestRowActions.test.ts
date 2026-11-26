import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellActions } from "./shellActions";
import { threadRestRowActions, type ThreadRestUndoNotice } from "./threadRestRowActions";
import { threadRestUndoStore } from "./threadRestUndoStore";
import { inverseThreadRestChange } from "./threadRestRun";

const CODE_ID = "00000000-0000-4000-8000-0000000000c1";
const WORK_ID = "00000000-0000-4000-8000-0000000000d1";

function shellActions() {
  // The notices the window's Undo store shows, in the order it shows them.
  const offered: ThreadRestUndoNotice[] = [];
  stopWatching = threadRestUndoStore.subscribe(() => {
    const notice = threadRestUndoStore.current();
    if (notice !== undefined) offered.push(notice);
  });
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
    setCodeThreadPin: vi.fn(
      async (): Promise<
        { readonly status: "ok" } | { readonly status: "refused"; readonly message: string }
      > => ({ status: "ok" }),
    ),
    markCodeThreadDone: vi.fn(async () => ({ status: "ok" as const })),
    tryWorkRestCommand: vi.fn<ShellActions["tryWorkRestCommand"]>(async () => ({ status: "ok" })),
    setThreadExportNotice: vi.fn(),
    threadRestRow: vi.fn(
      (): {
        title: string;
        snooze?: { until: string; at: string };
        markedDone?: boolean;
        workDone?: boolean;
      } => ({
        title: "Controller foundation",
      }),
    ),
  };
}

let stopWatching = () => {};
afterEach(() => {
  stopWatching();
  threadRestUndoStore.dismiss();
  vi.useRealTimers();
});

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
    expect(shell.offered).toHaveLength(0);
  });

  it("sends each mode's own inverse, with Work through its versioned command", async () => {
    const shell = shellActions();
    const actions = threadRestRowActions(shell);
    actions.code.onPinThread?.(CODE_ID, true);
    actions.work.onCompleteThread?.(WORK_ID);
    await vi.waitFor(() => expect(shell.offered).toHaveLength(2));
    for (const notice of shell.offered) notice.undo();
    await vi.waitFor(() => expect(shell.tryWorkRestCommand).toHaveBeenCalledTimes(2));
    expect(shell.setCodeThreadPin.mock.calls).toEqual([
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

  it("shows the host's sentence when a pin is refused, and offers no Undo", async () => {
    const shell = shellActions();
    shell.setCodeThreadPin.mockResolvedValueOnce({
      status: "refused",
      message: "This thread changed in another window.",
    });
    threadRestRowActions(shell).code.onPinThread?.(CODE_ID, true);
    await vi.waitFor(() =>
      expect(shell.setThreadExportNotice).toHaveBeenCalledWith(
        "This thread changed in another window.",
      ),
    );
    expect(shell.offered).toHaveLength(0);
  });

  it("marks a reopened Work thread Done again on Undo", async () => {
    const shell = shellActions();
    shell.threadRestRow.mockReturnValue({ title: "Quarterly report", workDone: true });
    threadRestRowActions(shell).work.onReopenThread?.(WORK_ID);
    await vi.waitFor(() => expect(shell.offered).toHaveLength(1));
    shell.offered[0]?.undo();
    await vi.waitFor(() => expect(shell.tryWorkRestCommand).toHaveBeenCalledTimes(2));
    const undo = shell.tryWorkRestCommand.mock.calls[1]?.[1];
    expect(undo?.(7 as never, { title: "Quarterly report" } as never)).toEqual({
      kind: "confirm-work-thread-completion",
      threadId: WORK_ID,
      expectedVersion: 7,
      deliveryTarget: "Quarterly report",
    });
  });

  it("keeps the newer change's Undo when an older change's reply arrives after it", async () => {
    const shell = shellActions();
    let answerFirst: (value: { readonly status: "ok" }) => void = () => {};
    shell.completeCodeThread.mockReturnValueOnce(
      new Promise((resolve) => {
        answerFirst = resolve;
      }),
    );
    const actions = threadRestRowActions(shell);
    actions.code.onCompleteThread?.(CODE_ID);
    actions.code.onPinThread?.(CODE_ID, true);
    await vi.waitFor(() => expect(shell.offered).toHaveLength(1));
    answerFirst({ status: "ok" });
    await vi.waitFor(() => expect(shell.completeCodeThread).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The settle was asked for first, so its later reply does not replace the
    // pin's Undo.
    expect(shell.offered.map((notice) => notice.title)).toEqual(["Pinned"]);
    expect(threadRestUndoStore.current()?.title).toBe("Pinned");
  });
});
