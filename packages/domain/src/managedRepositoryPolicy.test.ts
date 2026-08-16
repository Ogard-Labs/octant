import { describe, expect, it } from "vitest";
import {
  classifyManagedDestination,
  decideGithubCloneAuthorization,
  decideGithubCloneConfirmation,
  decideGithubCloneRecovery,
  deriveManagedRepositorySegments,
  isGithubCloneTransitionAllowed,
  normalizeGithubOriginUrl,
  verifyClonedRepository,
  type ClonedRepositoryVerificationInput,
} from "./managedRepositoryPolicy";

const expected = { nodeId: "R_kgDOG8x1Aa", owner: "octant", name: "octant" } as const;
const readySnapshot = {
  state: "ready" as const,
  account: { login: "octant", gitProtocol: "https" as const, scopes: ["repo"] },
};

describe("managed repository destination derivation", () => {
  it("derives strict github.com/owner/name segments from GitHub identity", () => {
    expect(deriveManagedRepositorySegments({ owner: "octant", name: "octant" })).toEqual({
      kind: "derived",
      segments: ["github.com", "octant", "octant"],
    });
  });

  it("refuses traversal, separators, reserved names, and .git suffixes", () => {
    for (const name of ["..", ".", "a/b", "a\\b", "repo.git", "REPO.GIT", "a\0b"]) {
      expect(deriveManagedRepositorySegments({ owner: "octant", name })).toMatchObject({
        kind: "refused",
      });
    }
    for (const owner of ["", "-lead", "trail-", "own..er", "own/er", "a".repeat(40)]) {
      expect(deriveManagedRepositorySegments({ owner, name: "octant" })).toMatchObject({
        kind: "refused",
      });
    }
  });

  it("keeps legitimately dotted names derivable as single safe segments", () => {
    for (const name of ["release-1.2", "..evil.."]) {
      expect(deriveManagedRepositorySegments({ owner: "octant", name })).toEqual({
        kind: "derived",
        segments: ["github.com", "octant", name],
      });
    }
  });
});

describe("clone state machine", () => {
  it("allows only the designed transitions", () => {
    expect(isGithubCloneTransitionAllowed("awaiting-confirmation", "reserved")).toBe(true);
    expect(isGithubCloneTransitionAllowed("awaiting-confirmation", "verifying")).toBe(true);
    expect(isGithubCloneTransitionAllowed("reserved", "cloning")).toBe(true);
    expect(isGithubCloneTransitionAllowed("cloning", "verifying")).toBe(true);
    expect(isGithubCloneTransitionAllowed("verifying", "attaching")).toBe(true);
    expect(isGithubCloneTransitionAllowed("attaching", "completed")).toBe(true);
    expect(isGithubCloneTransitionAllowed("verifying", "recovery-required")).toBe(true);
    expect(isGithubCloneTransitionAllowed("attaching", "recovery-required")).toBe(true);
    for (const state of ["reserved", "cloning", "verifying", "attaching"] as const) {
      expect(isGithubCloneTransitionAllowed(state, "failed")).toBe(true);
      expect(isGithubCloneTransitionAllowed(state, "cancelled")).toBe(true);
    }
    expect(isGithubCloneTransitionAllowed("recovery-required", "cancelled")).toBe(true);
  });

  it("never leaves a terminal state and never skips forward", () => {
    for (const terminal of ["completed", "failed", "cancelled"] as const) {
      for (const next of [
        "awaiting-confirmation",
        "reserved",
        "cloning",
        "verifying",
        "attaching",
        "completed",
        "failed",
        "cancelled",
        "recovery-required",
      ] as const) {
        expect(isGithubCloneTransitionAllowed(terminal, next)).toBe(false);
      }
    }
    expect(isGithubCloneTransitionAllowed("awaiting-confirmation", "cloning")).toBe(false);
    expect(isGithubCloneTransitionAllowed("reserved", "completed")).toBe(false);
    expect(isGithubCloneTransitionAllowed("cloning", "attaching")).toBe(false);
    expect(isGithubCloneTransitionAllowed("recovery-required", "completed")).toBe(false);
  });
});

