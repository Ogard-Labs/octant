import type { ProviderExecutionPolicy } from "@octant/contracts/providers";

/** Words for an agent profile's default policy, so a row never relies on colour. */
export const EXECUTION_POLICY_LABEL: Record<ProviderExecutionPolicy, string> = {
  "full-access": "Full access",
  "approval-gated": "Approval gated",
  "auto-accept-edits": "Auto-accept edits",
  plan: "Plan",
};

export const visuallyHiddenStyle = {
  border: 0,
  clip: "rect(0, 0, 0, 0)",
  clipPath: "inset(50%)",
  height: 1,
  margin: -1,
  overflow: "hidden",
  padding: 0,
  position: "absolute" as const,
  whiteSpace: "nowrap" as const,
  width: 1,
};
