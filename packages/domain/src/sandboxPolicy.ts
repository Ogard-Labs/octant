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
  if (
    (policy.hostServices === "blocked" || (policy.localServices?.length ?? 0) > 0) &&
    !capabilities.blockedHostServices
  ) {
    rules.push("hostServices.blocked");
  }
  return rules.length === 0
    ? { status: "admitted" }
    : { status: "refused", code: "sandbox-policy-unsupported", rules };
}

/** A helper may retain or lose grants, never acquire a grant absent from its parent. */
export function intersectSandboxPolicies(
  parent: SandboxPolicy,
  child: SandboxPolicy,
): SandboxPolicy {
  const inside = (root: string, candidate: string) =>
    root === candidate || candidate.startsWith(`${root}/`);
  const intersection = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) => [
    ...new Set(
      left.flatMap((a) => right.flatMap((b) => (inside(a, b) ? [b] : inside(b, a) ? [a] : []))),
    ),
  ];
  const readWriteRoots = intersection(
    parent.filesystem.readWriteRoots,
    child.filesystem.readWriteRoots,
  );
  const readOnlyRoots = intersection(
    [...parent.filesystem.readOnlyRoots, ...parent.filesystem.readWriteRoots],
    [...child.filesystem.readOnlyRoots, ...child.filesystem.readWriteRoots],
  ).filter((root) => !readWriteRoots.some((write) => inside(write, root)));
  const approvedDestinations = (child.approvedDestinations ?? []).filter(
    (destination) =>
      parent.network === "unrestricted" ||
      parent.approvedDestinations?.some(
        (allowed) => allowed.host === destination.host && allowed.port === destination.port,
      ),
  );
  const rank = { deny: 0, "existing-policy": 1, unrestricted: 2 };
  return {
    schemaVersion: 1,
    approvedDestinations,
    localServices: (child.localServices ?? []).filter((service) =>
      parent.localServices?.some(
        (allowed) => allowed.host === service.host && allowed.port === service.port,
      ),
    ),
    revision: Math.max(parent.revision, child.revision),
    filesystem: {
      readOnlyRoots,
      readWriteRoots,
      protectedPaths: [...parent.filesystem.protectedPaths, ...child.filesystem.protectedPaths],
    },
    network: rank[parent.network] < rank[child.network] ? parent.network : child.network,
    credentials:
      parent.credentials === "isolated" || child.credentials === "isolated"
        ? "isolated"
        : "existing-policy",
    hostServices:
      parent.hostServices === "blocked" || child.hostServices === "blocked"
        ? "blocked"
        : "existing-policy",
  };
}

/** Brackets are HTTP authority syntax, never an alternate address or DNS grant. */
export function sandboxLocalServiceAllowed(
  services: SandboxPolicy["localServices"],
  host: string,
  port: number,
): boolean {
  const literal = host === "[::1]" ? "::1" : host;
  return services?.some((service) => service.host === literal && service.port === port) === true;
}