describe("clone authorization", () => {
  const observation = { ...expected, defaultBranch: "development" };

  it("allows a fresh observed node identity on a ready https account", () => {
    expect(
      decideGithubCloneAuthorization({
        snapshot: readySnapshot,
        freshness: "fresh",
        observed: observation,
        expected,
      }),
    ).toEqual({ decision: "allow", repository: observation });
  });

  it("fails closed for every non-ready authentication state", () => {
    for (const state of [
      "unauthorized",
      "insecure-storage",
      "external-token",
      "rate-limited",
      "unavailable",
    ] as const) {
      expect(
        decideGithubCloneAuthorization({
          snapshot: { state },
          freshness: "fresh",
          observed: observation,
          expected,
        }),
      ).toMatchObject({ decision: "deny", code: "unauthorized" });
    }
  });

  it("rejects a non-https gh git protocol before any clone effect", () => {
    expect(
      decideGithubCloneAuthorization({
        snapshot: { state: "ready" },
        freshness: "fresh",
        observed: observation,
        expected,
      }),
    ).toMatchObject({ decision: "deny", code: "non-https-git-protocol" });
  });

  it("never authorizes from stale catalogue data", () => {
    expect(
      decideGithubCloneAuthorization({
        snapshot: readySnapshot,
        freshness: "stale",
        observed: observation,
        expected,
      }),
    ).toMatchObject({ decision: "deny", code: "stale-read" });
    expect(
      decideGithubCloneAuthorization({
        snapshot: readySnapshot,
        freshness: "fresh",
        observed: undefined,
        expected,
      }),
    ).toMatchObject({ decision: "deny", code: "stale-read" });
  });

  it("rejects node identity and name mismatches even when the other matches", () => {
    expect(
      decideGithubCloneAuthorization({
        snapshot: readySnapshot,
        freshness: "fresh",
        observed: { ...observation, nodeId: "R_other" },
        expected,
      }),
    ).toMatchObject({ decision: "deny", code: "node-identity-mismatch" });
    expect(
      decideGithubCloneAuthorization({
        snapshot: readySnapshot,
        freshness: "fresh",
        observed: { ...observation, name: "renamed" },
        expected,
      }),
    ).toMatchObject({ decision: "deny", code: "invalid-repository-identity" });
  });
});

describe("clone confirmation", () => {
  const operation = {
    state: "awaiting-confirmation" as const,
    nodeId: expected.nodeId,
    destinationDigest: "d".repeat(64),
  };

  it("requires the awaiting state, exact node identity, and exact digest", () => {
    expect(
      decideGithubCloneConfirmation({
        operation,
        command: { nodeId: expected.nodeId, destinationDigest: "d".repeat(64) },
      }),
    ).toEqual({ decision: "allow" });
    expect(
      decideGithubCloneConfirmation({
        operation: { ...operation, state: "cloning" },
        command: { nodeId: expected.nodeId, destinationDigest: "d".repeat(64) },
      }),
    ).toMatchObject({ decision: "deny", code: "state" });
    expect(
      decideGithubCloneConfirmation({
        operation,
        command: { nodeId: "R_other", destinationDigest: "d".repeat(64) },
      }),
    ).toMatchObject({ decision: "deny", code: "node-identity-mismatch" });
    expect(
      decideGithubCloneConfirmation({
        operation,
        command: { nodeId: expected.nodeId, destinationDigest: "e".repeat(64) },
      }),
    ).toMatchObject({ decision: "deny", code: "destination-digest-mismatch" });
  });
});

