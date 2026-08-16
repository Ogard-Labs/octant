import {
  decodeBindingRevisionId,
  decodeCodeRepositoryId,
  decodeProjectId,
  decodeWindowId,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  MANAGED_ROOT_GRANT_TTL_MS,
  ManagedRootGrantError,
  ManagedRootGrantStore,
} from "./managedRootGrantStore";

const firstWindow = decodeWindowId("00000000-0000-4000-8000-000000000511");
const secondWindow = decodeWindowId("00000000-0000-4000-8000-000000000512");
const firstProject = decodeProjectId("00000000-0000-4000-8000-000000000513");
const secondProject = decodeProjectId("00000000-0000-4000-8000-000000000514");
const firstRevision = decodeBindingRevisionId("00000000-0000-4000-8000-000000000515");
const secondRevision = decodeBindingRevisionId("00000000-0000-4000-8000-000000000516");
const firstRepository = decodeCodeRepositoryId(`repo_${"a".repeat(64)}`);
const secondRepository = decodeCodeRepositoryId(`repo_${"b".repeat(64)}`);
const firstParent = {
  canonicalPath: "/private/tmp/parent",
  identity: { device: "10", inode: "20" },
} as const;
const secondParent = {
  canonicalPath: "/private/tmp/other-parent",
  identity: { device: "10", inode: "21" },
} as const;
const firstTargetPath = "/private/tmp/parent/.octant-worktrees/repo/thread";
const secondTargetPath = "/private/tmp/parent/.octant-worktrees/repo/other-thread";

