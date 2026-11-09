// Remove worktree on a moved thread's tombstone. A Code thread whose worktree
// held files the move did not carry left that folder beside the managed one
// (`<worktree>-moved-out-<move>`), owned by no thread. Only a person at a
// window here removes it, and only the exact folder its departure recorded:
// the request names a move, never a path. Canonical:
// docs/design/hub-and-spokes.md "Erase on the source".

import { UtcTimestamp, type KeptWorktreeRemoveOutcome } from "@octant/contracts";
import { Schema } from "effect";
import type { KeptWorktreeRecorder } from "./threadMoveJournal";
import type { ThreadMoveStatePort } from "./threadMoveStateStore";

const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export interface KeptWorktreeRemovalOptions {
  readonly state: ThreadMoveStatePort;
  readonly record: KeptWorktreeRecorder;
  /** Removes a linked worktree with everything in it; a folder already gone counts as removed. */
  readonly removeWorktree: (worktree: string) => Promise<"removed" | "not-a-linked-worktree">;
  readonly clock: () => string;
}

export class KeptWorktreeRemoval {
  readonly #options: KeptWorktreeRemovalOptions;
  // One removal per move at a time: a second press while Git is still
  // removing the folder waits for the first rather than racing it.
  readonly #removing = new Map<string, Promise<KeptWorktreeRemoveOutcome>>();

  constructor(options: KeptWorktreeRemovalOptions) {
    this.#options = options;
  }

  remove(moveId: string): Promise<KeptWorktreeRemoveOutcome> {
    const running = this.#removing.get(moveId);
    if (running !== undefined) return running;
    const removal = this.#remove(moveId).finally(() => this.#removing.delete(moveId));
    this.#removing.set(moveId, removal);
    return removal;
  }

  async #remove(moveId: string): Promise<KeptWorktreeRemoveOutcome> {
    const departure = (this.#options.state.load().departures ?? []).findLast(
      (entry) => String(entry.moveId) === moveId,
    );
    const worktree = departure?.keptWorktree;
    if (departure === undefined || worktree === undefined) {
      return { status: "refused", kind: "not-kept-worktree" };
    }
    // Already removed: answered again, and nothing is removed or journaled twice.
    if (departure.keptWorktreeRemovedAt !== undefined) return { status: "removed" };
    const removed = await this.#options.removeWorktree(worktree).catch(() => "failed" as const);
    if (removed !== "removed") return { status: "refused", kind: "remove-failed" };
    this.#options.record.keptWorktreeRemoved({
      moveId: departure.moveId,
      thread: departure.thread,
      worktree,
    });
    const after = this.#options.state.load();
    const removedAt = decodeTimestamp(this.#options.clock());
    this.#options.state.save({
      ...after,
      departures: (after.departures ?? []).map((entry) =>
        String(entry.moveId) === moveId ? { ...entry, keptWorktreeRemovedAt: removedAt } : entry,
      ),
    });
    return { status: "removed" };
  }
}
