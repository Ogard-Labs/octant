import { LOCAL_HOST_ID } from "@octant/contracts/host";
import type { ActiveWorkRow } from "@octant/contracts/active-work";

/** The choices this window's sidebar already makes for a thread, here and on a paired computer. */
export interface ActiveWorkOpeners {
  readonly selectChatThread: (threadId: string) => void;
  readonly selectWorkThread: (threadId: string) => void;
  readonly selectCodeThread: (threadId: string) => void;
  readonly openPairedComputerThread: (hostId: string, threadId: string) => void;
}

/**
 * A thread on a paired computer opens in that computer's Code start screen,
 * which cannot show a Work or Chat thread.
 */
export function canOpenActiveWork(
  host: { readonly hostId: string },
  row: Pick<ActiveWorkRow, "mode">,
): boolean {
  return host.hostId === String(LOCAL_HOST_ID) || row.mode === "code";
}

/** Opens a row as its sidebar row would; a subagent opens the thread it works for. */
export function openActiveWork(
  openers: ActiveWorkOpeners,
  host: { readonly hostId: string },
  row: Pick<ActiveWorkRow, "mode" | "threadId">,
): void {
  if (!canOpenActiveWork(host, row)) return;
  if (host.hostId !== String(LOCAL_HOST_ID)) {
    openers.openPairedComputerThread(host.hostId, row.threadId);
    return;
  }
  switch (row.mode) {
    case "chat":
      return openers.selectChatThread(row.threadId);
    case "work":
      return openers.selectWorkThread(row.threadId);
    case "code":
      return openers.selectCodeThread(row.threadId);
  }
}
