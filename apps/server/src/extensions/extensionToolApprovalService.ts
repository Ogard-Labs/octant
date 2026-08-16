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
    },
  ) {
    this.#ttlMs = Math.max(1_000, Math.min(options.ttlMs ?? DEFAULT_APPROVAL_TTL_MS, 10 * 60_000));
  }

  request(input: {
    readonly windowId: WindowId;
    readonly threadId: string;
    readonly projectId?: string;
    readonly packageId: string;
    readonly componentId: string;
    readonly providerToolName: string;
    readonly mcpToolName: string;
    readonly inputJson: string;
    readonly signal?: AbortSignal;
  }): Promise<boolean> {
    if (input.signal?.aborted) return Promise.resolve(false);
    const approvalId = this.options.uuid();
    const view = decodeExtensionToolApproval({
      approvalId,
      threadId: input.threadId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      packageId: input.packageId,
      componentId: input.componentId,
      providerToolName: input.providerToolName,
      mcpToolName: input.mcpToolName,
      inputJson: input.inputJson,
      requestedAt: new Date(this.options.now()).toISOString(),
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
      .filter((pending) => pending.windowId === windowId)
      .map((pending) => pending.view);
  }

  decide(windowId: WindowId, decision: ExtensionToolApprovalDecision): boolean {
    const pending = this.#pending.get(decision.approvalId);
    if (pending === undefined || pending.windowId !== windowId) return false;
    pending.resolve(decision.decision === "approved");
    return true;
  }

  revokeWindow(windowId: WindowId): void {
    for (const pending of this.#pending.values()) {
      if (pending.windowId === windowId) pending.resolve(false);
    }
  }
}
