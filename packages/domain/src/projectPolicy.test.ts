import type { UtcTimestamp } from "@octant/contracts/events";
import {
  decodeBindingRevisionId,
  decodeProject,
  decodeProjectId,
  decodeProjectRank,
  type CanonicalProjectBinding,
  type Project,
  type ProjectActor,
} from "@octant/contracts/projects";
import { describe, expect, it, vi } from "vitest";
import {
  ProjectPolicyRejected,
  changeCodeProjectAccess,
  changeCodeProjectPullRequestBackgroundRefresh,
  changeProjectLifecycle,
  compareProjectOrder,
  createProject,
  moveProject,
  rankBetween,
  relinkProject,
  renameProject,
} from "./projectPolicy";

const ids = {
  chat: decodeProjectId("11111111-1111-4111-8111-111111111111"),
  work: decodeProjectId("22222222-2222-4222-8222-222222222222"),
  code: decodeProjectId("33333333-3333-4333-8333-333333333333"),
  later: decodeProjectId("44444444-4444-4444-8444-444444444444"),
  revision1: decodeBindingRevisionId("55555555-5555-4555-8555-555555555555"),
  revision2: decodeBindingRevisionId("66666666-6666-4666-8666-666666666666"),
} as const;

const createdAt = "2026-07-14T08:00:00.000Z" as UtcTimestamp;
const updatedAt = "2026-07-14T09:00:00.000Z" as UtcTimestamp;
const actor = {
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
} as ProjectActor;
const root = { canonicalRoot: "/Users/example/Workspace" } as CanonicalProjectBinding;

function makeProject(
  id: Project["id"],
  rank: string,
  options: {
    readonly type?: Project["type"];
    readonly pinned?: boolean;
    readonly lifecycle?: Project["lifecycle"];
    readonly name?: string;
    readonly binding?: CanonicalProjectBinding;
  } = {},
): Project {
  const type = options.type ?? "chat";
  const common = {
    id,
    name: options.name ?? `Project ${id.slice(0, 4)}`,
    lifecycle: options.lifecycle ?? "active",
    pinned: options.pinned ?? false,
    rank: decodeProjectRank(rank),
    version: 1,
    createdAt,
    updatedAt: createdAt,
  } as const;
  if (type === "chat") return decodeProject({ ...common, type });
  const binding = options.binding ?? root;
  const bound = {
    ...common,
    type,
    binding,
    bindingHistory: [
      {
        revisionId: ids.revision1,
        revision: 1,
        currentBinding: binding,
        actor,
        changedAt: createdAt,
      },
    ],
  } as const;
  return decodeProject(
    type === "code" ? { ...bound, codeAccessPersistence: "current-session" } : bound,
  );
}

