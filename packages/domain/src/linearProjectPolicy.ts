import type { IntegrationAuthenticationSnapshot } from "@octant/contracts/integration";
import { linearIssueBrowseAvailable } from "@octant/contracts/linear-issues";
import type { ProjectLinearTarget } from "@octant/contracts/projects";

export interface LinearAgentReadInput {
  readonly mode: "chat" | "work" | "code";
  readonly threadLifecycle: string;
  /** Server-computed comparison of the executing turn against the stored thread. */
  readonly threadAuthority: "current" | "stale";
  readonly projectLinearTarget: ProjectLinearTarget | undefined;
  readonly snapshot: Pick<
    IntegrationAuthenticationSnapshot,
    "state" | "capabilities" | "remediation"
  >;
  readonly snapshotFreshness: "fresh" | "stale";
  readonly providerToolPolicy: "allowed" | "denied";
}

export type LinearAgentReadDecision =
  | {
      readonly decision: "allow";
      readonly target: ProjectLinearTarget;
    }
  | {
      readonly decision: "deny";
      readonly code:
        | "mode"
        | "thread-inactive"
        | "thread-stale"
        | "linear-unbound"
        | "provider-tool-policy"
        | "stale-capability"
        | "capability-unavailable";
      readonly remediation?: string;
    };

/**
 * Authorize one project-pinned `octant_linear` agent read. The Linear team and
 * optional Linear project always come from the current Code Project's binding;
 * agents can never widen scope, switch teams, or act on stale capability facts.
 */
export function decideLinearAgentRead(input: LinearAgentReadInput): LinearAgentReadDecision {
  if (input.mode !== "code") return { decision: "deny", code: "mode" };
  if (input.threadLifecycle !== "active") return { decision: "deny", code: "thread-inactive" };
  if (input.threadAuthority !== "current") return { decision: "deny", code: "thread-stale" };
  if (input.providerToolPolicy !== "allowed") {
    return { decision: "deny", code: "provider-tool-policy" };
  }
  const target = input.projectLinearTarget;
  if (target === undefined) return { decision: "deny", code: "linear-unbound" };
  if (input.snapshotFreshness !== "fresh") return { decision: "deny", code: "stale-capability" };
  const state = input.snapshot.state;
  if (
    (state !== "ready" && state !== "scope-limited") ||
    !linearIssueBrowseAvailable(input.snapshot.capabilities)
  ) {
    return {
      decision: "deny",
      code: "capability-unavailable",
      ...(input.snapshot.remediation === undefined
        ? {}
        : { remediation: input.snapshot.remediation }),
    };
  }
  return { decision: "allow", target };
}

export interface LinearIssueMatchCandidate {
  readonly identifier: string;
  readonly teamId?: string | undefined;
  readonly teamKey?: string | undefined;
  readonly projectId?: string | undefined;
}

export interface ProjectLinearMatchCandidate {
  readonly id: string;
  readonly lifecycle?: string | undefined;
  readonly linearTarget?: ProjectLinearTarget | undefined;
}

function issueTeamKey(issue: LinearIssueMatchCandidate): string | undefined {
  if (issue.teamKey !== undefined && issue.teamKey.trim() !== "") {
    return issue.teamKey.trim().toUpperCase();
  }
  const dash = issue.identifier.indexOf("-");
  if (dash <= 0) return undefined;
  return issue.identifier.slice(0, dash).toUpperCase();
}

function matchesTeam(target: ProjectLinearTarget, issue: LinearIssueMatchCandidate): boolean {
  if (issue.teamId !== undefined) return target.teamId === issue.teamId;
  const key = issueTeamKey(issue);
  return key !== undefined && target.teamKey.toUpperCase() === key;
}

/**
 * Find the single active Octant Project mapped to a Linear issue, preferring an
 * exact team + Linear project binding over a team-wide binding. Returns
 * undefined when zero or multiple Projects match so callers never guess.
 */
export function matchProjectForLinearIssue<T extends ProjectLinearMatchCandidate>(
  projects: ReadonlyArray<T>,
  issue: LinearIssueMatchCandidate,
): T | undefined {
  const activeBound = projects.filter(
    (project) =>
      (project.lifecycle === undefined || project.lifecycle === "active") &&
      project.linearTarget !== undefined,
  );
  if (issue.projectId !== undefined) {
    const exact = activeBound.filter(
      (project) =>
        project.linearTarget !== undefined &&
        matchesTeam(project.linearTarget, issue) &&
        project.linearTarget.projectId === issue.projectId,
    );
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return undefined;
  }
  const teamWide = activeBound.filter(
    (project) =>
      project.linearTarget !== undefined &&
      project.linearTarget.projectId === undefined &&
      matchesTeam(project.linearTarget, issue),
  );
  return teamWide.length === 1 ? teamWide[0] : undefined;
}

/** Short display label for a Project's Linear binding. */
export function formatProjectLinearTarget(target: ProjectLinearTarget): string {
  const team = `${target.teamName} (${target.teamKey})`;
  return target.projectName === undefined ? team : `${team} · ${target.projectName}`;
}