describe("destination classification", () => {
  it("classifies missing destinations as available", () => {
    expect(classifyManagedDestination({ exists: false })).toEqual({ kind: "available" });
  });

  it("treats symlinks as confinement violations and files as collisions", () => {
    expect(classifyManagedDestination({ exists: true, kind: "symlink" })).toEqual({
      kind: "collision",
      code: "path-confinement",
    });
    expect(classifyManagedDestination({ exists: true, kind: "file" })).toEqual({
      kind: "collision",
      code: "destination-collision",
    });
    expect(classifyManagedDestination({ exists: true, kind: "other" })).toEqual({
      kind: "collision",
      code: "destination-collision",
    });
  });

  it("never adopts or empties an existing directory implicitly", () => {
    expect(
      classifyManagedDestination({ exists: true, kind: "directory", checkout: "unverifiable" }),
    ).toEqual({ kind: "collision", code: "destination-collision" });
    expect(
      classifyManagedDestination({ exists: true, kind: "directory", checkout: "different" }),
    ).toEqual({ kind: "collision", code: "destination-collision" });
  });

  it("labels only a verified matching checkout as attachable", () => {
    expect(
      classifyManagedDestination({
        exists: true,
        kind: "directory",
        checkout: "matching-verified",
      }),
    ).toEqual({ kind: "attachable" });
    expect(
      classifyManagedDestination({ exists: true, kind: "directory", checkout: "bare" }),
    ).toEqual({ kind: "collision", code: "bare-repository" });
    expect(
      classifyManagedDestination({ exists: true, kind: "directory", checkout: "submodule" }),
    ).toEqual({ kind: "collision", code: "submodule-root" });
    expect(
      classifyManagedDestination({ exists: true, kind: "directory", checkout: "wrong-origin" }),
    ).toEqual({ kind: "collision", code: "wrong-origin" });
  });
});

describe("origin URL normalization", () => {
  it("accepts only exact https github.com owner/name endpoints", () => {
    expect(normalizeGithubOriginUrl("https://github.com/octant/octant.git")).toEqual({
      owner: "octant",
      name: "octant",
    });
    expect(normalizeGithubOriginUrl("https://github.com/octant/octant")).toEqual({
      owner: "octant",
      name: "octant",
    });
  });

  it("rejects userinfo, queries, fragments, hosts, protocols, and extra segments", () => {
    for (const url of [
      "https://token@github.com/octant/octant.git",
      "https://user:ghp_0123456789abcdef@github.com/o/n.git",
      "https://github.com/octant/octant.git?token=x",
      "https://github.com/octant/octant.git#frag",
      "https://github.evil.com/octant/octant.git",
      "http://github.com/octant/octant.git",
      "ssh://git@github.com/octant/octant.git",
      "git@github.com:octant/octant.git",
      "https://github.com/octant/octant/extra",
      "https://github.com/octant",
      "https://github.com/../octant",
    ]) {
      expect(normalizeGithubOriginUrl(url)).toBeUndefined();
    }
  });
});

describe("cloned repository verification", () => {
  const verified: ClonedRepositoryVerificationInput = {
    stagingConfined: true,
    bare: false,
    commonDirectoryConfined: true,
    submodule: false,
    worktreeCount: 1,
    originUrl: "https://github.com/octant/octant.git",
    expected,
    freshObservation: { ...expected, defaultBranch: "development" },
    remoteRefsPresent: true,
    remoteHeadBranch: "development",
    resolvedHeadOid: "a".repeat(40),
  };

  it("verifies a confined matching checkout with a consistent default branch", () => {
    expect(verifyClonedRepository(verified)).toEqual({
      decision: "verified",
      oid: "a".repeat(40),
      defaultBranch: "development",
      empty: false,
    });
  });

  it("verifies an explicit empty repository without an object id", () => {
    expect(
      verifyClonedRepository({
        ...verified,
        remoteRefsPresent: false,
        remoteHeadBranch: undefined,
        resolvedHeadOid: undefined,
      }),
    ).toEqual({ decision: "verified", empty: true, defaultBranch: "development" });
  });

  it("fails closed for every hostile or inconsistent observation", () => {
    const failures: ReadonlyArray<[Partial<typeof verified>, string]> = [
      [{ stagingConfined: false }, "path-confinement"],
      [{ commonDirectoryConfined: false }, "path-confinement"],
      [{ bare: true }, "bare-repository"],
      [{ submodule: true }, "submodule-root"],
      [{ worktreeCount: 2 }, "worktree-conflict"],
      [{ originUrl: undefined }, "wrong-origin"],
      [{ originUrl: "https://gitlab.com/octant/octant.git" }, "wrong-origin"],
      [{ originUrl: "https://x@github.com/octant/octant.git" }, "wrong-origin"],
      [{ originUrl: "https://github.com/other/octant.git" }, "wrong-origin"],
      [{ freshObservation: undefined }, "stale-read"],
      [
        { freshObservation: { ...expected, nodeId: "R_other", defaultBranch: "development" } },
        "node-identity-mismatch",
      ],
      [
        { freshObservation: { ...expected, name: "renamed", defaultBranch: "development" } },
        "invalid-repository-identity",
      ],
      [{ remoteHeadBranch: "main" }, "default-branch-mismatch"],
      [{ remoteHeadBranch: undefined }, "default-branch-mismatch"],
      [{ resolvedHeadOid: undefined }, "verification-failed"],
      [{ resolvedHeadOid: "not-an-oid" }, "verification-failed"],
    ];
    for (const [override, code] of failures) {
      expect(verifyClonedRepository({ ...verified, ...override })).toEqual({
        decision: "failed",
        code,
      });
    }
  });
});