describe("Project creation and lifecycle", () => {
  it("creates strict Chat, Work, and Code variants with safe defaults", () => {
    const chat = createProject({
      type: "chat",
      id: ids.chat,
      name: "  Product notes  ",
      rank: decodeProjectRank("0/1"),
      createdAt,
    });
    const work = createProject({
      type: "work",
      id: ids.work,
      name: "Workspace",
      rank: decodeProjectRank("0/1"),
      binding: root,
      revisionId: ids.revision1,
      actor,
      createdAt,
    });
    const code = createProject({
      type: "code",
      id: ids.code,
      name: "Repository",
      rank: decodeProjectRank("0/1"),
      binding: root,
      revisionId: ids.revision1,
      actor,
      createdAt,
    });

    expect(chat).toEqual({
      id: ids.chat,
      type: "chat",
      name: "Product notes",
      lifecycle: "active",
      pinned: false,
      rank: decodeProjectRank("0/1"),
      version: 1,
      createdAt,
      updatedAt: createdAt,
    });
    expect(work).toMatchObject({ type: "work", binding: root });
    expect(code).toMatchObject({
      type: "code",
      binding: root,
      codeAccessPersistence: "current-session",
    });
    expect(work.id).not.toBe(code.id);
    expect(work.bindingHistory).not.toBe(code.bindingHistory);
  });

  it("rejects empty names and binding inputs on virtual Chat Projects", () => {
    expect(() =>
      createProject({
        type: "chat",
        id: ids.chat,
        name: "   ",
        rank: decodeProjectRank("0/1"),
        createdAt,
      }),
    ).toThrow(ProjectPolicyRejected);
    expect(() =>
      createProject({
        type: "chat",
        id: ids.chat,
        name: "Chat",
        rank: decodeProjectRank("0/1"),
        binding: root,
        revisionId: ids.revision1,
        actor,
        createdAt,
      } as never),
    ).toThrow(ProjectPolicyRejected);
  });

  it("changes only the canonical Code Project access policy", () => {
    const project = makeProject(ids.code, "0/1", { type: "code" });
    const changed = changeCodeProjectAccess(project, "project-default", updatedAt);
    expect(changed).toMatchObject({
      type: "code",
      codeAccessPersistence: "project-default",
      version: 2,
    });
    expect(() =>
      changeCodeProjectAccess(makeProject(ids.chat, "0/1"), "project-default", updatedAt),
    ).toThrow(ProjectPolicyRejected);
  });

  it("enables background pull-request refresh on a Code Project and bumps its version", () => {
    const project = makeProject(ids.code, "0/1", { type: "code" });
    const enabled = changeCodeProjectPullRequestBackgroundRefresh(project, "enabled", updatedAt);
    expect(enabled).toMatchObject({
      type: "code",
      pullRequestBackgroundRefresh: "enabled",
      version: 2,
    });
    // Absence reads as disabled, so a "disable" of an untouched Project is a
    // no-op the journal must never record.
    expect(() =>
      changeCodeProjectPullRequestBackgroundRefresh(project, "disabled", updatedAt),
    ).toThrow(ProjectPolicyRejected);
    expect(() =>
      changeCodeProjectPullRequestBackgroundRefresh(
        makeProject(ids.chat, "0/1"),
        "enabled",
        updatedAt,
      ),
    ).toThrow(ProjectPolicyRejected);
  });

  it("renames and archives/restores without mutating the previous snapshot or type", () => {
    const original = makeProject(ids.code, "0/1", { type: "code", name: "Old name" });
    const renamed = renameProject(original, "  New name  ", updatedAt);
    const archived = changeProjectLifecycle(renamed, "archived", updatedAt);
    const restored = changeProjectLifecycle(archived, "active", updatedAt);

    expect(renamed).toMatchObject({ name: "New name", type: "code", version: 2 });
    expect(archived).toMatchObject({ lifecycle: "archived", type: "code", version: 3 });
    expect(restored).toMatchObject({ lifecycle: "active", type: "code", version: 4 });
    expect(original).toMatchObject({ name: "Old name", lifecycle: "active", version: 1 });
    expect(() => renameProject(original, "  ", updatedAt)).toThrow(ProjectPolicyRejected);
    expect(() => changeProjectLifecycle(original, "active", updatedAt)).toThrow(
      ProjectPolicyRejected,
    );
  });
});

