import { describe, expect, it } from "vitest";
import type { IntegrationAuthenticationSnapshot } from "@octant/contracts/integration";
import type { ProjectLinearTarget } from "@octant/contracts/projects";
import {
  decideLinearAgentRead,
  formatProjectLinearTarget,
  matchProjectForLinearIssue,
} from "./linearProjectPolicy";
import { changeProjectLinearTarget, createProject } from "./projectPolicy";
import {
  type ActorId,
  decodeBindingRevisionId,
  decodeProjectId,
  decodeProjectRank,
  decodeUtcTimestamp,
} from "@octant/contracts";

const TARGET: ProjectLinearTarget = {
  teamId: "team-oct",
  teamKey: "OCT",
  teamName: "Octant",
};

const TARGET_WITH_PROJECT: ProjectLinearTarget = {
  teamId: "team-oct",
  teamKey: "OCT",
  teamName: "Octant",
  projectId: "proj-v1",
  projectName: "Preview 1",
};

const READY_SNAPSHOT: IntegrationAuthenticationSnapshot = {
  state: "ready",
  account: { login: "ogard-labs", source: "oauth", scopes: ["read"] },
  capabilities: [
    { operationId: "list-issues", available: true },
    { operationId: "get-issue", available: true },
  ],
};

function makeCodeProject(id: string) {
  return createProject({
    type: "code",
    id: decodeProjectId(id),
    name: "Octant",
    rank: decodeProjectRank("1/1"),
    createdAt: decodeUtcTimestamp("2026-11-24T12:00:00.000Z"),
    binding: { canonicalRoot: "/tmp/octant" },
    revisionId: decodeBindingRevisionId("11111111-1111-4111-8111-111111111111"),
    actor: {
      kind: "local-user",
      actorId: "22222222-2222-4222-8222-222222222222" as ActorId,
    },
  });
}

