import { describe, expect, it, vi } from "vitest";
import type { GitObservation } from "./gitObservationPort";
import { GitService } from "./gitService";

describe("GitService", () => {
  it("rejects stale state, unlisted staging, and an inexact staged commit summary", async () => {
    const observation = readyObservation();
    const mutation = mutationPort();
    const service = new GitService({ observe: vi.fn(async () => observation) }, mutation);

    await expect(
      service.stage({
        checkoutId: "checkout-1",
        checkoutRoot: "/repo",
        paths: ["file.txt"],
        expectedStateToken: "stale",
      }),
    ).resolves.toEqual({ status: "rejected", reason: "stale-state" });
    await expect(
      service.stage({
        checkoutId: "checkout-1",
        checkoutRoot: "/repo",
        paths: ["other.txt"],
        expectedStateToken: observation.stateToken,
      }),
    ).resolves.toEqual({ status: "rejected", reason: "unlisted-path" });
    await expect(
      service.commit({
        checkoutId: "checkout-1",
        checkoutRoot: "/repo",
        message: "commit",
        expectedStateToken: observation.stateToken,
        stagedSummary: [],
      }),
    ).resolves.toEqual({
      status: "rejected",
      reason: "staged-summary-mismatch",
    });
    expect(mutation.stage).not.toHaveBeenCalled();
    expect(mutation.commit).not.toHaveBeenCalled();
  });

  it("refuses to discard anything the observation did not report as a tracked change", async () => {
    const observation = {
      ...readyObservation(),
      statusEntries: [
        { path: "file.txt", index: "M", worktree: " " },
        { path: "new.txt", index: "?", worktree: "?" },
      ],
      changedPaths: ["file.txt", "new.txt"],
    };
    const mutation = mutationPort();
    const service = new GitService({ observe: vi.fn(async () => observation) }, mutation);
    const base = { checkoutId: "checkout-1", checkoutRoot: "/repo" } as const;

    await expect(
      service.discard({ ...base, paths: ["file.txt"], expectedStateToken: "stale" }),
    ).resolves.toEqual({ status: "rejected", reason: "stale-state" });
    await expect(
      service.discard({
        ...base,
        paths: ["absent.txt"],
        expectedStateToken: observation.stateToken,
      }),
    ).resolves.toEqual({ status: "rejected", reason: "unlisted-path" });
    // An untracked file has nothing in HEAD to restore, so discarding it could
    // only mean deleting it. That is not what this command does.
    await expect(
      service.discard({ ...base, paths: ["new.txt"], expectedStateToken: observation.stateToken }),
    ).resolves.toEqual({ status: "rejected", reason: "untracked-path" });
    expect(mutation.discard).not.toHaveBeenCalled();

    await expect(
      service.discard({ ...base, paths: ["file.txt"], expectedStateToken: observation.stateToken }),
    ).resolves.toEqual({ status: "applied" });
    expect(mutation.discard).toHaveBeenCalledWith(
      { checkoutRoot: "/repo", paths: ["file.txt"] },
      undefined,
    );
  });

  it("requires approval or Full access and a named branch with an observed confirmed remote", async () => {
    const observation = readyObservation();
    const mutation = mutationPort();
    const service = new GitService({ observe: vi.fn(async () => observation) }, mutation);
    const base = {
      checkoutId: "checkout-1",
      checkoutRoot: "/repo",
      remote: "origin",
      localRef: "refs/heads/main",
      remoteRef: "refs/heads/main",
      confirmation: {
        remote: "origin",
        refspec: "refs/heads/main:refs/heads/main",
      },
      expectedHeadOid: headOid,
      expectedStateToken: observation.stateToken,
    } as const;

    await expect(service.push({ ...base, authority: "approval-gated" })).resolves.toEqual({
      status: "rejected",
      reason: "approval-required",
    });
    await expect(service.push({ ...base, authority: "approved" })).resolves.toEqual({
      status: "applied",
    });
    const detached = {
      ...observation,
      head: { kind: "detached" as const, oid: headOid },
    };
    const detachedService = new GitService(
      { observe: vi.fn(async () => detached) },
      mutationPort(),
    );
    await expect(detachedService.push({ ...base, authority: "full-access" })).resolves.toEqual({
      status: "rejected",
      reason: "detached-head",
    });

    // A branch with no commits yet is refused for what it is, not reported as a
    // stale observation because its head carries no object.
    const unborn = { ...observation, head: { kind: "unborn" as const, name: "main" } };
    const unbornMutation = mutationPort();
    const unbornService = new GitService({ observe: vi.fn(async () => unborn) }, unbornMutation);
    await expect(unbornService.push({ ...base, authority: "full-access" })).resolves.toEqual({
      status: "rejected",
      reason: "unborn-head",
    });
    expect(unbornMutation.push).not.toHaveBeenCalled();
  });

  it("serializes mutations for the same checkout", async () => {
    const observation = readyObservation();
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const stage = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return { status: "applied" as const };
    });
    const mutation = { ...mutationPort(), stage };
    const service = new GitService({ observe: vi.fn(async () => observation) }, mutation);
    const input = {
      checkoutId: "checkout-1",
      checkoutRoot: "/repo",
      paths: ["file.txt"],
      expectedStateToken: observation.stateToken,
    };

    const first = service.stage(input);
    const second = service.stage(input);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(stage).toHaveBeenCalledTimes(1);
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()!();
    await Promise.all([first, second]);

    expect(maximumActive).toBe(1);
  });

  it("uses commits for checkpoints and only reverts an explicit commit from a clean expected state", async () => {
    const dirty = readyObservation();
    const mutation = mutationPort();
    const service = new GitService({ observe: vi.fn(async () => dirty) }, mutation);

    await expect(
      service.checkpoint({
        checkoutId: "checkout-1",
        checkoutRoot: "/repo",
        message: "Checkpoint",
        expectedStateToken: dirty.stateToken,
        stagedSummary: dirty.stagedSummary,
      }),
    ).resolves.toMatchObject({ status: "applied" });
    await expect(
      service.revert({
        checkoutId: "checkout-1",
        checkoutRoot: "/repo",
        oid: headOid,
        expectedStateToken: dirty.stateToken,
      }),
    ).resolves.toEqual({ status: "rejected", reason: "dirty-checkout" });

    const clean = {
      ...dirty,
      statusEntries: [],
      changedPaths: [],
      stagedSummary: [],
      stateToken: "clean-token",
    };
    const cleanMutation = mutationPort();
    const cleanService = new GitService({ observe: vi.fn(async () => clean) }, cleanMutation);
    await expect(
      cleanService.revert({
        checkoutId: "checkout-1",
        checkoutRoot: "/repo",
        oid: headOid,
        expectedStateToken: clean.stateToken,
      }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(cleanMutation.revertCommit).toHaveBeenCalledWith(
      { checkoutRoot: "/repo", oid: headOid },
      undefined,
    );
  });
});

const headOid = "a".repeat(40);

function readyObservation(): GitObservation {
  const staged = { path: "file.txt", index: "M", worktree: " " };
  return {
    status: "ready",
    checkoutRoot: "/repo",
    head: { kind: "branch", name: "main", oid: headOid },
    statusEntries: [staged],
    changedPaths: ["file.txt"],
    stagedSummary: [staged],
    diff: { text: "", byteLength: 0, truncated: false },
    remotes: [{ name: "origin", fetchUrl: "/remote.git", pushUrl: "/remote.git" }],
    upstream: { remote: "origin", mergeRef: "refs/heads/main" },
    worktrees: [],
    stateToken: "state-token",
  };
}

function mutationPort() {
  return {
    stage: vi.fn(async () => ({ status: "applied" as const })),
    commit: vi.fn(async () => ({
      status: "applied" as const,
      oid: "b".repeat(40),
    })),
    push: vi.fn(async () => ({ status: "applied" as const })),
    discard: vi.fn(async () => ({ status: "applied" as const })),
    revertCommit: vi.fn(async () => ({ status: "applied" as const, oid: "c".repeat(40) })),
  };
}
