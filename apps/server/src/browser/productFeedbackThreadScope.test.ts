import {
  decodeCodeThread,
  decodeProject,
  decodeWindowId,
  decodeWorkThread,
  type CodeThread,
  type Project,
  type WorkThread,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createProductFeedbackThreadScope } from "./productFeedbackThreadScope";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-11-03T10:00:00.000Z";
function fixture(mode: "work" | "code") {
  const windowId = decodeWindowId(id(1)),
    windows = new WindowAuthorityStore();
  const capability = "A".repeat(43);
  windows.register({ windowId, capability, now: Date.parse(now) });
  const common = {
    id: id(2),
    projectId: id(3),
    bindingRevisionId: id(4),
    title: "Task",
    lifecycle: "active",
    providerInstanceId: id(5),
    modelId: "model",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  let work: WorkThread | undefined = mode === "work" ? decodeWorkThread(common) : undefined;
  let code: CodeThread | undefined =
    mode === "code"
      ? decodeCodeThread({
          ...common,
          repositoryId: `repo_${"a".repeat(64)}`,
          checkoutId: id(6),
          executionPolicy: "approval-gated",
          permissionPersistence: "current-session",
          deliveryTarget: {
            branchIntent: "feature/task",
            remoteName: "origin",
            proposedBaseRepository: "org/repo",
            proposedBaseBranch: "main",
            outcomeKind: "opened-pr",
            confirmedAt: now,
          },
        })
      : undefined;
  let project: Project | undefined = decodeProject({
    id: id(3),
    type: mode,
    name: "Project",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: now,
    updatedAt: now,
    binding: { canonicalRoot: "/workspace/project" },
    bindingHistory: [
      {
        revisionId: id(4),
        revision: 1,
        currentBinding: { canonicalRoot: "/workspace/project" },
        actor: { kind: "local-user", actorId: id(1) },
        changedAt: now,
      },
    ],
    ...(mode === "code" ? { codeAccessPersistence: "current-session" } : {}),
  });
  let holds = true;
  const resolve = createProductFeedbackThreadScope({
    readCodeThread: (key) => (key === id(2) ? code : undefined),
    readWorkThread: (key) => (key === id(2) ? work : undefined),
    readProject: () => project,
    canUseWindow: (candidate) => {
      try {
        return candidate === windows.authenticate(capability, Date.parse(now));
      } catch {
        return false;
      }
    },
    windowHoldsProject: () => holds,
  });
  return {
    resolve,
    windowId,
    windows,
    revokeProject: () => {
      holds = false;
    },
    rebind: () => {
      if (project?.type === mode)
        project = decodeProject({
          ...project,
          binding: { canonicalRoot: "/workspace/replacement" },
        });
    },
    remove: () => {
      work = undefined;
      code = undefined;
    },
    ambiguous: () => {
      work = decodeWorkThread(common);
      code = decodeCodeThread({
        ...common,
        repositoryId: `repo_${"a".repeat(64)}`,
        checkoutId: id(6),
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
        deliveryTarget: {
          branchIntent: "feature/task",
          remoteName: "origin",
          proposedBaseRepository: "org/repo",
          proposedBaseBranch: "main",
          outcomeKind: "opened-pr",
          confirmedAt: now,
        },
      });
    },
    archive: () => {
      if (work !== undefined) work = decodeWorkThread({ ...work, lifecycle: "archived" });
      if (code !== undefined) code = decodeCodeThread({ ...code, lifecycle: "archived" });
    },
  };
}

describe("production feedback task scope", () => {
  it.each(["work", "code"] as const)(
    "resolves host mode and retains fresh raw window and Project binding for %s",
    (mode) => {
      const f = fixture(mode),
        original = f.resolve(f.windowId, id(2));
      expect(original?.mode).toBe(mode);
      expect(original?.current()).toBe(true);
      f.rebind();
      expect(original?.current()).toBe(false);
      const latest = f.resolve(f.windowId, id(2));
      expect(latest?.current()).toBe(true);
      f.windows.revoke(f.windowId);
      expect(latest?.current()).toBe(false);
      expect(f.resolve(f.windowId, id(2))).toBeUndefined();
    },
  );
  it.each(["remove", "ambiguous", "archive", "revokeProject"] as const)(
    "rejects %s instead of adopting another destination",
    (change) => {
      const f = fixture("work"),
        original = f.resolve(f.windowId, id(2));
      f[change]();
      expect(original?.current()).toBe(false);
      expect(f.resolve(f.windowId, id(2))).toBeUndefined();
    },
  );
});
