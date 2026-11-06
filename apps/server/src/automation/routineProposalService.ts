import {
  decodeRoutineChangeRequest,
  decodeRoutineProposal,
  decodeRoutineProposalId,
  type AutomationId,
  type RoutineAgentRequest,
  type RoutineChangeRequest,
  type RoutineProposal,
  type RoutineProposalId,
  type WindowId,
} from "@octant/contracts";

const DEFAULT_TTL_MS = 10 * 60_000;

/**
 * Host-wide cap on waiting proposals and change requests together, as the
 * tool-approval services cap theirs. One past it is refused at once and never
 * shown.
 */
export const MAX_PENDING_ROUTINE_PROPOSALS = 32;

/**
 * What the asking tool call learns. Only `confirmed` means something changed:
 * for a proposal the routine exists, for a change request it is paused or
 * archived.
 */
export type RoutineProposalOutcome =
  | { readonly status: "confirmed"; readonly automationId: AutomationId }
  | { readonly status: "declined" }
  | { readonly status: "expired" }
  | { readonly status: "cancelled" }
  /** The person confirmed, and the host's command refused it; nothing changed. */
  | { readonly status: "not-created"; readonly message: string }
  | { readonly status: "too-many-waiting" };

export interface RoutineProposalServiceOptions {
  readonly uuid: () => string;
  readonly now: () => number;
  readonly ttlMs?: number;
  /** The waiting set changed. Wired at composition to the change feed. */
  readonly onChanged?: () => void;
}

interface PendingProposal {
  readonly view: RoutineAgentRequest;
  readonly windowId: WindowId;
  readonly settle: (outcome: RoutineProposalOutcome) => void;
}

/**
 * What a thread's agent asked the person about routines, held until the
 * person answers: a routine it proposed, or a pause or archive of one it may
 * ask about. A request changes nothing: it waits here, visible only to the
 * window whose turn raised it, until that window confirms or declines it, the
 * turn stops, the window goes away, or ten minutes pass. Only a confirm
 * reaches the Automation command path, as the confirming window, and that
 * path, not this service, decides whether anything changes.
 */
export class RoutineProposalService {
  readonly #pending = new Map<string, PendingProposal>();
  readonly #ttlMs: number;
  readonly #options: RoutineProposalServiceOptions;

  constructor(options: RoutineProposalServiceOptions) {
    this.#options = options;
    this.#ttlMs = Math.max(1_000, Math.min(options.ttlMs ?? DEFAULT_TTL_MS, DEFAULT_TTL_MS));
  }

  propose(input: {
    readonly windowId: WindowId;
    readonly proposal: Omit<RoutineProposal, "proposalId" | "requestedAt">;
    readonly signal?: AbortSignal;
  }): Promise<RoutineProposalOutcome> {
    return this.#hold(input.windowId, input.signal, (stamp) =>
      decodeRoutineProposal({ ...input.proposal, ...stamp }),
    );
  }

  /** Ask the person to pause or archive one routine; nothing changes until they confirm. */
  requestChange(input: {
    readonly windowId: WindowId;
    readonly request: Omit<RoutineChangeRequest, "kind" | "proposalId" | "requestedAt">;
    readonly signal?: AbortSignal;
  }): Promise<RoutineProposalOutcome> {
    return this.#hold(input.windowId, input.signal, (stamp) =>
      decodeRoutineChangeRequest({ ...input.request, kind: "routine-change-request", ...stamp }),
    );
  }

  #hold(
    windowId: WindowId,
    signal: AbortSignal | undefined,
    build: (stamp: {
      readonly proposalId: RoutineProposalId;
      readonly requestedAt: string;
    }) => RoutineAgentRequest,
  ): Promise<RoutineProposalOutcome> {
    if (signal?.aborted) return Promise.resolve({ status: "cancelled" });
    if (this.#pending.size >= MAX_PENDING_ROUTINE_PROPOSALS) {
      return Promise.resolve({ status: "too-many-waiting" });
    }
    const view = build({
      proposalId: decodeRoutineProposalId(this.#options.uuid()),
      requestedAt: new Date(this.#options.now()).toISOString(),
    });
    const key = String(view.proposalId);
    return new Promise((resolve) => {
      const onAbort = () => settle({ status: "cancelled" });
      const timer = setTimeout(() => settle({ status: "expired" }), this.#ttlMs);
      timer.unref?.();
      let settled = false;
      const settle = (outcome: RoutineProposalOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (this.#pending.delete(key)) this.#options.onChanged?.();
        resolve(outcome);
      };
      this.#pending.set(key, { view, windowId, settle });
      this.#options.onChanged?.();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** The proposals and change requests this window may answer, oldest first. */
  list(windowId: WindowId): ReadonlyArray<RoutineAgentRequest> {
    return [...this.#pending.values()]
      .filter((pending) => String(pending.windowId) === String(windowId))
      .map((pending) => pending.view);
  }

  /**
   * Take one waiting request out of the list so exactly one answer acts on
   * it. The caller settles it with what happened; a second claim, from a
   * retry or another tab of the same window, finds nothing.
   */
  claim(
    windowId: WindowId,
    proposalId: RoutineProposalId,
  ):
    | {
        readonly proposal: RoutineAgentRequest;
        readonly settle: (outcome: RoutineProposalOutcome) => void;
      }
    | undefined {
    const key = String(proposalId);
    const pending = this.#pending.get(key);
    if (pending === undefined || String(pending.windowId) !== String(windowId)) return undefined;
    this.#pending.delete(key);
    this.#options.onChanged?.();
    return { proposal: pending.view, settle: pending.settle };
  }

  revokeWindow(windowId: WindowId): void {
    for (const pending of this.#pending.values()) {
      if (String(pending.windowId) === String(windowId)) pending.settle({ status: "cancelled" });
    }
  }

  close(): void {
    for (const pending of this.#pending.values()) pending.settle({ status: "cancelled" });
  }
}
