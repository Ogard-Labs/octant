import {
  decodeMemoryEntryId,
  decodeProjectMemoryProposal,
  decodeProjectMemoryProposalId,
  type AgentAuthoredMemoryProvenance,
  type MemoryCommandResult,
  type MemoryEntryId,
  type ProjectMemoryProposal,
  type ProjectMemoryProposalDecision,
  type ProjectMemoryProposalDecisionResult,
  type WindowId,
} from "@octant/contracts";
import type { AgentMemoryCommand } from "../projectService";

const DEFAULT_TTL_MS = 10 * 60_000;

/**
 * Host-wide cap on waiting memory proposals, as the tool-approval services cap
 * theirs. One past it is refused at once and never shown.
 */
export const MAX_PENDING_PROJECT_MEMORY_PROPOSALS = 32;

/** What the asking tool call learns. Only `confirmed` means memory changed. */
export type ProjectMemoryProposalOutcome =
  | { readonly status: "confirmed"; readonly result: MemoryCommandResult }
  | { readonly status: "declined" }
  | { readonly status: "expired" }
  | { readonly status: "cancelled" }
  /** The person confirmed, and the memory command refused it; nothing changed. */
  | { readonly status: "not-applied"; readonly message: string }
  | { readonly status: "too-many-waiting" };

export interface ProjectMemoryProposalServiceOptions {
  readonly uuid: () => string;
  readonly now: () => number;
  readonly ttlMs?: number;
  /**
   * Applies a confirmed change through Project memory's own command path,
   * which keeps its archived-Project, mode, and version checks. A rejection
   * carries the message the person and the agent are told.
   */
  readonly apply: (
    command: AgentMemoryCommand,
    origin: AgentAuthoredMemoryProvenance,
  ) => Promise<MemoryCommandResult>;
  /** The waiting set changed. Wired at composition to the change feed. */
  readonly onChanged?: () => void;
}

interface PendingProposal {
  readonly view: ProjectMemoryProposal;
  readonly windowId: WindowId;
  readonly settle: (outcome: ProjectMemoryProposalOutcome) => void;
}

/**
 * Changes to Project memory a thread's agent asked for, held until the person
 * answers. Memory reaches every later turn in the Project, so below Full
 * access an unreviewed write would be a lasting way to plant instructions;
 * every write the thread's level and the Project's setting do not accept
 * waits here, and no answer is ever remembered for a later one. A proposal is visible only
 * to the window whose turn raised it, until that window confirms or declines
 * it, the turn stops, the window goes away, or ten minutes pass. Only a
 * confirm writes, as that person, through the ordinary memory command path.
 */
export class ProjectMemoryProposalService {
  readonly #pending = new Map<string, PendingProposal>();
  readonly #ttlMs: number;
  readonly #options: ProjectMemoryProposalServiceOptions;

  constructor(options: ProjectMemoryProposalServiceOptions) {
    this.#options = options;
    this.#ttlMs = Math.max(1_000, Math.min(options.ttlMs ?? DEFAULT_TTL_MS, DEFAULT_TTL_MS));
  }

  propose(input: {
    readonly windowId: WindowId;
    readonly proposal: Omit<ProjectMemoryProposal, "proposalId" | "requestedAt">;
    readonly signal?: AbortSignal;
  }): Promise<ProjectMemoryProposalOutcome> {
    const { signal } = input;
    if (signal?.aborted) return Promise.resolve({ status: "cancelled" });
    if (this.#pending.size >= MAX_PENDING_PROJECT_MEMORY_PROPOSALS) {
      return Promise.resolve({ status: "too-many-waiting" });
    }
    const view = decodeProjectMemoryProposal({
      ...input.proposal,
      proposalId: decodeProjectMemoryProposalId(this.#options.uuid()),
      requestedAt: new Date(this.#options.now()).toISOString(),
    });
    const key = String(view.proposalId);
    return new Promise((resolve) => {
      const onAbort = () => settle({ status: "cancelled" });
      const timer = setTimeout(() => settle({ status: "expired" }), this.#ttlMs);
      timer.unref?.();
      let settled = false;
      const settle = (outcome: ProjectMemoryProposalOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (this.#pending.delete(key)) this.#options.onChanged?.();
        resolve(outcome);
      };
      this.#pending.set(key, { view, windowId: input.windowId, settle });
      this.#options.onChanged?.();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** The proposals this window may answer, oldest first. */
  list(windowId: WindowId): ReadonlyArray<ProjectMemoryProposal> {
    return [...this.#pending.values()]
      .filter((pending) => String(pending.windowId) === String(windowId))
      .map((pending) => pending.view);
  }

  /**
   * The person's answer. The proposal leaves the list before anything is
   * written, so exactly one answer acts on it; a second answer, from a retry
   * or another tab of the same window, finds it gone.
   */
  async decide(
    windowId: WindowId,
    decision: ProjectMemoryProposalDecision,
  ): Promise<ProjectMemoryProposalDecisionResult> {
    const key = String(decision.proposalId);
    const pending = this.#pending.get(key);
    if (pending === undefined || String(pending.windowId) !== String(windowId)) {
      return { kind: "project-memory-proposal-gone" };
    }
    this.#pending.delete(key);
    this.#options.onChanged?.();
    if (decision.decision === "decline") {
      pending.settle({ status: "declined" });
      return { kind: "project-memory-proposal-declined" };
    }
    const proposal = pending.view;
    const origin: AgentAuthoredMemoryProvenance = {
      kind: "agent-authored",
      mode: proposal.mode,
      threadId: proposal.threadId,
    };
    try {
      const result = await this.#options.apply(
        agentMemoryCommandFor(proposal, () => decodeMemoryEntryId(this.#options.uuid())),
        origin,
      );
      pending.settle({ status: "confirmed", result });
      return { kind: "project-memory-proposal-confirmed", result };
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Project memory could not be changed.";
      pending.settle({ status: "not-applied", message });
      return { kind: "project-memory-proposal-not-applied", message };
    }
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

/**
 * The memory command for a change an agent asked for, against the memory
 * version the agent saw, so a change made against memory that moved since is
 * refused by the command path whether or not a person was asked.
 */
export function agentMemoryCommandFor(
  write: Pick<ProjectMemoryProposal, "change" | "projectId" | "expectedVersion">,
  newEntryId: () => MemoryEntryId,
): AgentMemoryCommand {
  const { change, projectId, expectedVersion } = write;
  switch (change.kind) {
    case "create":
      return {
        kind: "create-memory-entry",
        projectId,
        entryId: newEntryId(),
        memoryKind: change.memoryKind,
        content: change.content,
        expectedVersion,
      };
    case "supersede":
      return {
        kind: "supersede-memory-entry",
        projectId,
        entryId: change.entryId,
        successorEntryId: newEntryId(),
        content: change.content,
        expectedVersion,
      };
    case "retract":
      return {
        kind: "retract-memory-entry",
        projectId,
        entryId: change.entryId,
        reason: change.reason,
        expectedVersion,
      };
  }
}
