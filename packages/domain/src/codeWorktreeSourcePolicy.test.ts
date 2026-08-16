import { decodeCodeWorktreeSourcePreview } from "@octant/contracts/code";
import { describe, expect, it } from "vitest";
import {
  canUseCachedSnapshot,
  defaultDeliveryBranchIntent,
  defaultStartFromOrigin,
  describeWorktreeSource,
  formatFetchAge,
  selectWorktreeRemote,
  shortSha,
  worktreePreviewToResolution,
  type WorktreeRemoteFacts,
  type WorktreeSourceResolution,
} from "./codeWorktreeSourcePolicy";

const FULL_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9011223344";
const FETCHED_AT = "2026-07-30T08:00:00.000Z";
const now = () => new Date("2026-07-30T08:05:00.000Z");

describe("selectWorktreeRemote", () => {
  it("prefers the branch's configured upstream when it is a known remote", () => {
    const facts: WorktreeRemoteFacts = {
      remotes: ["origin", "upstream"],
      upstreamRemote: "upstream",
      defaultRemote: "origin",
    };
    expect(selectWorktreeRemote(facts)).toEqual({
      status: "selected",
      remoteName: "upstream",
      source: "upstream",
    });
  });

  it("falls back to the repository default remote when there is no upstream", () => {
    const facts: WorktreeRemoteFacts = {
      remotes: ["origin", "mirror"],
      defaultRemote: "origin",
    };
    expect(selectWorktreeRemote(facts)).toEqual({
      status: "selected",
      remoteName: "origin",
      source: "default",
    });
  });

  it("ignores an upstream that is not among the configured remotes", () => {
    const facts: WorktreeRemoteFacts = {
      remotes: ["origin"],
      upstreamRemote: "gone",
      defaultRemote: "origin",
    };
    expect(selectWorktreeRemote(facts)).toEqual({
      status: "selected",
      remoteName: "origin",
      source: "default",
    });
  });

  it("uses the only configured remote when no upstream or default is recorded", () => {
    const facts: WorktreeRemoteFacts = { remotes: ["origin"] };
    expect(selectWorktreeRemote(facts)).toEqual({
      status: "selected",
      remoteName: "origin",
      source: "default",
    });
  });

  it("fails closed when no remote exists instead of guessing origin", () => {
    expect(selectWorktreeRemote({ remotes: [] })).toEqual({
      status: "unavailable",
      reason: "no-remote",
    });
  });

  it("fails closed when multiple remotes exist with no upstream or default", () => {
    expect(selectWorktreeRemote({ remotes: ["origin", "mirror"] })).toEqual({
      status: "unavailable",
      reason: "ambiguous",
    });
  });
});

describe("defaultStartFromOrigin", () => {
  it("defaults on when a usable remote is selectable", () => {
    expect(defaultStartFromOrigin({ remotes: ["origin"] })).toBe(true);
  });

  it("defaults off when no usable remote exists", () => {
    expect(defaultStartFromOrigin({ remotes: [] })).toBe(false);
    expect(defaultStartFromOrigin({ remotes: ["origin", "mirror"] })).toBe(false);
  });
});

describe("defaultDeliveryBranchIntent", () => {
  it("produces a unique octant/<short-id> branch that differs from the base branch", () => {
    const branch = defaultDeliveryBranchIntent("development", "abc123def456");
    expect(branch).toBe("octant/abc123def456");
    expect(branch).not.toBe("development");
  });

  it("never collides with the base branch even if the base is octant/<id>", () => {
    const branch = defaultDeliveryBranchIntent("octant/abc123def456", "abc123def456");
    expect(branch).not.toBe("octant/abc123def456");
    expect(branch).toBe("octant/abc123def456-work");
  });

  it("falls back to a safe id when the short id is empty or unsafe", () => {
    expect(defaultDeliveryBranchIntent("development", "")).toBe("octant/new");
    expect(defaultDeliveryBranchIntent("development", "  ")).toBe("octant/new");
    expect(defaultDeliveryBranchIntent("development", "a;b/c")).toBe("octant/abc");
  });
});

describe("shortSha", () => {
  it("shortens a full object id to seven characters", () => {
    expect(shortSha(FULL_SHA)).toBe("a1b2c3d");
  });
});

describe("formatFetchAge", () => {
  it("describes sub-minute age as just now", () => {
    expect(formatFetchAge(30_000)).toBe("just now");
  });

  it("describes minute age", () => {
    expect(formatFetchAge(5 * 60_000)).toBe("5m");
  });

  it("describes hour age", () => {
    expect(formatFetchAge(3 * 3_600_000)).toBe("3h");
  });

  it("describes day age", () => {
    expect(formatFetchAge(2 * 86_400_000)).toBe("2d");
  });
});