describe("Linear project mapping and agent read policy", () => {
  it("binds, updates, and clears a Linear target on bound Projects while refusing Chat and no-op changes", () => {
    const project = makeCodeProject("33333333-3333-4333-8333-333333333333");
    const bound = changeProjectLinearTarget(
      project,
      TARGET,
      decodeUtcTimestamp("2026-11-24T12:01:00.000Z"),
    );
    expect(bound.linearTarget).toEqual(TARGET);
    expect(bound.version).toBe(2);

    expect(() =>
      changeProjectLinearTarget(bound, TARGET, decodeUtcTimestamp("2026-11-24T12:02:00.000Z")),
    ).toThrow(/already selected/);

    const withLinearProject = changeProjectLinearTarget(
      bound,
      TARGET_WITH_PROJECT,
      decodeUtcTimestamp("2026-11-24T12:03:00.000Z"),
    );
    expect(withLinearProject.linearTarget).toEqual(TARGET_WITH_PROJECT);

    const cleared = changeProjectLinearTarget(
      withLinearProject,
      null,
      decodeUtcTimestamp("2026-11-24T12:04:00.000Z"),
    );
    expect(cleared).not.toHaveProperty("linearTarget");

    const chat = createProject({
      type: "chat",
      id: decodeProjectId("44444444-4444-4444-8444-444444444444"),
      name: "Notes",
      rank: decodeProjectRank("1/1"),
      createdAt: decodeUtcTimestamp("2026-11-24T12:00:00.000Z"),
    });
    expect(() =>
      changeProjectLinearTarget(chat, TARGET, decodeUtcTimestamp("2026-11-24T12:05:00.000Z")),
    ).toThrow(/Chat Projects/);
  });

  it("authorizes octant_linear only for active Code threads with a bound target and fresh ready capability", () => {
    const base = {
      mode: "code" as const,
      threadLifecycle: "active",
      threadAuthority: "current" as const,
      projectLinearTarget: TARGET,
      snapshot: READY_SNAPSHOT,
      snapshotFreshness: "fresh" as const,
      providerToolPolicy: "allowed" as const,
    };
    expect(decideLinearAgentRead(base)).toEqual({ decision: "allow", target: TARGET });
    expect(decideLinearAgentRead({ ...base, mode: "work" })).toEqual({
      decision: "deny",
      code: "mode",
    });
    expect(decideLinearAgentRead({ ...base, threadLifecycle: "archived" })).toEqual({
      decision: "deny",
      code: "thread-inactive",
    });
    expect(decideLinearAgentRead({ ...base, threadAuthority: "stale" })).toEqual({
      decision: "deny",
      code: "thread-stale",
    });
    expect(decideLinearAgentRead({ ...base, projectLinearTarget: undefined })).toEqual({
      decision: "deny",
      code: "linear-unbound",
    });
    expect(decideLinearAgentRead({ ...base, snapshotFreshness: "stale" })).toEqual({
      decision: "deny",
      code: "stale-capability",
    });
    expect(
      decideLinearAgentRead({
        ...base,
        snapshot: { state: "unauthorized", capabilities: [], remediation: "Connect Linear." },
      }),
    ).toEqual({
      decision: "deny",
      code: "capability-unavailable",
      remediation: "Connect Linear.",
    });
  });

  it("prefers an exact team and Linear project match and refuses ambiguous bindings", () => {
    const projects = [
      { id: "p-team", lifecycle: "active", linearTarget: TARGET },
      { id: "p-preview", lifecycle: "active", linearTarget: TARGET_WITH_PROJECT },
      { id: "p-archived", lifecycle: "archived", linearTarget: TARGET },
    ];
    expect(
      matchProjectForLinearIssue(projects, {
        identifier: "OCT-42",
        teamId: "team-oct",
        projectId: "proj-v1",
      })?.id,
    ).toBe("p-preview");
    expect(
      matchProjectForLinearIssue(projects, {
        identifier: "OCT-99",
        teamId: "team-oct",
      })?.id,
    ).toBe("p-team");
    expect(
      matchProjectForLinearIssue(
        [
          { id: "p-1", lifecycle: "active", linearTarget: TARGET },
          { id: "p-2", lifecycle: "active", linearTarget: TARGET },
        ],
        { identifier: "OCT-1", teamKey: "OCT" },
      ),
    ).toBeUndefined();
    expect(formatProjectLinearTarget(TARGET)).toBe("Octant (OCT)");
    expect(formatProjectLinearTarget(TARGET_WITH_PROJECT)).toBe("Octant (OCT) · Preview 1");
  });

  it("requires the same Linear account before matching a shared team key like ENG", () => {
    const personalEng: ProjectLinearTarget = {
      accountRef: "acct-personal",
      teamId: "team-personal-eng",
      teamKey: "ENG",
      teamName: "Engineering",
    };
    const companyEng: ProjectLinearTarget = {
      accountRef: "acct-company",
      teamId: "team-company-eng",
      teamKey: "ENG",
      teamName: "Engineering",
    };
    const legacyEng: ProjectLinearTarget = {
      teamId: "team-personal-eng",
      teamKey: "ENG",
      teamName: "Engineering",
    };

    const projects = [
      { id: "p-personal", lifecycle: "active", linearTarget: personalEng },
      { id: "p-company", lifecycle: "active", linearTarget: companyEng },
    ];
    expect(
      matchProjectForLinearIssue(projects, {
        identifier: "ENG-42",
        teamKey: "ENG",
        accountRef: "acct-personal",
      })?.id,
    ).toBe("p-personal");
    expect(
      matchProjectForLinearIssue(projects, {
        identifier: "ENG-42",
        teamKey: "ENG",
        accountRef: "acct-company",
      })?.id,
    ).toBe("p-company");
    // Without an accountRef on the issue, a target pinned to an explicit account never matches blindly.
    expect(
      matchProjectForLinearIssue(projects, {
        identifier: "ENG-42",
        teamKey: "ENG",
      }),
    ).toBeUndefined();

    // Legacy target without accountRef matches only the legacy account, never a second account with ENG.
    const legacyProjects = [{ id: "p-legacy", lifecycle: "active", linearTarget: legacyEng }];
    expect(
      matchProjectForLinearIssue(
        legacyProjects,
        { identifier: "ENG-42", teamKey: "ENG", accountRef: "acct-personal" },
        { legacyAccountRef: "acct-personal" },
      )?.id,
    ).toBe("p-legacy");
    expect(
      matchProjectForLinearIssue(
        legacyProjects,
        { identifier: "ENG-42", teamKey: "ENG", accountRef: "acct-company" },
        { legacyAccountRef: "acct-personal" },
      ),
    ).toBeUndefined();
  });
});
