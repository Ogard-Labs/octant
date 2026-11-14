import type { SandboxPolicy } from "@octant/contracts/sandbox-policy";

/** Supplied by host settings, never by a repository manifest or an agent request. */
export function resolveSandboxPolicy(input: {
  readonly settings?: SandboxPolicy;
  readonly project?: SandboxPolicy;
  readonly session?: SandboxPolicy;
}):
  | { readonly source: "legacy" }
  | { readonly source: "settings" | "project" | "session"; readonly policy: SandboxPolicy } {
  if (input.session !== undefined) return { source: "session", policy: input.session };
  if (input.project !== undefined) return { source: "project", policy: input.project };
  if (input.settings !== undefined) return { source: "settings", policy: input.settings };
  return { source: "legacy" };
}

/**
 * Capabilities of one execution route, not a platform-wide protection claim.
 * A planner must admit every route before advertising a session restriction.
 */
export interface SandboxPolicyCapabilities {
  readonly allowedFolders: boolean;
  readonly protectedPaths: boolean;
  readonly networkDeny: boolean;
  readonly unrestrictedNetwork: boolean;
  readonly isolatedCredentials: boolean;
  readonly blockedHostServices: boolean;
}

export type SandboxPolicyRule =
  | "filesystem.allowedFolders"
  | "filesystem.protectedPaths"
  | "network.deny"
  | "network.unrestricted"
  | "credentials.isolated"
  | "hostServices.blocked";

export type SandboxPolicyAdmission =
  | { readonly status: "admitted" }
  | {
      readonly status: "refused";
      readonly code: "sandbox-policy-unsupported";
      readonly rules: ReadonlyArray<SandboxPolicyRule>;
    };

export function admitSandboxPolicy(
  policy: SandboxPolicy,
  capabilities: SandboxPolicyCapabilities,
): SandboxPolicyAdmission {
  const rules: SandboxPolicyRule[] = [];
  if (
    (policy.filesystem.readOnlyRoots.length > 0 || policy.filesystem.readWriteRoots.length > 0) &&
    !capabilities.allowedFolders
  )
    rules.push("filesystem.allowedFolders");
  if (policy.filesystem.protectedPaths.length > 0 && !capabilities.protectedPaths) {
    rules.push("filesystem.protectedPaths");
  }
  if (policy.network === "deny" && !capabilities.networkDeny) rules.push("network.deny");
  if (policy.network === "unrestricted" && !capabilities.unrestrictedNetwork) {
    rules.push("network.unrestricted");
  }
  if (policy.credentials === "isolated" && !capabilities.isolatedCredentials) {
    rules.push("credentials.isolated");
  }
  if (policy.hostServices === "blocked" && !capabilities.blockedHostServices) {
    rules.push("hostServices.blocked");
  }
  return rules.length === 0
    ? { status: "admitted" }
    : { status: "refused", code: "sandbox-policy-unsupported", rules };
}
