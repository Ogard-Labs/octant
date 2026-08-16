import type {
  WorkPromotionProposal,
  WorkPromotionProposalId,
  WorkPromotionFrame,
} from "@octant/contracts/work-promotion";
import type { CodeThreadId } from "@octant/contracts/code";

export interface WorkPromotionEntry {
  readonly proposalId: WorkPromotionProposalId;
  readonly proposal: WorkPromotionProposal;
  readonly linkedCodeThreadId?: CodeThreadId;
}

/**
 * Rebuildable in-memory Work promotion projection. The promotion service
 * replays journaled `WorkPromotionFrame` events into this projection to
 * reconstruct proposal state, current status, and the linked Code thread id
 * for an approved promotion. The projection is idempotent: replaying the same
 * frame sequence produces identical state, so reconnect or restart rebuilds
 * promotion state from the authoritative event journal without a separate
 * store. Terminal proposals (approved, dismissed, expired) are retained so
 * transition authority can fail closed on a replayed or stale command.
 */
export class WorkPromotionProjection {
  readonly #entries = new Map<WorkPromotionProposalId, WorkPromotionEntry>();

  apply(frame: WorkPromotionFrame): void {
    const proposal = frame.proposal;
    const existing = this.#entries.get(proposal.proposalId);
    // Ignore stale frames: a reconnect/duplicate subscription must never
    // roll a terminal proposal (approved/dismissed/expired) back to an
    // earlier version. Only frames whose version is strictly newer than
    // the current head replace the entry.
    if (existing !== undefined && proposal.version <= existing.proposal.version) {
      return;
    }
    switch (frame.kind) {
      case "proposed": {
        this.#entries.set(proposal.proposalId, { proposalId: proposal.proposalId, proposal });
        return;
      }
      case "approved": {
        this.#entries.set(proposal.proposalId, {
          proposalId: proposal.proposalId,
          proposal,
          linkedCodeThreadId: frame.linkedCodeThreadId,
        });
        return;
      }
      case "dismissed":
      case "expired": {
        this.#entries.set(proposal.proposalId, { proposalId: proposal.proposalId, proposal });
        return;
      }
    }
  }

  lookup(proposalId: WorkPromotionProposalId): WorkPromotionEntry | undefined {
    return this.#entries.get(proposalId);
  }

  snapshot(): ReadonlyMap<WorkPromotionProposalId, WorkPromotionEntry> {
    return new Map(this.#entries);
  }
}
