import {
  LOCAL_HOST_ID,
  type ChatThread,
  type CodeCheckoutIdentity,
  type CodeThread,
  type WorkThread,
  type ProductSurfaceSettings,
  type ProjectBootstrap,
  type WindowId,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { ZenThreadCatalog } from "./zenThreadCatalog";

const ids = {
  window: "00000000-0000-4000-8000-000000000001" as WindowId,
  chatProject: "00000000-0000-4000-8000-000000000011",
  workProject: "00000000-0000-4000-8000-000000000012",
  codeProject: "00000000-0000-4000-8000-000000000013",
  archivedProject: "00000000-0000-4000-8000-000000000014",
  chatThread: "00000000-0000-4000-8000-000000000021",
  workThread: "00000000-0000-4000-8000-000000000022",
  codeThread: "00000000-0000-4000-8000-000000000023",
  hiddenThread: "00000000-0000-4000-8000-000000000024",
  binding: "00000000-0000-4000-8000-000000000031",
  repository: "00000000-0000-4000-8000-000000000032",
  checkout: "00000000-0000-4000-8000-000000000033",
  provider: "00000000-0000-4000-8000-000000000034",
} as const;

const timestamp = "2026-07-28T12:00:00.000Z";

function projectBootstrap(): ProjectBootstrap {
  return {
    active: [
      project(ids.chatProject, "chat", "Release"),
      project(ids.workProject, "work", "Research"),
      project(ids.codeProject, "code", "Octant"),
    ],
    archived: [project(ids.archivedProject, "chat", "Archived")],
    availability: [
      { projectId: ids.workProject, status: "available", observedAt: timestamp },
      { projectId: ids.codeProject, status: "available", observedAt: timestamp },
    ],
    memory: [],
  } as unknown as ProjectBootstrap;
}

function project(id: string, type: "chat" | "work" | "code", name: string) {
  return {
    id,
    type,
    name,
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(type === "chat" ? {} : { binding: { canonicalRoot: `/tmp/${name}` } }),
    ...(type === "code" ? { codeAccessPersistence: "current-session" } : {}),
  };
}

function chatThread(id: string = ids.chatThread, projectId: string = ids.chatProject): ChatThread {
  return {
    id,
    projectId,
    title: "Release blocker",
    lifecycle: "active",
    providerInstanceId: ids.provider,
    modelId: "model-local",
    researchEnabled: false,
    researchRouting: "automatic",
    personalityInstructions: "Be concise.",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as unknown as ChatThread;
}

function workThread(): WorkThread {
  return {
    id: ids.workThread,
    projectId: ids.workProject,
    title: "Release blocker",
    lifecycle: "archived",
    providerInstanceId: ids.provider,
    modelId: "model-local",
    version: 1,
    createdAt: timestamp,
    updatedAt: "2026-07-28T12:01:00.000Z",
  } as unknown as WorkThread;
}

function codeThread(): CodeThread {
  return {
    id: ids.codeThread,
    projectId: ids.codeProject,
    bindingRevisionId: ids.binding,
    repositoryId: ids.repository,
    checkoutId: ids.checkout,
    title: "Release blocker",
    lifecycle: "waiting",
    providerInstanceId: ids.provider,
    modelId: "model-local",
    executionPolicy: "approval-gated",
    permissionPersistence: "session-only",
    deliveryTarget: {
      branchIntent: "feature/release",
      remoteName: "origin",
      proposedBaseRepository: "octant",
      proposedBaseBranch: "development",
      outcomeKind: "opened-pr",
      confirmedAt: timestamp,
    },
    version: 1,
    createdAt: timestamp,
    updatedAt: "2026-07-28T12:02:00.000Z",
  } as unknown as CodeThread;
}

function checkout(): CodeCheckoutIdentity {
  return {
    id: ids.checkout,
    repositoryId: ids.repository,
    kind: "existing-worktree",
    availability: "available",
    head: { kind: "branch", name: "development", oid: "a".repeat(40) },
    observedAt: timestamp,
  } as unknown as CodeCheckoutIdentity;
}

function catalog(
  options: {
    readonly settings?: ProductSurfaceSettings;
    readonly projects?: ProjectBootstrap;
    readonly codeCheckout?: CodeCheckoutIdentity;
  } = {},
) {
  return new ZenThreadCatalog({
    localHostId: LOCAL_HOST_ID,
    localHostDisplayName: "This computer",
    readSettings: () => options.settings ?? { chatEnabled: true, workEnabled: true },
    readProjects: async () => options.projects ?? projectBootstrap(),
    readChatThreads: () => [chatThread(), chatThread(ids.hiddenThread, ids.archivedProject)],
    readWorkThreads: () => [workThread()],
    readCodeThreads: () => [codeThread()],
    readCodeCheckout: () => options.codeCheckout ?? checkout(),
  });
}

describe("ZenThreadCatalog", () => {
  it("aggregates source-qualified duplicate titles across authorized Projects and modes", async () => {
    const entries = await catalog().search(ids.window, "release blocker");

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.catalogRef)).toEqual([
      `code:${ids.codeThread}`,
      `work:${ids.workThread}`,
      `chat:${ids.chatThread}`,
    ]);
    expect(entries.map((entry) => [entry.mode, entry.projectLabel, entry.status])).toEqual([
      ["code", "Octant", "waiting"],
      ["work", "Research", "archived"],
      ["chat", "Release", "active"],
    ]);
    expect(entries.every((entry) => entry.hostId === LOCAL_HOST_ID)).toBe(true);
  });

  it("omits disabled modes and inaccessible project/thread metadata", async () => {
    const projects = projectBootstrap();
    const entries = await catalog({
      settings: { chatEnabled: true, workEnabled: false },
      projects: {
        ...projects,
        availability: projects.availability.map((availability) =>
          availability.projectId === ids.codeProject
            ? { ...availability, status: "unavailable" as const, reason: "Relink required." }
            : availability,
        ),
      },
    }).search(ids.window);

    expect(entries.map((entry) => entry.catalogRef)).toEqual([`chat:${ids.chatThread}`]);
    expect(JSON.stringify(entries)).not.toContain(ids.hiddenThread);
    expect(JSON.stringify(entries)).not.toContain(ids.workThread);
    expect(JSON.stringify(entries)).not.toContain(ids.codeThread);
  });
});