describe("restart recovery", () => {
  it("retains states with no side effects and terminal states", () => {
    expect(
      decideGithubCloneRecovery({
        state: "awaiting-confirmation",
        mode: "clone",
        stagingExists: false,
        destinationExists: false,
      }),
    ).toEqual({ action: "retain" });
    for (const state of ["completed", "failed", "cancelled", "recovery-required"] as const) {
      expect(
        decideGithubCloneRecovery({
          state,
          mode: "clone",
          stagingExists: false,
          destinationExists: false,
        }),
      ).toEqual({ action: "retain" });
    }
  });

  it("quarantines partial staging deterministically and never restarts a clone", () => {
    expect(
      decideGithubCloneRecovery({
        state: "reserved",
        mode: "clone",
        stagingExists: true,
        destinationExists: false,
      }),
    ).toEqual({ action: "quarantine-and-fail", code: "restart-interrupted" });
    expect(
      decideGithubCloneRecovery({
        state: "cloning",
        mode: "clone",
        stagingExists: true,
        destinationExists: false,
      }),
    ).toEqual({ action: "quarantine-and-fail", code: "restart-interrupted" });
    expect(
      decideGithubCloneRecovery({
        state: "cloning",
        mode: "clone",
        stagingExists: false,
        destinationExists: false,
      }),
    ).toEqual({ action: "fail", code: "restart-interrupted" });
  });

  it("never reports silent success across the promotion window", () => {
    expect(
      decideGithubCloneRecovery({
        state: "verifying",
        mode: "clone",
        stagingExists: true,
        destinationExists: false,
      }),
    ).toEqual({ action: "quarantine-and-fail", code: "restart-interrupted" });
    expect(
      decideGithubCloneRecovery({
        state: "verifying",
        mode: "clone",
        stagingExists: false,
        destinationExists: true,
      }),
    ).toEqual({ action: "recovery-required" });
    expect(
      decideGithubCloneRecovery({
        state: "attaching",
        mode: "clone",
        stagingExists: false,
        destinationExists: true,
      }),
    ).toEqual({ action: "recovery-required" });
    expect(
      decideGithubCloneRecovery({
        state: "attaching",
        mode: "clone",
        stagingExists: true,
        destinationExists: false,
      }),
    ).toEqual({ action: "quarantine-and-fail", code: "restart-interrupted" });
  });

  it("fails attach-existing interruptions without touching the destination", () => {
    for (const state of ["verifying", "attaching"] as const) {
      expect(
        decideGithubCloneRecovery({
          state,
          mode: "attach-existing",
          stagingExists: false,
          destinationExists: true,
        }),
      ).toEqual({ action: "fail", code: "restart-interrupted" });
    }
  });
});
