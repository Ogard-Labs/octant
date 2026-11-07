import { expect, it, vi } from "vitest";
import {
  decodeToolActionAuthority,
  decodeAgentRun,
  decodeProviderModelId,
  decodeWindowId,
} from "@octant/contracts";
import {
  decodeBrowserSessionGrantsCommand,
  type BrowserSessionTarget,
} from "@octant/contracts/browser-session-grants";
import { BrowserSessionGrants } from "./browserSessionGrants";
import {
  BrowserDelegatedChildren,
  currentManagedChildBrowserTarget,
} from "./browserDelegatedChildren";
import { defaultAgentRunAuthorityCeilingForMode } from "@octant/domain";
import type { BrowserRuntimePort } from "./browserRuntimePort";
import {
  decodePersistentBrowserOwnerStatus,
  decodePersistentBrowserContextCreated,
} from "@octant/contracts/persistent-browser-owner";

it.each([
  ["child", false],
  ["routine", false],
  ["routine", true],
] as const)(
  "keeps the %s context separate with persistent ownership %s and closes only its owned context on revocation",
  async (kind, persistent) => {
    let localWindow = true;
    let nativeStatus = decodePersistentBrowserOwnerStatus({
      status: "ready",
      ownerId: "a0000000-0000-4000-8000-000000000001",
    });
    const persistentCreate = vi.fn(async () =>
      decodePersistentBrowserContextCreated({
        status: "created",
        ownerId: "a0000000-0000-4000-8000-000000000001",
        leaseId: "a0000000-0000-4000-8000-000000000002",
      }),
    );
    const command = decodeBrowserSessionGrantsCommand({
      kind: "review",
      grantee:
        kind === "child"
          ? { kind, runId: "20000000-0000-4000-8000-000000000001" }
          : { kind, routineId: "20000000-0000-4000-8000-000000000002" },
      profile: { kind: "personal" },
      origins: ["https://example.com"],
      durationMinutes: 15,
    });
    if (command.kind !== "review") throw Error("Expected review");
    const windowId = decodeWindowId("10000000-0000-4000-8000-000000000001");
    const authority = defaultAgentRunAuthorityCeilingForMode("work");
    const workRun = decodeAgentRun({
      id: "20000000-0000-4000-8000-000000000001",
      requestId: "22222222-2222-4222-8222-222222222222",
      parentThreadId: "33333333-3333-4333-8333-333333333333",
      depth: 0,
      role: "implementation",
      task: "Read the report",
      creationPosture: "automatic",
      executionKind: "octant-managed",
      lifecycleStatus: "running",
      authority,
      routingReceipt: {
        executionResolution: {
          providerInstanceId: "55555555-5555-4555-8555-555555555555",
          modelId: "worker-model",
          hostId: "local",
          executionPolicy: "approval-gated",
          permissionPersistence: "current-session",
          effectivePermissions: {
            filesystem: true,
            shell: false,
            git: false,
            network: false,
            tools: true,
            subagents: true,
          },
          source: "project-default",
          fallbackChain: ["project-default"],
          downgradeReasons: [],
        },
        selectedExecutionKind: "octant-managed",
        attemptedExecutionKind: "octant-managed",
        selectedProviderInstanceId: "55555555-5555-4555-8555-555555555555",
        selectedModelId: "worker-model",
        fallbackCandidates: [],
        capabilityDegradations: [],
        contextSnapshotId: "66666666-6666-4666-8666-666666666666",
        effectiveAuthorityDigest: "bounded-child",
        usageQuality: "unavailable",
        hostId: "local",
        mode: "work",
      },
      workspaceReceipt: {
        kind: "work-root",
        mode: "work",
        projectId: "40000000-0000-4000-8000-000000000001",
        bindingRevisionId: "60000000-0000-4000-8000-000000000001",
        canonicalRoot: "/work",
      },
      resultAcknowledgement: { required: false, acknowledged: false },
      version: 2,
      createdAt: "2026-10-03T00:00:00.000Z",
      updatedAt: "2026-10-03T00:00:00.000Z",
    });
    const parentTarget: BrowserSessionTarget = {
      grantee: command.grantee,
      label: "Read the report",
      modelId: decodeProviderModelId("example-model"),
      authority: decodeToolActionAuthority({
        hostId: "30000000-0000-4000-8000-000000000001",
        mode: "work",
        projectId: "40000000-0000-4000-8000-000000000001",
        providerInstanceId: "50000000-0000-4000-8000-000000000001",
        extension: { kind: "core" },
      }),
    };
    const childTarget = currentManagedChildBrowserTarget(workRun, {
      canReview: () => true,
      resolveParent: () => parentTarget.authority,
      supportsTools: () => true,
    })?.target;
    expect(childTarget).toBeDefined();
    if (childTarget === undefined) throw Error("Expected an eligible Work child");
    const target = { ...childTarget, grantee: command.grantee };
    const executionId = "90000000-0000-4000-8000-000000000001";
    expect(workRun.authority).toEqual(authority);
    expect(workRun.authority.network).toBe(false);
    const runtime: BrowserRuntimePort = {
      ...(persistent
        ? {
            persistentOwner: {
              status: async () => nativeStatus,
              configure: async () => nativeStatus,
              createContext: persistentCreate,
              release: async () => "closed" as const,
            },
          }
        : {}),
      available: async () => true,
      nativeAvailable: async () => true,
      createContext: vi.fn(async (_contextId, _policy, _signal, owner) => {
        expect(String(owner.windowId)).toBe(String(windowId));
        expect(String(owner.threadId)).toBe(
          String(command.grantee.kind === "child" ? command.grantee.runId : executionId),
        );
        return "native-live" as const;
      }),
      inspectTarget: async () => ({ sensitive: false }),
      act: vi.fn(async () => ({
        url: "https://example.com",
        title: "Report",
        snapshot: "Report heading",
      })),
      closeContext: vi.fn(async () => {}),
      closeAll: vi.fn(async () => {}),
    };
    let children: BrowserDelegatedChildren | undefined;
    const grants = new BrowserSessionGrants({
      now: Date.now,
      uuid: () => crypto.randomUUID(),
      isLocalWindow: () => localWindow,
      ...(persistent ? { persistentOwnerStatus: async () => nativeStatus } : {}),
      canReview: () => true,
      targets: () => [{ target, revision: "one" }],
      current: () => ({ target, revision: "one" }),
      profileLabel: async () => "Personal",
      record: () => {},
      onRevoked: (id) => {
        void children?.revoke(id);
      },
    });
    const record = vi.fn(() => ({ kind: "ignored" as const, reason: "not-tainting" as const }));
    children = new BrowserDelegatedChildren({
      runtime,
      grants,
      now: Date.now,
      uuid: () => crypto.randomUUID(),
      recordExternalContentIngestion: record,
    });
    let executionAvailable = kind !== "routine";
    const tools = children.tools({
      target,
      executionId,
      ...(kind === "routine"
        ? { executionAuthority: () => (executionAvailable ? target.authority : undefined) }
        : {}),
      executionPolicy: "approval-gated",
      current: () => target,
    });
    const call = {
      name: "octant_browser",
      inputJson: JSON.stringify({
        operation: "navigate",
        url: "https://example.com/report",
        profile: "personal",
      }),
    };
    try {
      expect(await tools.execute(call)).toMatchObject({
        isError: true,
        result: { error: "browser-session-permission-required" },
      });
      expect(runtime.createContext).not.toHaveBeenCalled();
      const review = await grants.execute(windowId, command);
      if (review.kind !== "browser-session-review") throw Error(JSON.stringify(review));
      const allowed = await grants.execute(windowId, { kind: "grant", reviewId: review.reviewId });
      if (allowed.kind !== "browser-session-granted") throw Error(JSON.stringify(allowed));
      if (kind === "routine") {
        expect((await tools.execute(call)).isError).toBe(true);
        expect(runtime.createContext).not.toHaveBeenCalled();
        executionAvailable = true;
      }
      if (persistent) {
        localWindow = false;
        await children.closeWindow(windowId);
      }
      expect(await tools.execute(call)).toMatchObject({ isError: false });
      if (persistent) {
        expect(runtime.createContext).not.toHaveBeenCalled();
        expect(persistentCreate).toHaveBeenCalledOnce();
        await children.closeWindow(windowId);
        expect(runtime.closeContext).not.toHaveBeenCalled();
        expect(
          await tools.execute({
            name: call.name,
            inputJson: JSON.stringify({ operation: "snapshot" }),
          }),
        ).toMatchObject({ isError: false });
        vi.mocked(runtime.act).mockClear();
        await tools.execute(call);
      } else expect(runtime.createContext).toHaveBeenCalledOnce();
      expect(workRun.authority).toEqual(authority);
      const offSite = await tools.execute({
        name: call.name,
        inputJson: JSON.stringify({
          operation: "navigate",
          url: "https://other.example/report",
          profile: "personal",
        }),
      });
      expect(offSite.isError).toBe(true);
      expect(runtime.act).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalled();
      expect(
        await tools.execute({
          name: call.name,
          inputJson: JSON.stringify({ operation: "download-save", downloadId: "d1" }),
        }),
      ).toMatchObject({ isError: true, result: { error: "transfer-needs-separate-permission" } });
      let complete = (_value: Awaited<ReturnType<BrowserRuntimePort["act"]>>) => {};
      const reading = new Promise<Awaited<ReturnType<BrowserRuntimePort["act"]>>>((resolve) => {
        complete = resolve;
      });
      vi.mocked(runtime.act).mockImplementationOnce(() => reading);
      const pending = tools.execute({
        name: call.name,
        inputJson: JSON.stringify({ operation: "snapshot" }),
      });
      try {
        await vi.waitFor(() => expect(runtime.act).toHaveBeenCalledTimes(2));
        localWindow = true;
        await grants.execute(windowId, { kind: "revoke", grantId: allowed.grant.grantId });
        const answer = await pending;
        expect(answer.isError).toBe(true);
        expect(JSON.stringify(answer)).not.toContain("Report");
      } finally {
        complete({ url: "https://example.com", snapshot: "must not escape" });
      }
      await vi.waitFor(() => expect(runtime.closeContext).toHaveBeenCalledOnce());
      expect(runtime.closeAll).not.toHaveBeenCalled();
      expect(await tools.execute(call)).toMatchObject({
        isError: true,
        result: { error: "browser-session-permission-required" },
      });
      if (persistent) {
        const again = await grants.execute(windowId, command);
        if (again.kind !== "browser-session-review") throw Error("Expected fresh review");
        await grants.execute(windowId, { kind: "grant", reviewId: again.reviewId });
        nativeStatus = decodePersistentBrowserOwnerStatus({
          status: "ready",
          ownerId: "a0000000-0000-4000-8000-000000000003",
        });
        expect(await tools.execute(call)).toMatchObject({
          isError: true,
          result: { error: "browser-needs-a-native-owner" },
        });
        expect(persistentCreate).toHaveBeenCalledOnce();
        expect(await grants.execute(windowId, { kind: "list" })).toMatchObject({
          kind: "browser-session-grants",
          grants: [],
        });
      }
    } finally {
      await tools.close?.();
      grants.close();
      await children.close();
    }
  },
);
