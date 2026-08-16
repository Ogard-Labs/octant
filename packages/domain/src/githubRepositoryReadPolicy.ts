import type {
  GithubAuthenticationState,
  GithubCapability,
  GithubCapabilityKind,
  GithubCatalogueUnavailableReason,
} from "@octant/contracts";

export interface GithubReadCapabilitySnapshot {
  readonly state: GithubAuthenticationState;
  readonly capabilities: readonly GithubCapability[];
}

export interface GithubRepositoryIdentity {
  readonly owner: string;
  readonly name: string;
}

export type GithubAgentReadOperation = Extract<
  GithubCapabilityKind,
  "issues-read" | "pull-requests-read" | "projects-read"
>;

export interface GithubAgentReadInput {
  readonly operation: GithubAgentReadOperation;
  readonly mode: "chat" | "work" | "code";
  readonly threadLifecycle: string;
  /** Server-computed comparison of the executing turn against the stored thread. */
  readonly threadAuthority: "current" | "stale";
  readonly projectRepository: GithubRepositoryIdentity | undefined;
  /** Optional echo from tool input; anything different from the binding fails. */
  readonly requestedRepository?: GithubRepositoryIdentity;
  readonly snapshot: GithubReadCapabilitySnapshot;
  readonly snapshotFreshness: "fresh" | "stale";
  readonly providerToolPolicy: "allowed" | "denied";
}

export type GithubAgentReadDecision =
  | {
      readonly decision: "allow";
      readonly repository: GithubRepositoryIdentity;
      readonly capability: GithubAgentReadOperation;
    }
  | {
      readonly decision: "deny";
      readonly code:
        | "mode"
        | "thread-inactive"
        | "thread-stale"
        | "repository-unbound"
        | "repository-mismatch"
        | "provider-tool-policy"
        | "stale-capability"
        | "capability-unavailable";
      readonly reason?: GithubCatalogueUnavailableReason;
      readonly remediation?: string;
    };

export type GithubCatalogueReadDecision =
  | { readonly decision: "allow" }
  | {
      readonly decision: "deny";
      readonly reason: GithubCatalogueUnavailableReason;
      readonly remediation?: string;
    };

/**
 * Authorize one app-managed agent read. The repository is always the current
 * Code Project binding; agents can never widen discovery, switch repositories,
 * or act on stale capability facts.
 */
export function decideGithubAgentRead(input: GithubAgentReadInput): GithubAgentReadDecision {
  if (input.mode !== "code") return { decision: "deny", code: "mode" };
  if (input.threadLifecycle !== "active") return { decision: "deny", code: "thread-inactive" };
  if (input.threadAuthority !== "current") return { decision: "deny", code: "thread-stale" };
  if (input.providerToolPolicy !== "allowed") {
    return { decision: "deny", code: "provider-tool-policy" };
  }
  const repository = input.projectRepository;
  if (repository === undefined) return { decision: "deny", code: "repository-unbound" };
  if (
    input.requestedRepository !== undefined &&
    (input.requestedRepository.owner !== repository.owner ||
      input.requestedRepository.name !== repository.name)
  ) {
    return { decision: "deny", code: "repository-mismatch" };
  }
  if (input.snapshotFreshness !== "fresh") return { decision: "deny", code: "stale-capability" };
  const gate = decideGithubCatalogueRead({ capability: input.operation, snapshot: input.snapshot });
  if (gate.decision === "deny") {
    return {
      decision: "deny",
      code: "capability-unavailable",
      reason: gate.reason,
      ...(gate.remediation === undefined ? {} : { remediation: gate.remediation }),
    };
  }
  return { decision: "allow", repository, capability: input.operation };
}

/**
 * Gate one normalized catalogue read on the honest per-operation capability
 * state. Every other operation stays independently available.
 */
export function decideGithubCatalogueRead(input: {
  readonly capability: GithubCapabilityKind;
  readonly snapshot: GithubReadCapabilitySnapshot;
}): GithubCatalogueReadDecision {
  const state = input.snapshot.state;
  if (state !== "ready" && state !== "scope-limited") {
    return { decision: "deny", reason: state };
  }
  const capability = input.snapshot.capabilities.find(
    (candidate) => candidate.kind === input.capability,
  );
  if (capability === undefined || !capability.available) {
    return {
      decision: "deny",
      reason: "scope-limited",
      ...(capability?.remediation === undefined ? {} : { remediation: capability.remediation }),
    };
  }
  return { decision: "allow" };
}

/**
 * Stale catalogue data stays viewable but never authorizes clone, Code Project
 * binding, or agent access.
 */
export function mayServeStaleCatalogue(
  purpose: "view" | "clone-authorization" | "project-binding" | "agent-read",
): boolean {
  return purpose === "view";
}
