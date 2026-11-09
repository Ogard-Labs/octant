import type { CodeThreadId, WorkThreadId, OwnerUnlockPrincipal } from "@octant/contracts";
import type { OwnerApprovalAction, OwnerApprovalId } from "@octant/contracts/owner-approvals";

/** A live wait, never a resumable capability or persisted provider callback. */
export interface RuntimeApprovalRecovery {
  readonly mode: "code" | "work";
  readonly threadId: CodeThreadId | WorkThreadId;
  readonly requestId: OwnerApprovalId;
  readonly identity: string;
  readonly root?: string;
  readonly action: OwnerApprovalAction | undefined;
  readonly current: () => boolean;
  readonly answer: (
    approved: boolean,
    current: () => boolean,
    principal: OwnerUnlockPrincipal,
  ) => Promise<boolean>;
}
