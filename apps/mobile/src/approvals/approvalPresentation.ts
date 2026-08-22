/**
 * Where high-risk mobile actions may settle. Host desktop approval challenges
 * remain local-host-only (`desktop.issue-local-approval`); the phone never
 * invents authority. Self-revoke is a phone-biometric path.
 */

export type MobileHighRiskAction = "approve" | "reject" | "revoke" | "elevate-full-access";

export type MobileApprovalVenue = "phone-biometric" | "desktop-host-only";

export function venueForHighRiskAction(action: MobileHighRiskAction): MobileApprovalVenue {
  switch (action) {
    case "revoke":
      return "phone-biometric";
    case "approve":
    case "reject":
    case "elevate-full-access":
      return "desktop-host-only";
  }
}

export interface DesktopApprovalImpactFacts {
  readonly hostLabel?: string;
  readonly mode?: "chat" | "work" | "code";
  readonly threadTitle?: string;
  readonly executionPolicy?: string;
  readonly operationSummary?: string;
}

/** Impact copy from host-advertised facts only — never invents risk. */
export function desktopApprovalImpactSummary(facts: DesktopApprovalImpactFacts): string {
  const parts: string[] = [];
  if (facts.hostLabel !== undefined && facts.hostLabel.trim().length > 0) {
    parts.push(`Host: ${facts.hostLabel.trim()}`);
  }
  if (facts.mode !== undefined) parts.push(`Mode: ${facts.mode}`);
  if (facts.threadTitle !== undefined && facts.threadTitle.trim().length > 0) {
    parts.push(`Thread: ${facts.threadTitle.trim()}`);
  }
  if (facts.executionPolicy !== undefined && facts.executionPolicy.trim().length > 0) {
    parts.push(`Execution policy: ${facts.executionPolicy.trim()}`);
  }
  if (facts.operationSummary !== undefined && facts.operationSummary.trim().length > 0) {
    parts.push(facts.operationSummary.trim());
  }
  if (parts.length === 0) {
    return "A bounded approval is waiting on the desktop host. Octant Mobile cannot mint local approval receipts.";
  }
  return `${parts.join(" · ")}. Complete this approval on the desktop host.`;
}

export const DESKTOP_APPROVAL_DEFER_COPY =
  "Approve or reject on the desktop host. High-risk approval challenges stay local-host-only.";