describe("describeWorktreeSource", () => {
  it("discloses the exact remote branch and short SHA for a fresh origin source", () => {
    const resolution: WorktreeSourceResolution = {
      kind: "origin",
      remoteName: "origin",
      branch: "development",
      resolvedHead: FULL_SHA,
      fetchedAt: FETCHED_AT,
    };
    expect(describeWorktreeSource(resolution, now)).toEqual({
      label: "origin/development · a1b2c3d",
    });
  });

  it("labels a local source as local and warns it may differ from the remote", () => {
    const resolution: WorktreeSourceResolution = {
      kind: "local",
      branch: "development",
      resolvedHead: FULL_SHA,
      remoteName: "origin",
    };
    expect(describeWorktreeSource(resolution, now)).toEqual({
      label: "Local development · a1b2c3d",
      detail: "may differ from origin",
    });
  });

  it("falls back to a generic remote warning when no remote name is known", () => {
    const resolution: WorktreeSourceResolution = {
      kind: "local",
      branch: "development",
      resolvedHead: FULL_SHA,
    };
    expect(describeWorktreeSource(resolution, now)).toEqual({
      label: "Local development · a1b2c3d",
      detail: "may differ from remote",
    });
  });

  it("discloses a cached snapshot's age and exact SHA", () => {
    const resolution: WorktreeSourceResolution = {
      kind: "cached-snapshot",
      remoteName: "origin",
      branch: "development",
      resolvedHead: FULL_SHA,
      fetchedAt: FETCHED_AT,
    };
    expect(describeWorktreeSource(resolution, now)).toEqual({
      label: "origin/development · a1b2c3d",
      detail: "fetched 5m ago",
      ageMs: 5 * 60_000,
    });
  });

  it("describes an in-flight fetch without a resolved SHA", () => {
    const resolution: WorktreeSourceResolution = {
      kind: "fetching",
      remoteName: "origin",
      branch: "development",
    };
    expect(describeWorktreeSource(resolution, now)).toEqual({
      label: "Fetching origin/development…",
    });
  });

  it("produces actionable copy for a rejected fetch with no silent local fallback", () => {
    const resolution: WorktreeSourceResolution = { kind: "failed", reason: "fetch-rejected" };
    const disclosure = describeWorktreeSource(resolution, now);
    expect(disclosure?.label).toBe("Fetch failed");
    expect(disclosure?.detail).toContain("retry");
  });

  it("produces distinct actionable copy for the credential-safe failure reasons", () => {
    expect(
      describeWorktreeSource({ kind: "failed", reason: "remote-unavailable" }, now)?.label,
    ).toBe("Remote unavailable");
    expect(
      describeWorktreeSource({ kind: "failed", reason: "fetch-rejected" }, now)?.detail,
    ).toContain("credentials");
    expect(describeWorktreeSource({ kind: "failed", reason: "unavailable" }, now)?.label).toBe(
      "Source unavailable",
    );
  });

  it("returns nothing for the idle state", () => {
    expect(describeWorktreeSource({ kind: "idle" }, now)).toBeUndefined();
  });
});

describe("canUseCachedSnapshot", () => {
  it("is eligible only when the snapshot carries remote, branch, SHA, and fetch time", () => {
    const eligible = canUseCachedSnapshot(
      {
        remoteName: "origin",
        branch: "development",
        resolvedHead: FULL_SHA,
        fetchedAt: FETCHED_AT,
      },
      now,
    );
    expect(eligible.eligible).toBe(true);
    if (eligible.eligible) {
      expect(eligible.disclosure.label).toBe("origin/development · a1b2c3d");
      expect(eligible.disclosure.detail).toBe("fetched 5m ago");
    }
  });

  it("is not eligible when the SHA is missing", () => {
    expect(
      canUseCachedSnapshot(
        { remoteName: "origin", branch: "development", fetchedAt: FETCHED_AT },
        now,
      ).eligible,
    ).toBe(false);
  });

  it("is not eligible when the fetch time is missing so age cannot be shown", () => {
    expect(
      canUseCachedSnapshot(
        { remoteName: "origin", branch: "development", resolvedHead: FULL_SHA },
        now,
      ).eligible,
    ).toBe(false);
  });
});

describe("worktreePreviewToResolution", () => {
  it("carries the server-resolved origin SHA and fetch time through unchanged", () => {
    expect(
      worktreePreviewToResolution(
        decodeCodeWorktreeSourcePreview({
          kind: "origin",
          remoteName: "origin",
          branch: "development",
          resolvedHead: FULL_SHA,
          fetchedAt: FETCHED_AT,
        }),
      ),
    ).toEqual({
      kind: "origin",
      remoteName: "origin",
      branch: "development",
      resolvedHead: FULL_SHA,
      fetchedAt: FETCHED_AT,
    });
  });

  it("maps a local preview and a typed failure without inventing a SHA", () => {
    expect(
      worktreePreviewToResolution(
        decodeCodeWorktreeSourcePreview({
          kind: "local",
          branch: "development",
          resolvedHead: FULL_SHA,
        }),
      ),
    ).toEqual({ kind: "local", branch: "development", resolvedHead: FULL_SHA });
    expect(
      worktreePreviewToResolution(
        decodeCodeWorktreeSourcePreview({ kind: "failed", reason: "fetch-rejected" }),
      ),
    ).toEqual({ kind: "failed", reason: "fetch-rejected" });
  });
});
