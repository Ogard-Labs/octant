import { describe, expect, it, vi } from "vitest";
import type { GitObservation } from "./gitObservationPort";
import type { GitMutationResult } from "./gitMutationPort";
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

  it("only unstages a path the observation reports as staged", async () => {
    const observation = {
      ...readyObservation(),
      statusEntries: [
        { path: "file.txt", index: "M", worktree: " " },
        { path: "unstaged.txt", index: " ", worktree: "M" },
      ],
      changedPaths: ["file.txt", "unstaged.txt"],
      stagedSummary: [{ path: "file.txt", index: "M", worktree: " " }],
    };
    const mutation = mutationPort();
    const service = new GitService({ observe: vi.fn(async () => observation) }, mutation);
    const base = { checkoutId: "checkout-1", checkoutRoot: "/repo" } as const;

    await expect(
      service.unstage({ ...base, paths: ["file.txt"], expectedStateToken: "stale" }),
    ).resolves.toEqual({ status: "rejected", reason: "stale-state" });
    // Changed but not staged: taking it out of the index would be a no-op that
    // reads to the user as if something happened.
    await expect(
      service.unstage({
        ...base,
        paths: ["unstaged.txt"],
        expectedStateToken: observation.stateToken,
      }),
    ).resolves.toEqual({ status: "rejected", reason: "unlisted-path" });
    expect(mutation.unstage).not.toHaveBeenCalled();

    await expect(
      service.unstage({ ...base, paths: ["file.txt"], expectedStateToken: observation.stateToken }),
    ).resolves.toEqual({ status: "applied" });
    expect(mutation.unstage).toHaveBeenCalledWith(
      { checkoutRoot: "/repo", paths: ["file.txt"] },
      undefined,
    );
  });

  it("accepts both halves of a staged rename when unstaging", async () => {
    const observation = {
      ...readyObservation(),
      statusEntries: [{ path: "new.txt", originalPath: "old.txt", index: "R", worktree: " " }],
      changedPaths: ["new.txt", "old.txt"],
      stagedSummary: [{ path: "new.txt", originalPath: "old.txt", index: "R", worktree: " " }],
    };
    const mutation = mutationPort();
    const service = new GitService({ observe: vi.fn(async () => observation) }, mutation);

    // One staged entry occupies two paths, and Git needs both to take the
    // rename out of the index instead of half-applying it.
    await expect(
      service.unstage({
        checkoutId: "checkout-1",
        checkoutRoot: "/repo",
        paths: ["new.txt", "old.txt"],
        expectedStateToken: observation.stateToken,
      }),
    ).resolves.toEqual({ status: "applied" });
    expect(mutation.unstage).toHaveBeenCalledWith(
      { checkoutRoot: "/repo", paths: ["new.txt", "old.txt"] },
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

  it("checkpoints the working tree without committing, and records what a restore replaced", async () => {
    const observation = readyObservation();
    const mutation = mutationPort();
    const service = new GitService({ observe: vi.fn(async () => observation) }, mutation);
    const base = { checkoutId: "checkout-1", checkoutRoot: "/repo" } as const;
    const snapshot = { worktree: "f".repeat(40), index: "0".repeat(40) };

    const captured = await service.checkpoint(base);
    expect(captured).toMatchObject({ status: "captured" });
    // A checkpoint records content and nothing else: it must not produce a
    // commit, which would put a turn's undo point into the branch history.
    expect(mutation.commit).not.toHaveBeenCalled();
    // The checkout names the anchors, so one checkout's cleanup cannot reach a
    // sibling worktree's checkpoints in the ref store they share.
    expect(mutation.snapshotWorkingTree).toHaveBeenCalledWith(
      { checkoutRoot: "/repo", checkoutId: "checkout-1" },
      undefined,
    );
    // A turn's checkpoint stays anchored for as long as the checkout does.
    expect(mutation.releaseCheckpoint).not.toHaveBeenCalled();

    // The state a restore overwrites is checkpointed first and handed back, so
    // the user can undo the restore itself.
    await expect(service.restoreCheckpoint({ ...base, snapshot })).resolves.toEqual({
      status: "applied",
      undo: { worktree: "d".repeat(40), index: "e".repeat(40), head: "a".repeat(40) },
    });
    expect(mutation.restoreWorkingTree).toHaveBeenCalledWith(
      { checkoutRoot: "/repo", snapshot },
      undefined,
    );
  });

  it("hands back the undo point when a restore fails part-way, but not when it is refused", async () => {
    const observation = readyObservation();
    const undo = { worktree: "d".repeat(40), index: "e".repeat(40), head: "a".repeat(40) };
    const base = { checkoutId: "checkout-1", checkoutRoot: "/repo" } as const;
    const snapshot = { worktree: "f".repeat(40), index: "0".repeat(40) };

    // A command the timeout killed may already have moved files, so the only
    // recovery point has to travel with the failure.
    const failing = {
      ...mutationPort(),
      restoreWorkingTree: vi.fn(async (): Promise<GitMutationResult> => ({ status: "failed" })),
    };
    await expect(
      new GitService({ observe: vi.fn(async () => observation) }, failing).restoreCheckpoint({
        ...base,
        snapshot,
      }),
    ).resolves.toEqual({ status: "failed", undo });
    // The undo point travels back, so its anchor has to stay: releasing it
    // would hand the caller a restore point Git is free to collect.
    expect(failing.releaseCheckpoint).not.toHaveBeenCalled();

    // A rejection is refused before anything is written, so there is nothing
    // to undo and offering one would invite an unnecessary overwrite.
    const rejecting = {
      ...mutationPort(),
      restoreWorkingTree: vi.fn(
        async (): Promise<GitMutationResult> => ({ status: "rejected", reason: "invalid-commit" }),
      ),
    };
    await expect(
      new GitService({ observe: vi.fn(async () => observation) }, rejecting).restoreCheckpoint({
        ...base,
        snapshot,
      }),
    ).resolves.toEqual({ status: "rejected", reason: "invalid-commit" });
    // Nobody was handed that capture, so it must not keep pinning trees for
    // the rest of the checkout's life.
    expect(rejecting.releaseCheckpoint).toHaveBeenCalledWith(
      {
        checkoutRoot: "/repo",
        checkoutId: "checkout-1",
        anchorId: "3f1b0c9a-5d42-4e77-9a1c-6b2e8f0d4c31",
      },
      undefined,
    );
  });

  it("only reverts an explicit commit from a clean expected state", async () => {
    const dirty = readyObservation();
    const mutation = mutationPort();
    const service = new GitService({ observe: vi.fn(async () => dirty) }, mutation);

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
    unstage: vi.fn(async () => ({ status: "applied" as const })),
    commit: vi.fn(async () => ({
      status: "applied" as const,
      oid: "b".repeat(40),
    })),
    push: vi.fn(async () => ({ status: "applied" as const })),
    discard: vi.fn(async () => ({ status: "applied" as const })),
    revertCommit: vi.fn(async () => ({ status: "applied" as const, oid: "c".repeat(40) })),
    snapshotWorkingTree: vi.fn(async () => ({
      status: "captured" as const,
      snapshot: { worktree: "d".repeat(40), index: "e".repeat(40), head: "a".repeat(40) },
      anchorId: "3f1b0c9a-5d42-4e77-9a1c-6b2e8f0d4c31",
    })),
    restoreWorkingTree: vi.fn(async () => ({ status: "applied" as const })),
    releaseCheckpoint: vi.fn(async () => {}),
  };
}