describe("Project binding relink", () => {
  it("preserves identity, type, memory boundary, and order while appending audit history", () => {
    const original = makeProject(ids.work, "2/3", { type: "work", pinned: true });
    const replacement = { canonicalRoot: "/Users/example/New Workspace" } as const;
    const relinked = relinkProject(original, {
      previousBindingRevision: 1,
      binding: replacement,
      revisionId: ids.revision2,
      actor,
      changedAt: updatedAt,
    });

    expect(relinked).toMatchObject({
      id: original.id,
      type: "work",
      name: original.name,
      lifecycle: original.lifecycle,
      pinned: original.pinned,
      rank: original.rank,
      binding: replacement,
      version: 2,
      updatedAt,
    });
    expect(relinked.bindingHistory).toHaveLength(2);
    expect(relinked.bindingHistory[1]).toEqual({
      revisionId: ids.revision2,
      revision: 2,
      previousBinding: root,
      currentBinding: replacement,
      actor,
      changedAt: updatedAt,
    });
    expect(original.type).toBe("work");
    if (original.type !== "work") throw new Error("expected Work Project");
    expect(original.binding).toEqual(root);
    expect(original.bindingHistory).toHaveLength(1);
  });

  it("rejects Chat relinks, stale binding revisions, and unchanged roots", () => {
    const work = makeProject(ids.work, "0/1", { type: "work" });
    const input = {
      previousBindingRevision: 1,
      binding: { canonicalRoot: "/Users/example/New Workspace" } as CanonicalProjectBinding,
      revisionId: ids.revision2,
      actor,
      changedAt: updatedAt,
    };

    expect(() => relinkProject(makeProject(ids.chat, "0/1"), input)).toThrow(ProjectPolicyRejected);
    expect(() => relinkProject(work, { ...input, previousBindingRevision: 0 })).toThrow(
      ProjectPolicyRejected,
    );
    expect(() => relinkProject(work, { ...input, binding: root })).toThrow(ProjectPolicyRejected);
  });
});

describe("deterministic Project ranks", () => {
  it.each([
    [undefined, undefined, "0/1"],
    ["2/3", undefined, "5/3"],
    [undefined, "2/3", "-1/3"],
    ["1/3", "2/3", "1/2"],
    ["1/2", "2/3", "3/5"],
  ] as const)("places a rank between %s and %s as %s", (left, right, expected) => {
    expect(
      rankBetween(
        left === undefined ? undefined : decodeProjectRank(left),
        right === undefined ? undefined : decodeProjectRank(right),
      ),
    ).toBe(decodeProjectRank(expected));
  });

  it("reduces generated tokens and rejects malformed or non-ascending neighbors", () => {
    expect(rankBetween(decodeProjectRank("1/3"), decodeProjectRank("1/1"))).toBe(
      decodeProjectRank("1/2"),
    );
    expect(() => rankBetween(decodeProjectRank("1/1"), decodeProjectRank("1/1"))).toThrow(
      ProjectPolicyRejected,
    );
    expect(() => rankBetween(decodeProjectRank("2/1"), decodeProjectRank("1/1"))).toThrow(
      ProjectPolicyRejected,
    );
    expect(() => rankBetween("2/4" as never, undefined)).toThrow(ProjectPolicyRejected);
  });

  it("orders pinned first, then rational rank, then stable Project ID", () => {
    const unpinned = makeProject(ids.chat, "-100/1");
    const pinned = makeProject(ids.work, "100/1", { pinned: true });
    const equalA = makeProject(ids.chat, "1/2");
    const equalB = makeProject(ids.later, "1/2");
    const larger = makeProject(ids.code, "2/3");

    expect(compareProjectOrder(pinned, unpinned)).toBeLessThan(0);
    expect(compareProjectOrder(equalA, larger)).toBeLessThan(0);
    expect(compareProjectOrder(equalA, equalB)).toBeLessThan(0);
    expect(compareProjectOrder(equalB, equalA)).toBeGreaterThan(0);
    expect(compareProjectOrder(equalA, equalA)).toBe(0);
  });

  it("uses locale-independent code-unit ordering for equal-rank Project IDs", () => {
    const equalA = makeProject(ids.chat, "1/2");
    const equalB = makeProject(ids.later, "1/2");
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("locale-dependent ordering must not participate in replay");
    });

    try {
      expect(compareProjectOrder(equalA, equalB)).toBe(-1);
      expect(compareProjectOrder(equalB, equalA)).toBe(1);
      expect(compareProjectOrder(equalA, equalA)).toBe(0);
    } finally {
      localeCompare.mockRestore();
    }
  });
});

