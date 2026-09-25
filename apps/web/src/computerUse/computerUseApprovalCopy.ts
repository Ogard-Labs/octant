import type { ComputerUseSessionView } from "@octant/contracts/computer-use";

type PendingApproval = NonNullable<ComputerUseSessionView["pendingApproval"]>;

export function computerUseApproveLabel(pending: PendingApproval): string {
  return pending.scope === "application-session" ? "Allow app for 5 minutes" : "Approve once";
}

export function computerUseApprovalPrompt(pending: PendingApproval): string {
  return pending.scope === "application-session"
    ? "Octant is waiting for approval to control this application for 5 minutes."
    : "Octant is waiting for a one-time approval.";
}
