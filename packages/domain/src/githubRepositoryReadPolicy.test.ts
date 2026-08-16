import { describe, expect, it } from "vitest";
import {
  decideGithubAgentRead,
  decideGithubCatalogueRead,
  mayServeStaleCatalogue,
} from "./githubRepositoryReadPolicy";

const readySnapshot = {
  state: "ready" as const,
  capabilities: [
    { kind: "repository-catalogue" as const, available: true },
    { kind: "issues-read" as const, available: true },
    { kind: "pull-requests-read" as const, available: true },
    { kind: "projects-read" as const, available: true },
  ],
};

const boundRepository = { owner: "octant", name: "octant" };

const agentRead = {
  operation: "issues-read" as const,
  mode: "code" as const,
  threadLifecycle: "active" as const,
  threadAuthority: "current" as const,
  projectRepository: boundRepository,
  snapshot: readySnapshot,
  snapshotFreshness: "fresh" as const,
  providerToolPolicy: "allowed" as const,
};

describe("GitHub repository read policy", () => {
  it("allows a Code agent read fixed to the Project repository", () => {
    expect(decideGithubAgentRead(agentRead)).toEqual({
      decision: "allow",
      repository: boundRepository,
      capability: "issues-read",
    });
  });

  it("denies agent reads outside Code mode", () => {
    expect(decideGithubAgentRead({ ...agentRead, mode: "chat" })).toEqual({
      decision: "deny",
      code: "mode",
    });
    expect(decideGithubAgentRead({ ...agentRead, mode: "work" })).toEqual({
      decision: "deny",
      code: "mode",
    });
  });

  it("denies when the thread is inactive or its authority binding went stale", () => {
    expect(decideGithubAgentRead({ ...agentRead, threadLifecycle: "archived" })).toEqual({
      decision: "deny",
      code: "thread-inactive",
    });
    expect(decideGithubAgentRead({ ...agentRead, threadAuthority: "stale" })).toEqual({
      decision: "deny",
      code: "thread-stale",
    });
  });

  it("denies when no Project repository is bound", () => {
    expect(decideGithubAgentRead({ ...agentRead, projectRepository: undefined })).toEqual({
      decision: "deny",
      code: "repository-unbound",
    });
  });

  it("rejects any requested repository that differs from the Project binding", () => {
    expect(
      decideGithubAgentRead({
        ...agentRead,
        requestedRepository: { owner: "octant", name: "other-repo" },
      }),
    ).toEqual({ decision: "deny", code: "repository-mismatch" });
    expect(
      decideGithubAgentRead({
        ...agentRead,
        requestedRepository: { owner: "attacker", name: "octant" },
      }),
    ).toEqual({ decision: "deny", code: "repository-mismatch" });
    expect(
      decideGithubAgentRead({ ...agentRead, requestedRepository: boundRepository }),
    ).toMatchObject({ decision: "allow" });
  });

  it("denies when provider tool policy excludes app-managed GitHub reads", () => {
    expect(decideGithubAgentRead({ ...agentRead, providerToolPolicy: "denied" })).toEqual({
      decision: "deny",
      code: "provider-tool-policy",
    });
  });

  it("never authorizes an agent read from a stale capability snapshot", () => {
    expect(decideGithubAgentRead({ ...agentRead, snapshotFreshness: "stale" })).toEqual({
      decision: "deny",
      code: "stale-capability",
    });
  });

  it("gates each operation independently by proven capability", () => {
    const projectsUnavailable = {
      state: "scope-limited" as const,
      capabilities: [
        { kind: "repository-catalogue" as const, available: true },
        { kind: "issues-read" as const, available: true },
        { kind: "pull-requests-read" as const, available: true },
        {
          kind: "projects-read" as const,
          available: false,
          remediation: "read:project scope required",
        },
      ],
    };
    expect(decideGithubAgentRead({ ...agentRead, snapshot: projectsUnavailable })).toMatchObject({
      decision: "allow",
    });
    expect(
      decideGithubAgentRead({
        ...agentRead,
        operation: "projects-read",
        snapshot: projectsUnavailable,
      }),
    ).toEqual({
      decision: "deny",
      code: "capability-unavailable",
      reason: "scope-limited",
      remediation: "read:project scope required",
    });
  });

  it("maps authentication states onto actionable catalogue denials", () => {
    expect(
      decideGithubCatalogueRead({ capability: "repository-catalogue", snapshot: readySnapshot }),
    ).toEqual({ decision: "allow" });
    for (const [state, reason] of [
      ["unauthorized", "unauthorized"],
      ["rate-limited", "rate-limited"],
      ["insecure-storage", "insecure-storage"],
      ["external-token", "external-token"],
      ["unavailable", "unavailable"],
    ] as const) {
      expect(
        decideGithubCatalogueRead({
          capability: "repository-catalogue",
          snapshot: { state, capabilities: [] },
        }),
      ).toEqual({ decision: "deny", reason });
    }
    expect(
      decideGithubCatalogueRead({
        capability: "issues-read",
        snapshot: {
          state: "scope-limited",
          capabilities: [
            { kind: "issues-read", available: false, remediation: "sso-authorization-required" },
          ],
        },
      }),
    ).toEqual({
      decision: "deny",
      reason: "scope-limited",
      remediation: "sso-authorization-required",
    });
  });

  it("permits stale catalogue data for viewing only", () => {
    expect(mayServeStaleCatalogue("view")).toBe(true);
    expect(mayServeStaleCatalogue("clone-authorization")).toBe(false);
    expect(mayServeStaleCatalogue("project-binding")).toBe(false);
    expect(mayServeStaleCatalogue("agent-read")).toBe(false);
  });
});
