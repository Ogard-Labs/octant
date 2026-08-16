import { describe, expect, it } from "vitest";
import { ServerBrowserAuthorityResolver, deriveToolHostId } from "./browserAuthorityResolver";

const projectId = "10000000-0000-4000-8000-000000000001";
const threadId = "20000000-0000-4000-8000-000000000001";
const revisionId = "30000000-0000-4000-8000-000000000001";
const checkoutId = "40000000-0000-4000-8000-000000000001";
const providerId = "50000000-0000-4000-8000-000000000001";
const hostId = deriveToolHostId("/octant-data");
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
  it("derives Work authority from the current thread, Project binding, and provider", () => {
    const resolver = new ServerBrowserAuthorityResolver({
      hostId,
      persistence: {
        readProject: () => ({ ...baseProject, type: "work" }) as any,
        readCodeThread: () => undefined,
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

  it("fails closed when the provider is disabled", () => {
    const resolver = new ServerBrowserAuthorityResolver({
      hostId,
      persistence: {
        readProject: () => ({ ...baseProject, type: "work" }) as any,
        readCodeThread: () => undefined,
        readProviderInstance: () => ({ ...provider, enabled: false }) as any,
      },
      workThreads: {
        read: () => ({ projectId, providerInstanceId: providerId, lifecycle: "active" }) as any,
      },
    });
    expect(resolver.resolve(threadId as any, "work")).toBeUndefined();
  });
});
