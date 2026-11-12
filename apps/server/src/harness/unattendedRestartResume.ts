import type { OctantMode } from "@octant/contracts";
import { resumesRecoveryUnattended } from "@octant/domain";
import type { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";

export interface UnattendedRestartResumeDependencies {
  /** "Resume interrupted turns after a restart", read when a thread is judged. */
  readonly settingOn: () => boolean;
  readonly sessions: Pick<
    NativeHarnessSessionStore,
    "read" | "recoveryStanding" | "resumedUnattended" | "resume" | "threadsNeedingRecovery"
  >;
  /**
   * A window on this host that is live now and may read and steer the thread.
   * The continuation waits under its authority, as it would under the window
   * a person clicked Resume in; with none back yet the thread keeps waiting.
   */
  readonly windowFor: (threadId: string) => Promise<string | undefined>;
  readonly recoveryBlockers: (input: {
    readonly threadId: string;
  }) => Promise<ReadonlyArray<string>>;
  readonly settleInterruptedTurns: (input: {
    readonly threadId: string;
    readonly mode: OctantMode;
  }) => void;
  readonly continueRecovery: (input: {
    readonly threadId: string;
    readonly windowId: string;
    readonly mode: OctantMode;
  }) => Promise<
    { readonly kind: "queued" } | { readonly kind: "refused"; readonly message: string }
  >;
}

/**
 * Resumes, with nobody there, the sessions a host restart left needing
 * recovery, when the setting allows it and the journal shows nothing was
 * running. It takes the steps a person's Resume takes, in the same order, and
 * queues the same continuation: a new prompt, never a replayed tool call or
 * provider turn.
 *
 * Only the threads that needed recovery when the host started are judged, and
 * each at most once: a refusal, a blocker, or a decision to wait leaves the
 * thread to the person and is not retried. A resume is journaled as
 * unattended, so a restart that finds its work unfinished waits too.
 */
export class UnattendedRestartResume {
  readonly #deps: UnattendedRestartResumeDependencies;
  readonly #pending: Set<string>;
  #pass: Promise<void> | undefined;

  constructor(deps: UnattendedRestartResumeDependencies) {
    this.#deps = deps;
    this.#pending = new Set(deps.sessions.threadsNeedingRecovery());
  }

  /** Whether any thread is still waiting for a window to come back. */
  get pending(): boolean {
    return this.#pending.size > 0;
  }

  /** One pass over the threads still pending. Overlapping calls share it. */
  pass(): Promise<void> {
    if (this.#pending.size === 0) return Promise.resolve();
    this.#pass ??= this.#run().finally(() => {
      this.#pass = undefined;
    });
    return this.#pass;
  }

  async #run(): Promise<void> {
    for (const threadId of this.#pending) {
      try {
        if ((await this.#judge(threadId)) !== "window-absent") this.#pending.delete(threadId);
      } catch {
        // A thread that cannot be judged waits for a person like any other.
        this.#pending.delete(threadId);
      }
    }
  }

  async #judge(threadId: string): Promise<"settled" | "window-absent"> {
    const { sessions } = this.#deps;
    const standing = sessions.recoveryStanding(threadId);
    const mode = sessions.read(threadId)?.session.mode;
    if (standing === undefined || mode === undefined) return "settled";
    const decision = resumesRecoveryUnattended({
      settingOn: this.#deps.settingOn(),
      standing,
      resumedUnattendedBefore: sessions.resumedUnattended(threadId),
    });
    if (decision.kind === "wait") return "settled";
    const windowId = await this.#deps.windowFor(threadId);
    if (windowId === undefined) return "window-absent";
    if ((await this.#deps.recoveryBlockers({ threadId })).length > 0) return "settled";
    // A person may have resumed, or a turn started, while this pass waited.
    if (sessions.recoveryStanding(threadId) !== "answer-dropped") return "settled";
    this.#deps.settleInterruptedTurns({ threadId, mode });
    const continuation = await this.#deps.continueRecovery({ threadId, windowId, mode });
    if (continuation.kind !== "queued") return "settled";
    if (sessions.recoveryStanding(threadId) === "answer-dropped")
      sessions.resume(threadId, { unattended: true });
    return "settled";
  }
}
