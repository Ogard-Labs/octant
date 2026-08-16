import { decodeCodeThread, type CodeThread, type WindowId } from "@octant/contracts";

export class CodeSessionAuthorityStore {
  readonly #threadsByWindow = new Map<WindowId, Set<string>>();

  grantFullAccess(windowId: WindowId, threadId: CodeThread["id"]): void {
    const threads = this.#threadsByWindow.get(windowId) ?? new Set<string>();
    threads.add(threadId);
    this.#threadsByWindow.set(windowId, threads);
  }

  revokeThread(windowId: WindowId, threadId: CodeThread["id"]): void {
    const threads = this.#threadsByWindow.get(windowId);
    threads?.delete(threadId);
    if (threads?.size === 0) this.#threadsByWindow.delete(windowId);
  }

  revokeWindow(windowId: WindowId): void {
    this.#threadsByWindow.delete(windowId);
  }

  effectiveThread(windowId: WindowId, thread: CodeThread): CodeThread {
    return this.#threadsByWindow.get(windowId)?.has(thread.id) === true
      ? decodeCodeThread({ ...thread, executionPolicy: "full-access" })
      : thread;
  }
}