describe("ManagedRootGrantStore", () => {
  it("issues an in-memory one-use grant bound to its exact managed-root creation target", () => {
    const store = new ManagedRootGrantStore(() => "00000000-0000-4000-8000-000000000517");
    const grant = store.issue({
      windowId: firstWindow,
      projectId: firstProject,
      bindingRevisionId: firstRevision,
      repositoryId: firstRepository,
      parent: firstParent,
      targetPath: firstTargetPath,
      now: 1_000,
    });

    expect(grant).toEqual({
      grantId: "00000000-0000-4000-8000-000000000517",
      expiresAt: 1_000 + MANAGED_ROOT_GRANT_TTL_MS,
    });
    expect(
      store.consume({
        grantId: grant.grantId,
        authenticatedWindowId: firstWindow,
        projectId: firstProject,
        bindingRevisionId: firstRevision,
        repositoryId: firstRepository,
        parent: firstParent,
        targetPath: firstTargetPath,
        now: 1_001,
      }),
    ).toEqual({
      parent: firstParent,
      targetPath: firstTargetPath,
    });
    expect(() =>
      store.consume({
        grantId: grant.grantId,
        authenticatedWindowId: firstWindow,
        projectId: firstProject,
        bindingRevisionId: firstRevision,
        repositoryId: firstRepository,
        parent: firstParent,
        targetPath: firstTargetPath,
        now: 1_002,
      }),
    ).toThrow(ManagedRootGrantError);
  });

  it("rejects forged grant context without consuming the valid local confirmation", () => {
    const store = new ManagedRootGrantStore(() => "00000000-0000-4000-8000-000000000517");
    const grant = store.issue({
      windowId: firstWindow,
      projectId: firstProject,
      bindingRevisionId: firstRevision,
      repositoryId: firstRepository,
      parent: firstParent,
      targetPath: firstTargetPath,
      now: 0,
    });

    for (const attempt of [
      { authenticatedWindowId: secondWindow },
      { projectId: secondProject },
      { bindingRevisionId: secondRevision },
      { repositoryId: secondRepository },
      { parent: secondParent },
      { targetPath: secondTargetPath },
      { grantId: "00000000-0000-4000-8000-000000000518" },
    ] as const) {
      expect(() =>
        store.consume({
          grantId: grant.grantId,
          authenticatedWindowId: firstWindow,
          projectId: firstProject,
          bindingRevisionId: firstRevision,
          repositoryId: firstRepository,
          parent: firstParent,
          targetPath: firstTargetPath,
          now: 1,
          ...attempt,
        }),
      ).toThrow(ManagedRootGrantError);
    }

    expect(
      store.consume({
        grantId: grant.grantId,
        authenticatedWindowId: firstWindow,
        projectId: firstProject,
        bindingRevisionId: firstRevision,
        repositoryId: firstRepository,
        parent: firstParent,
        targetPath: firstTargetPath,
        now: 2,
      }),
    ).toEqual({ parent: firstParent, targetPath: firstTargetPath });
  });

  it("expires the grant at its short-lived boundary", () => {
    const store = new ManagedRootGrantStore(() => "00000000-0000-4000-8000-000000000517");
    const grant = store.issue({
      windowId: firstWindow,
      projectId: firstProject,
      bindingRevisionId: firstRevision,
      repositoryId: firstRepository,
      parent: firstParent,
      targetPath: firstTargetPath,
      now: 0,
    });

    expect(() =>
      store.consume({
        grantId: grant.grantId,
        authenticatedWindowId: firstWindow,
        projectId: firstProject,
        bindingRevisionId: firstRevision,
        repositoryId: firstRepository,
        parent: firstParent,
        targetPath: firstTargetPath,
        now: MANAGED_ROOT_GRANT_TTL_MS,
      }),
    ).toThrow(ManagedRootGrantError);
  });

  it("revokes grants when their desktop window or Project binding is revoked", () => {
    const ids = ["00000000-0000-4000-8000-000000000517", "00000000-0000-4000-8000-000000000518"];
    const store = new ManagedRootGrantStore(() => ids.shift()!);
    const first = store.issue({
      windowId: firstWindow,
      projectId: firstProject,
      bindingRevisionId: firstRevision,
      repositoryId: firstRepository,
      parent: firstParent,
      targetPath: firstTargetPath,
      now: 0,
    });
    const second = store.issue({
      windowId: secondWindow,
      projectId: secondProject,
      bindingRevisionId: secondRevision,
      repositoryId: secondRepository,
      parent: secondParent,
      targetPath: secondTargetPath,
      now: 0,
    });

    store.revokeWindow(firstWindow);
    expect(() =>
      store.consume({
        grantId: first.grantId,
        authenticatedWindowId: firstWindow,
        projectId: firstProject,
        bindingRevisionId: firstRevision,
        repositoryId: firstRepository,
        parent: firstParent,
        targetPath: firstTargetPath,
        now: 1,
      }),
    ).toThrow(ManagedRootGrantError);

    store.revokeProjectBinding(secondProject, secondRevision);
    expect(() =>
      store.consume({
        grantId: second.grantId,
        authenticatedWindowId: secondWindow,
        projectId: secondProject,
        bindingRevisionId: secondRevision,
        repositoryId: secondRepository,
        parent: secondParent,
        targetPath: secondTargetPath,
        now: 1,
      }),
    ).toThrow(ManagedRootGrantError);
  });

  describe("monotonic clamp", () => {
    function monotonicClampNow(): (wallClockMs: number) => number {
      let highWaterMark = 0;
      return (wallClockMs: number) => {
        highWaterMark = Math.max(highWaterMark, wallClockMs);
        return highWaterMark;
      };
    }

    it("cannot revive an expired grant with a backward wall-clock jump", () => {
      const clampNow = monotonicClampNow();
      const store = new ManagedRootGrantStore(
        () => "00000000-0000-4000-8000-000000000517",
        clampNow,
      );
      const grant = store.issue({
        windowId: firstWindow,
        projectId: firstProject,
        bindingRevisionId: firstRevision,
        repositoryId: firstRepository,
        parent: firstParent,
        targetPath: firstTargetPath,
        now: 1_000,
      });
      // Real time legitimately advances past the grant's expiry and is
      // observed by the shared clamp.
      clampNow(1_000 + MANAGED_ROOT_GRANT_TTL_MS + 1);
      // Host wall clock then rolls back to a raw reading that is, at face
      // value, still inside the original TTL window.
      expect(() =>
        store.consume({
          grantId: grant.grantId,
          authenticatedWindowId: firstWindow,
          projectId: firstProject,
          bindingRevisionId: firstRevision,
          repositoryId: firstRepository,
          parent: firstParent,
          targetPath: firstTargetPath,
          now: 1_000,
        }),
      ).toThrow(ManagedRootGrantError);
    });

    it("refuses to mint a managed-root grant while clock recovery is required", () => {
      const store = new ManagedRootGrantStore(
        () => "00000000-0000-4000-8000-000000000517",
        (now) => now,
        () => "recovery-required",
      );

      const failure = (() => {
        try {
          store.issue({
            windowId: firstWindow,
            projectId: firstProject,
            bindingRevisionId: firstRevision,
            repositoryId: firstRepository,
            parent: firstParent,
            targetPath: firstTargetPath,
            now: 1_000,
          });
        } catch (error) {
          return error;
        }
        return undefined;
      })();

      expect(failure).toMatchObject({
        category: "unavailable",
        message: "Managed-root grant issuance is unavailable while host time recovery is required.",
      });
    });
  });
});