describe("Project moves", () => {
  it("moves between pin lanes and computes rank only from neighbors in the target lane", () => {
    const current = makeProject(ids.chat, "0/1");
    const before = makeProject(ids.work, "1/3", { pinned: true });
    const after = makeProject(ids.code, "2/3", { pinned: true });
    const moved = moveProject(current, {
      pinned: true,
      beforeProject: before,
      afterProject: after,
      updatedAt,
    });

    expect(moved).toMatchObject({ pinned: true, rank: decodeProjectRank("1/2"), version: 2 });
    expect(current).toMatchObject({ pinned: false, rank: decodeProjectRank("0/1"), version: 1 });
  });

  it("moves from the pinned lane into the unpinned lane", () => {
    const current = makeProject(ids.chat, "5/1", { pinned: true });
    const before = makeProject(ids.work, "-1/1");
    const moved = moveProject(current, {
      pinned: false,
      beforeProject: before,
      updatedAt,
    });

    expect(moved).toMatchObject({ pinned: false, rank: decodeProjectRank("0/1"), version: 2 });
    expect(current).toMatchObject({ pinned: true, rank: decodeProjectRank("5/1"), version: 1 });
  });

  it("rejects the moving Project as either neighbor", () => {
    const current = makeProject(ids.chat, "0/1");

    expect(() =>
      moveProject(current, { pinned: false, beforeProject: current, updatedAt }),
    ).toThrow(ProjectPolicyRejected);
    expect(() => moveProject(current, { pinned: false, afterProject: current, updatedAt })).toThrow(
      ProjectPolicyRejected,
    );
  });

  it("rejects the same neighboring Project on both sides", () => {
    const current = makeProject(ids.chat, "0/1");
    const neighbor = makeProject(ids.work, "1/1");

    expect(() =>
      moveProject(current, {
        pinned: false,
        beforeProject: neighbor,
        afterProject: neighbor,
        updatedAt,
      }),
    ).toThrow(ProjectPolicyRejected);
  });

  it("rejects neighbors from another mode, lifecycle, lane, or invalid order", () => {
    const current = makeProject(ids.chat, "0/1");
    const good = makeProject(ids.work, "1/3");
    const wrongMode = makeProject(ids.code, "2/3", { type: "code" });
    const archived = makeProject(ids.code, "2/3", { lifecycle: "archived" });
    const pinned = makeProject(ids.code, "2/3", { pinned: true });
    const earlier = makeProject(ids.code, "1/4");

    expect(() =>
      moveProject(current, { pinned: false, beforeProject: wrongMode, updatedAt }),
    ).toThrow(ProjectPolicyRejected);
    expect(() =>
      moveProject(current, {
        pinned: false,
        beforeProject: good,
        afterProject: archived,
        updatedAt,
      }),
    ).toThrow(ProjectPolicyRejected);
    expect(() =>
      moveProject(current, { pinned: false, beforeProject: good, afterProject: pinned, updatedAt }),
    ).toThrow(ProjectPolicyRejected);
    expect(() =>
      moveProject(current, {
        pinned: false,
        beforeProject: good,
        afterProject: earlier,
        updatedAt,
      }),
    ).toThrow(ProjectPolicyRejected);
  });

  it("replays concurrent moves deterministically with equal-rank ID tie-breaking", () => {
    const before = makeProject(ids.chat, "0/1");
    const after = makeProject(ids.later, "1/1");
    const first = moveProject(makeProject(ids.work, "2/1"), {
      pinned: false,
      beforeProject: before,
      afterProject: after,
      updatedAt,
    });
    const second = moveProject(makeProject(ids.code, "3/1"), {
      pinned: false,
      beforeProject: before,
      afterProject: after,
      updatedAt,
    });

    expect(first.rank).toBe(decodeProjectRank("1/2"));
    expect(second.rank).toBe(first.rank);
    expect([second, first].sort(compareProjectOrder).map((project) => project.id)).toEqual([
      ids.work,
      ids.code,
    ]);
  });
});
