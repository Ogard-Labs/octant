import { describe, expect, it } from "vitest";
import { decodeHostId, LOCAL_HOST_ID } from "@octant/contracts";
import { ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";
import { ServerBrowserAuthorityResolver, deriveToolHostId } from "./browserAuthorityResolver";

const projectId = "10000000-0000-4000-8000-000000000001";
const threadId = "20000000-0000-4000-8000-000000000001";
const revisionId = "30000000-0000-4000-8000-000000000001";
const checkoutId = "40000000-0000-4000-8000-000000000001";
const providerId = "50000000-0000-4000-8000-000000000001";
const hostId = deriveToolHostId("/octant-data");
const windowId = "70000000-0000-4000-8000-000000000001";
const otherWindowId = "70000000-0000-4000-8000-000000000002";
const baseProject = {
  id: projectId,
  name: "Project",
  lifecycle: "active",
  pinned: false,
  rank: "0/1",
  binding: { canonicalRoot: "/project" },
  bindingHistory: [
    {
      revisionId,
      revision: 1,
      currentBinding: { canonicalRoot: "/project" },
      actor: { kind: "local-user", actorId: "60000000-0000-4000-8000-000000000001" },
      changedAt: "2026-07-27T20:00:00.000Z",
    },
  ],
  version: 1,
  createdAt: "2026-07-27T20:00:00.000Z",
  updatedAt: "2026-07-27T20:00:00.000Z",
};
const provider = {
  id: providerId,
  displayName: "Provider",
  driverKind: "openai-compatible",
  configuration: {
    kind: "openai-compatible-http",
    baseUrl: "http://127.0.0.1:11434/v1/",
    authentication: "none",
    protocol: "auto",
    manualModelIds: [],
  },
  enabled: true,
  environmentPolicy: "inherit-host",
  version: 1,
  createdAt: "2026-07-27T20:00:00.000Z",
  updatedAt: "2026-07-27T20:00:00.000Z",
};

describe("ServerBrowserAuthorityResolver", () => {
  it("derives unfiled Chat authority without inventing a Project or root", () => {
    const resolver = new ServerBrowserAuthorityResolver({
      hostId,
      workspaceHostId: LOCAL_HOST_ID,
      persistence: {
        readProject: () => undefined,
        readCodeThread: () => undefined,
        readChatThread: () =>
          ({
            id: threadId,
            title: "Chat",
            lifecycle: "active",
            providerInstanceId: providerId,
            modelId: "model",
            researchEnabled: false,
            researchRouting: "none",
            personalityInstructions: "",
            version: 1,
            createdAt: "2026-07-27T20:00:00.000Z",
            updatedAt: "2026-07-27T20:00:00.000Z",
          }) as any,
        readProviderInstance: () => provider as any,
      },
      workThreads: { read: () => undefined },
    });
    expect(resolver.resolve(threadId as any, "chat")).toEqual({
      hostId,
      mode: "chat",
      providerInstanceId: providerId,
      extension: { kind: "core" },
    });
  });

  it("derives Work authority from the current thread, Project binding, and provider", () => {
    const resolver = new ServerBrowserAuthorityResolver({
      hostId,
      workspaceHostId: LOCAL_HOST_ID,
      persistence: {
        readProject: () => ({ ...baseProject, type: "work" }) as any,
        readCodeThread: () => undefined,
        readChatThread: () => undefined,
        readProviderInstance: () => provider as any,
      },
      workThreads: {
        read: () =>
          ({
            id: threadId,
            projectId,
            title: "Thread",
            lifecycle: "active",
            providerInstanceId: providerId,
            modelId: "model",
            bindingRevisionId: revisionId,
            version: 1,
            createdAt: "2026-07-27T20:00:00.000Z",
            updatedAt: "2026-07-27T20:00:00.000Z",
          }) as any,
      },
    });
    expect(resolver.resolve(threadId as any, "work")).toEqual({
      hostId,
      mode: "work",
      projectId,
      rootId: revisionId,
      providerInstanceId: providerId,
      extension: { kind: "core" },
    });
  });

  it("derives Code authority with the exact checkout identity", () => {
    const resolver = new ServerBrowserAuthorityResolver({
      hostId,
      workspaceHostId: LOCAL_HOST_ID,
      persistence: {
        readProject: () =>
          ({
            ...baseProject,
            type: "code",
            codeAccessPersistence: "current-session",
          }) as any,
        readCodeThread: () =>
          ({
            id: threadId,
            projectId,
            bindingRevisionId: revisionId,
            checkoutId,
            providerInstanceId: providerId,
            lifecycle: "active",
          }) as any,
        readChatThread: () => undefined,
        readProviderInstance: () => provider as any,
      },
      workThreads: { read: () => undefined },
    });
    expect(resolver.resolve(threadId as any, "code")).toMatchObject({
      hostId,
      mode: "code",
      projectId,
      rootId: revisionId,
      worktreeId: checkoutId,
      providerInstanceId: providerId,
    });
  });

  it("binds Browser scope to the authenticated window's Project while a background thread runs", () => {
    const workspace = {
      contextByMode: {
        chat: { host: LOCAL_HOST_ID, mode: "chat", projectId: null, boundRoot: null },
        work: { host: LOCAL_HOST_ID, mode: "work", projectId, boundRoot: "/project" },
        code: { host: LOCAL_HOST_ID, mode: "code", projectId, boundRoot: "/project" },
      },
      layouts: {
        chat: {
          kind: "pane",
          surface: {
            kind: "chat-thread",
            id: "80000000-0000-4000-8000-000000000001",
            threadId,
            mode: "chat",
            title: "Chat",
          },
        },
        work: {
          kind: "pane",
          surface: {
            kind: "work-thread",
            id: "80000000-0000-4000-8000-000000000002",
            threadId: "90000000-0000-4000-8000-000000000099",
            mode: "work",
            title: "Work",
            hostId: LOCAL_HOST_ID,
          },
        },
        code: {
          kind: "pane",
          surface: {
            kind: "code-overview",
            id: "80000000-0000-4000-8000-000000000003",
            threadId,
            mode: "code",
            title: "Code",
            hostId: LOCAL_HOST_ID,
          },
        },
      },
    };
    const resolver = new ServerBrowserAuthorityResolver({
      hostId,
      workspaceHostId: LOCAL_HOST_ID,
      persistence: {
        readProject: () => ({ ...baseProject, type: "work" }) as any,
        readCodeThread: () => undefined,
        readChatThread: () => undefined,
        readProviderInstance: () => provider as any,
        readWindowWorkspace: (candidate) =>
          candidate === windowId
            ? ({ workspace } as any)
            : candidate === otherWindowId
              ? ({
                  workspace: {
                    ...workspace,
                    contextByMode: {
                      ...workspace.contextByMode,
                      work: {
                        ...workspace.contextByMode.work,
                        host: decodeHostId("remote-host"),
                      },
                    },
                  },
                } as any)
              : undefined,
      },
      workThreads: {
        read: () =>
          ({
            id: threadId,
            projectId,
            title: "Thread",
            lifecycle: "active",
            providerInstanceId: providerId,
            modelId: "model",
            bindingRevisionId: revisionId,
            version: 1,
            createdAt: "2026-07-27T20:00:00.000Z",
            updatedAt: "2026-07-27T20:00:00.000Z",
          }) as any,
      },
    });

    expect(resolver.canAccessWindow(windowId as any, threadId as any, "work")).toBe(true);
    expect(resolver.canAccessWindow(otherWindowId as any, threadId as any, "work")).toBe(false);
    // A routine's turn runs as the host and reaches its own live thread, but
    // no thread whose authority does not resolve (here, no such Code thread).
    expect(resolver.canAccessWindow(ROUTINE_HOST_SCOPE_ID, threadId as any, "work")).toBe(true);
    expect(resolver.canAccessWindow(ROUTINE_HOST_SCOPE_ID, threadId as any, "code")).toBe(false);
  });

  it("gives each pane's thread its own Project's Browser scope in a window showing several Projects", () => {
    const paneProjectId = "10000000-0000-4000-8000-000000000002";
    const hiddenProjectId = "10000000-0000-4000-8000-000000000003";
    const leadThreadId = "20000000-0000-4000-8000-0000000000a1";
    const paneThreadId = "20000000-0000-4000-8000-0000000000a2";
    const hiddenThreadId = "20000000-0000-4000-8000-0000000000a3";
    const workPane = (nodeId: string, paneId: string, id: string, thread: string) => ({
      kind: "pane",
      nodeId,
      paneId,
      surface: {
        kind: "work-thread",
        id,
        threadId: thread,
        mode: "work",
        title: "Work",
        hostId: LOCAL_HOST_ID,
      },
    });
    const workspace = {
      contextByMode: {
        chat: { host: LOCAL_HOST_ID, mode: "chat", projectId: null, boundRoot: null },
        work: { host: LOCAL_HOST_ID, mode: "work", projectId, boundRoot: "/project" },
        code: { host: LOCAL_HOST_ID, mode: "code", projectId: null, boundRoot: null },
      },
      layouts: {
        work: {
          kind: "split",
          nodeId: "81000000-0000-4000-8000-000000000001",
          orientation: "horizontal",
          ratio: 0.5,
          first: workPane(
            "81000000-0000-4000-8000-000000000002",
            "82000000-0000-4000-8000-000000000001",
            "83000000-0000-4000-8000-000000000001",
            leadThreadId,
          ),
          second: {
            ...workPane(
              "81000000-0000-4000-8000-000000000003",
              "82000000-0000-4000-8000-000000000002",
              "83000000-0000-4000-8000-000000000002",
              paneThreadId,
            ),
            context: {
              host: LOCAL_HOST_ID,
              mode: "work",
              projectId: paneProjectId,
              boundRoot: "/pane-project",
            },
          },
        },
      },
    };
    const projectOf: Record<string, string> = {
      [leadThreadId]: projectId,
      [paneThreadId]: paneProjectId,
      [hiddenThreadId]: hiddenProjectId,
    };
    const resolver = new ServerBrowserAuthorityResolver({
      hostId,
      workspaceHostId: LOCAL_HOST_ID,
      persistence: {
        readProject: (id: string) => ({ ...baseProject, id, type: "work" }) as any,
        readCodeThread: () => undefined,
        readChatThread: () => undefined,
        readProviderInstance: () => provider as any,
        readWindowWorkspace: (candidate: string) =>
          candidate === windowId ? ({ workspace } as any) : undefined,
      } as any,
      workThreads: {
        read: (id: string) =>
          ({
            id,
            projectId: projectOf[id],
            title: "Thread",
            lifecycle: "active",
            providerInstanceId: providerId,
            modelId: "model",
            bindingRevisionId: revisionId,
            version: 1,
            createdAt: "2026-07-27T20:00:00.000Z",
            updatedAt: "2026-07-27T20:00:00.000Z",
          }) as any,
      } as any,
    });

    expect(resolver.resolve(leadThreadId as any, "work")?.projectId).toBe(projectId);
    expect(resolver.resolve(paneThreadId as any, "work")?.projectId).toBe(paneProjectId);
    expect(resolver.canAccessWindow(windowId as any, leadThreadId as any, "work")).toBe(true);
    expect(resolver.canAccessWindow(windowId as any, paneThreadId as any, "work")).toBe(true);
    expect(
      resolver.canAccessWindow(windowId as any, hiddenThreadId as any, "work"),
      "a Project the window does not show stays out of reach",
    ).toBe(false);
  });

  it("refuses a Work Browser scope when its binding revision is missing or stale", () => {
    const resolver = new ServerBrowserAuthorityResolver({
      hostId,
      workspaceHostId: LOCAL_HOST_ID,
      persistence: {
        readProject: () => ({ ...baseProject, type: "work" }) as any,
        readCodeThread: () => undefined,
        readChatThread: () => undefined,
        readProviderInstance: () => provider as any,
      },
      workThreads: {
        read: () =>
          ({
            id: threadId,
            projectId,
            title: "Thread",
            lifecycle: "active",
            providerInstanceId: providerId,
            modelId: "model",
            version: 1,
            createdAt: "2026-07-27T20:00:00.000Z",
            updatedAt: "2026-07-27T20:00:00.000Z",
          }) as any,
      },
    });
    expect(resolver.resolve(threadId as any, "work")).toBeUndefined();

    const staleResolver = new ServerBrowserAuthorityResolver({
      hostId,
      workspaceHostId: LOCAL_HOST_ID,
      persistence: {
        readProject: () => ({ ...baseProject, type: "work" }) as any,
        readCodeThread: () => undefined,
        readChatThread: () => undefined,
        readProviderInstance: () => provider as any,
      },
      workThreads: {
        read: () =>
          ({
            id: threadId,
            projectId,
            title: "Thread",
            lifecycle: "active",
            providerInstanceId: providerId,
            modelId: "model",
            bindingRevisionId: "90000000-0000-4000-8000-000000000001",
            version: 1,
            createdAt: "2026-07-27T20:00:00.000Z",
            updatedAt: "2026-07-27T20:00:00.000Z",
          }) as any,
      },
    });
    expect(staleResolver.resolve(threadId as any, "work")).toBeUndefined();
  });

  it("fails closed when the provider is disabled", () => {
    const resolver = new ServerBrowserAuthorityResolver({
      hostId,
      workspaceHostId: LOCAL_HOST_ID,
      persistence: {
        readProject: () => ({ ...baseProject, type: "work" }) as any,
        readCodeThread: () => undefined,
        readChatThread: () => undefined,
        readProviderInstance: () => ({ ...provider, enabled: false }) as any,
      },
      workThreads: {
        read: () => ({ projectId, providerInstanceId: providerId, lifecycle: "active" }) as any,
      },
    });
    expect(resolver.resolve(threadId as any, "work")).toBeUndefined();
  });
});
