import type { ApprovalOutsideContent, WindowId } from "@octant/contracts";
import {
  decodeExtensionToolApproval,
  type ExtensionToolApproval,
  type ExtensionToolApprovalDecision,
} from "@octant/contracts/extension-rpc";

const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000;

/**
 * Waiting MCP tool prompts. Each one keeps the call's input text until it is
 * answered, aborted, or times out, so a turn that calls tools in a loop would
 * otherwise stack them without bound. The cap is host-wide: every thread and
 * window shares this one waiting set, as the browser tool-approval service's
 * cap of 32 already does, so one busy thread can use slots another thread
 * would otherwise get. A call past it is denied at once and is not stored.
 */
export const MAX_PENDING_APPROVALS = 32;

/**
 * Who is answering: a person at a local window, or a paired device, each by
 * the service scope its authenticated principal resolved to.
 */
export interface ExtensionToolApprovalAnswerer {
  readonly kind: "local-window" | "remote-device";
  readonly scopeId: WindowId;
}

interface PendingApproval {
  readonly view: ExtensionToolApproval;
  readonly windowId: WindowId;
  readonly expiresAt: number;
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
      /**
       * Whether a requesting scope is a paired device that is still paired.
       * Its turn's prompt may also be answered by a local window that may
       * drive the thread, since the person may be at either.
       */
      readonly isPairedDeviceScope?: (windowId: WindowId) => boolean;
      /**
       * Whether the thread still stands under the Project the prompt
       * recorded: the thread and its Project are active and the thread is
       * still bound there. A paired device answers only while this holds.
       */
      readonly threadAuthorityIsCurrent?: (
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
    /** The sources that marked the thread, read by the host when it asks. */
    readonly outsideContent?: ApprovalOutsideContent;
    /**
     * Records "always allow in this Project" for this tool and says whether it
     * was recorded. Absent when this call can only be approved once; the
     * prompt then offers no such answer and one sent anyway is refused.
     */
    readonly remember?: () => boolean;
    readonly signal?: AbortSignal;
  }): Promise<boolean> {
    if (input.signal?.aborted) return Promise.resolve(false);
    this.#expire();
    if (this.#pending.size >= MAX_PENDING_APPROVALS) return Promise.resolve(false);
    const approvalId = this.options.uuid();
    const requestedAt = this.options.now();
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
      requestedAt: new Date(requestedAt).toISOString(),
      rememberable: input.remember !== undefined,
      ...(input.outsideContent === undefined ? {} : { outsideContent: input.outsideContent }),
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
        expiresAt: requestedAt + this.#ttlMs,
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

  list(answerer: ExtensionToolApprovalAnswerer): ReadonlyArray<ExtensionToolApproval> {
    this.#expire();
    return [...this.#pending.values()]
      .filter((pending) => this.#answerableBy(pending, answerer))
      .map((pending) => pending.view);
  }

  decide(
    answerer: ExtensionToolApprovalAnswerer,
    decision: ExtensionToolApprovalDecision,
  ): boolean {
    this.#expire();
    const pending = this.#pending.get(decision.approvalId);
    if (pending === undefined || !this.#answerableBy(pending, answerer)) return false;
    if (decision.remember === true) {
      // A remembered approval grows only from a person's answer at the local
      // window whose own turn raised the prompt, and only to a prompt that
      // offered it: one a host-owned or a paired device's turn raised arrives
      // with no `remember`, whoever answers. The host's own scope is nobody,
      // so it may settle its prompt but never remember one, and a paired
      // device approves once only. A refused or failed `remember` leaves the
      // call waiting, to be approved once.
      if (
        decision.decision !== "approved" ||
        pending.remember === undefined ||
        answerer.kind !== "local-window" ||
        String(pending.windowId) !== String(answerer.scopeId) ||
        this.options.isHostScope?.(answerer.scopeId) === true ||
        !pending.remember()
      ) {
        return false;
      }
    }
    pending.resolve(decision.decision === "approved");
    return true;
  }

  /**
   * A local window answers its own prompts. A host-owned turn's prompt has no
   * window of its own, and a paired device's turn may be answered from the
   * machine as well as from the device, so any local window that may drive
   * that thread answers either; the answer settles only this prompt and lends
   * the window nothing else of the other scope.
   *
   * A paired device answers only the prompts its own turns raised, and only
   * while their thread still stands in the recorded Project. It never answers
   * a local window's, another device's, or the host's prompt.
   */
  #answerableBy(pending: PendingApproval, answerer: ExtensionToolApprovalAnswerer): boolean {
    const { isHostScope, isPairedDeviceScope, threadAuthorityIsCurrent, windowCanReachThread } =
      this.options;
    if (answerer.kind === "remote-device") {
      return (
        String(pending.windowId) === String(answerer.scopeId) &&
        threadAuthorityIsCurrent !== undefined &&
        threadAuthorityIsCurrent(pending.view.threadId, pending.view.projectId)
      );
    }
    if (String(pending.windowId) === String(answerer.scopeId)) return true;
    if (windowCanReachThread === undefined || isHostScope?.(answerer.scopeId) === true) {
      return false;
    }
    const raisedByHost = isHostScope?.(pending.windowId) === true;
    const raisedByPairedDevice = isPairedDeviceScope?.(pending.windowId) === true;
    if (!raisedByHost && !raisedByPairedDevice) return false;
    return windowCanReachThread(answerer.scopeId, pending.view.threadId, pending.view.projectId);
  }

  revokeWindow(windowId: WindowId): void {
    for (const pending of this.#pending.values()) {
      if (pending.windowId === windowId) pending.resolve(false);
    }
  }

  /**
   * Denies every prompt whose time is up by the clock, the way the browser
   * tool-approval service does. The timer alone is not enough: it fires late
   * behind a busy event loop or across a machine's sleep, and until it fires
   * an overdue prompt would still be listed, could still be approved, and
   * would hold a waiting slot.
   */
  #expire(): void {
    const now = this.options.now();
    for (const pending of this.#pending.values()) {
      if (pending.expiresAt <= now) pending.resolve(false);
    }
  }
}
