import type { WindowId } from "@octant/contracts";
import {
  decodeExtensionToolApproval,
  type ExtensionToolApproval,
  type ExtensionToolApprovalDecision,
} from "@octant/contracts/extension-rpc";

const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000;

interface PendingApproval {
  readonly view: ExtensionToolApproval;
  readonly windowId: WindowId;
  readonly remember?: () => boolean;
  readonly resolve: (approved: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

export class ExtensionToolApprovalService {
  readonly #pending = new Map<string, PendingApproval>();
  readonly #ttlMs: number;

  constructor(
    private readonly options: {
      readonly uuid: () => string;
      readonly now: () => number;
      readonly ttlMs?: number;
      /**
       * Whether a requesting scope is the host acting on its own (a routine,
       * a usage-limit resume). Nobody sits at that scope, so its approvals go
       * to the windows that can see the thread.
       */
      readonly isHostScope?: (windowId: WindowId) => boolean;
      /**
       * Whether a local window may drive this thread in the Project the
       * prompt recorded, by that window's Project binding.
       */
      readonly windowCanReachThread?: (
        windowId: WindowId,
        threadId: string,
        projectId: string | undefined,
      ) => boolean;
    },
  ) {
    this.#ttlMs = Math.max(1_000, Math.min(options.ttlMs ?? DEFAULT_APPROVAL_TTL_MS, 10 * 60_000));
  }

  request(input: {
    readonly windowId: WindowId;
    readonly threadId: string;
    readonly projectId?: string;
    readonly extensionId: string;
    readonly packageId: string;
    readonly componentId: string;
    readonly serverName: string;
    readonly providerToolName: string;
    readonly mcpToolName: string;
    readonly inputJson: string;
    /**
     * Records "always allow in this Project" for this tool and says whether it
     * was recorded. Absent when this call can only be approved once; the
     * prompt then offers no such answer and one sent anyway is refused.
     */
    readonly remember?: () => boolean;
    readonly signal?: AbortSignal;
  }): Promise<boolean> {
    if (input.signal?.aborted) return Promise.resolve(false);
    const approvalId = this.options.uuid();
    const view = decodeExtensionToolApproval({
      approvalId,
      threadId: input.threadId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      extensionId: input.extensionId,
      packageId: input.packageId,
      componentId: input.componentId,
      serverName: input.serverName,
      providerToolName: input.providerToolName,
      mcpToolName: input.mcpToolName,
      inputJson: input.inputJson,
      requestedAt: new Date(this.options.now()).toISOString(),
      rememberable: input.remember !== undefined,
    });
    return new Promise<boolean>((resolve) => {
      const settle = (approved: boolean) => {
        const current = this.#pending.get(approvalId);
        if (current === undefined) return;
        this.#pending.delete(approvalId);
        clearTimeout(current.timer);
        if (current.signal !== undefined && current.onAbort !== undefined) {
          current.signal.removeEventListener("abort", current.onAbort);
        }
        resolve(approved);
      };
      const timer = setTimeout(() => settle(false), this.#ttlMs);
      timer.unref?.();
      const onAbort = input.signal === undefined ? undefined : () => settle(false);
      this.#pending.set(approvalId, {
        view,
        windowId: input.windowId,
        ...(input.remember === undefined ? {} : { remember: input.remember }),
        resolve: settle,
        timer,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(onAbort === undefined ? {} : { onAbort }),
      });
      input.signal?.addEventListener("abort", onAbort!, { once: true });
      if (input.signal?.aborted) settle(false);
    });
  }

  list(windowId: WindowId): ReadonlyArray<ExtensionToolApproval> {
    return [...this.#pending.values()]
      .filter((pending) => this.#answerableBy(pending, windowId))
      .map((pending) => pending.view);
  }

  decide(windowId: WindowId, decision: ExtensionToolApprovalDecision): boolean {
    const pending = this.#pending.get(decision.approvalId);
    if (pending === undefined || !this.#answerableBy(pending, windowId)) return false;
    if (decision.remember === true) {
      // A remembered approval grows only from a person's answer at a window,
      // to a prompt that offered it: one a host-owned turn raised arrives
      // with no `remember`, whoever answers. The host's own scope is nobody,
      // so it may settle its prompt but never remember one. A refused or
      // failed `remember` leaves the call waiting, to be approved once.
      if (
        decision.decision !== "approved" ||
        pending.remember === undefined ||
        this.options.isHostScope?.(windowId) === true ||
        !pending.remember()
      ) {
        return false;
      }
    }
    pending.resolve(decision.decision === "approved");
    return true;
  }

  /**
   * A window answers its own prompts. A host-owned turn's prompt has no
   * window of its own, so any window that may drive that thread answers it;
   * the answer settles only this prompt and lends the window nothing else of
   * the host scope.
   */
  #answerableBy(pending: PendingApproval, windowId: WindowId): boolean {
    if (pending.windowId === windowId) return true;
    const { isHostScope, windowCanReachThread } = this.options;
    if (
      isHostScope === undefined ||
      windowCanReachThread === undefined ||
      !isHostScope(pending.windowId) ||
      isHostScope(windowId)
    ) {
      return false;
    }
    return windowCanReachThread(windowId, pending.view.threadId, pending.view.projectId);
  }

  revokeWindow(windowId: WindowId): void {
    for (const pending of this.#pending.values()) {
      if (pending.windowId === windowId) pending.resolve(false);
    }
  }
}
