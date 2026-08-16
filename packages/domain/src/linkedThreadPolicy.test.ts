import { describe, expect, it } from "vitest";
import type { AgentRunAuthority } from "@octant/contracts";
import {
  LinkedThreadPolicyRejected,
  admitLinkedThreadCreation,
  assertLinkedThreadLimits,
  clampLinkedThreadAuthority,
  resolveLinkedThreadReplay,
} from "./linkedThreadPolicy";

const ids = {
  sourceThread: "11111111-1111-4111-8111-111111111111",
  targetThread: "22222222-2222-4222-8222-222222222222",
  request: "33333333-3333-4333-8333-333333333333",
  snapshot: "44444444-4444-4444-8444-444444444444",
  project: "66666666-6666-4666-8666-666666666666",
  provider: "77777777-7777-4777-8777-777777777777",
};
const now = "2026-08-01T10:00:00.000Z" as never;

const authority: AgentRunAuthority = {
  filesystem: false,
  shell: false,
  git: false,
  network: true,
  tools: true,
  subagents: false,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
};

const scope = {
  hostId: "local",
  mode: "chat",
  workspace: { kind: "chat-virtual", projectId: ids.project },
} as never;

const snapshot = {
  id: ids.snapshot,
  sourceThreadId: ids.sourceThread,
  sourceVersion: 2,
  items: [
    {
      kind: "summary",
      referenceId: "summary:1",
      label: "Summary",
      sourceVersion: 2,
      byteLength: 10,
    },
  ],
  totalByteLength: 10,
  trust: "untrusted-context",
};

const routing = {
  executionResolution: {
    providerInstanceId: ids.provider,
    modelId: "gpt-4o",
    hostId: "local",
    executionPolicy: "plan",
    permissionPersistence: "current-session",
    effectivePermissions: {
      filesystem: false,
      shell: false,
      git: false,
      network: true,
      tools: true,
      subagents: false,
    },
    source: "project-default",
    fallbackChain: ["project-default"],
    downgradeReasons: [],
  },
  selectedProviderInstanceId: ids.provider,
  selectedModelId: "gpt-4o",
  fallbackCandidates: [],
  capabilityDegradations: [],
  contextSnapshotId: ids.snapshot,
  effectiveAuthorityDigest: "digest-1",
  hostId: "local",
  mode: "chat",
  projectId: ids.project,
};

const request = {
  kind: "create-linked-thread",
  requestId: ids.request,
  requestFingerprint: "a".repeat(64),
  targetThreadIds: [ids.targetThread],
  continuedFrom: {
    sourceThreadId: ids.sourceThread,
    sourceScope: scope,
    sourceVersion: 2,
    contextSnapshotId: ids.snapshot,
    sourceRoutingReceipt: routing,
  },
  contextSnapshot: snapshot,
  targetScope: scope,
  routingReceipt: routing,
  requestedAuthority: authority,
  nestingDepth: 1,
};

const limits = {
  requestedCount: 1,
  nestingDepth: 1,
  activeGlobal: 0,
  activeForSource: 0,
  activeForProject: 0,
  activeForHost: 0,
  providerCapacity: {
    status: "available",
    providerInstanceId: ids.provider,
    active: 0,
    limit: 4,
    remaining: 4,
  },
};

describe("linkedThreadPolicy", () => {
  it("admits a valid linked request with no implicit authority transfer", () => {
    const result = admitLinkedThreadCreation({
      request,
      receiptId: "88888888-8888-4888-8888-888888888888" as never,
      targetAuthorityCeiling: authority,
      limits,
      targetScopeAvailable: true,
      targetScopeAuthorized: true,
      now,
    });

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.receipt.transferPolicy).toEqual({
      approvalsTransferred: false,
      credentialsTransferred: false,
      authorityTransferred: false,
      completionTransferred: false,
      activeHandlesTransferred: false,
      rootsTransferred: false,
      worktreesTransferred: false,
    });
    expect(result.receipt.createdThreadIds).toEqual([ids.targetThread]);
  });

  it("fails closed for cross-scope links without explicit scope change", () => {
    const otherProject = "99999999-9999-4999-8999-999999999999";
    expect(() =>
      admitLinkedThreadCreation({
        request: {
          ...request,
          targetScope: {
            hostId: "local",
            mode: "chat",
            workspace: { kind: "chat-virtual", projectId: otherProject },
          },
          routingReceipt: { ...routing, projectId: otherProject },
        },
        receiptId: "88888888-8888-4888-8888-888888888888" as never,
        targetAuthorityCeiling: authority,
        limits,
        targetScopeAvailable: true,
        targetScopeAuthorized: true,
        now,
      }),
    ).toThrow(LinkedThreadPolicyRejected);
  });

  it("admits a cross-Project link only with confirmed scope change", () => {
    const otherProject = "99999999-9999-4999-8999-999999999999";
    const result = admitLinkedThreadCreation({
      request: {
        ...request,
        targetScope: {
          hostId: "local",
          mode: "chat",
          workspace: { kind: "chat-virtual", projectId: otherProject },
        },
        routingReceipt: { ...routing, projectId: otherProject },
        scopeChange: { confirmed: true, reason: "User selected the destination Project." },
      },
      receiptId: "88888888-8888-4888-8888-888888888888" as never,
      targetAuthorityCeiling: authority,
      limits,
      targetScopeAvailable: true,
      targetScopeAuthorized: true,
      now,
    });
    expect(result.kind).toBe("accepted");
  });

  it("rejects authority widening and exhausted provider capacity", () => {
    expect(() =>
      clampLinkedThreadAuthority({
        requestedAuthority: { ...authority, filesystem: true },
        targetCeiling: authority,
      }),
    ).toThrow(/authority/i);
    expect(() =>
      assertLinkedThreadLimits({
        ...limits,
        providerCapacity: { ...limits.providerCapacity, remaining: 0 },
      }),
    ).toThrow(/capacity|limit/i);
    expect(() =>
      clampLinkedThreadAuthority({
        requestedAuthority: { ...authority, executionPolicy: "full-access" },
        targetCeiling: { ...authority, executionPolicy: "full-access" },
        globalCeiling: authority,
      }),
    ).toThrow(/authority/i);
    expect(() =>
      clampLinkedThreadAuthority({
        requestedAuthority: { ...authority, filesystem: true },
        targetCeiling: { ...authority, filesystem: true },
        targetScope: {
          hostId: "local",
          mode: "chat",
          workspace: { kind: "chat-virtual", projectId: ids.project },
        } as never,
      }),
    ).toThrow(/authority/i);
    expect(() =>
      clampLinkedThreadAuthority({
        requestedAuthority: authority,
        targetCeiling: authority,
        targetScope: {
          hostId: "local",
          mode: "code",
          workspace: {
            kind: "code-worktree",
            projectId: ids.project,
            repositoryId: "repo",
            bindingRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            checkoutId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            verified: false,
          },
        } as never,
      }),
    ).toThrow(/verified|scope/i);
  });

  it("enforces each concurrency dimension and provider readiness", () => {
    expect(() => assertLinkedThreadLimits({ ...limits, activeGlobal: 4 })).toThrow(/global/i);
    expect(() => assertLinkedThreadLimits({ ...limits, activeForSource: 3 })).toThrow(/source/i);
    expect(() => assertLinkedThreadLimits({ ...limits, activeForProject: 4 })).toThrow(/Project/i);
    expect(() => assertLinkedThreadLimits({ ...limits, activeForHost: 4 })).toThrow(/host/i);
    expect(() =>
      assertLinkedThreadLimits({
        ...limits,
        providerCapacity: {
          status: "stale",
          providerInstanceId: ids.provider,
        },
      }),
    ).toThrow(/stale|capacity/i);
    expect(() => assertLinkedThreadLimits({ ...limits, nestingDepth: 3 })).toThrow(
      /depth|invalid/i,
    );
  });

  it("returns the existing receipt for an exact replay and rejects a conflicting fingerprint", () => {
    const accepted = admitLinkedThreadCreation({
      request,
      receiptId: "88888888-8888-4888-8888-888888888888" as never,
      targetAuthorityCeiling: authority,
      limits,
      targetScopeAvailable: true,
      targetScopeAuthorized: true,
      now,
    });
    if (accepted.kind !== "accepted") throw new Error("fixture should be accepted");

    expect(resolveLinkedThreadReplay({ request, existingReceipt: accepted.receipt })).toEqual({
      kind: "duplicate",
      receipt: accepted.receipt,
    });
    expect(
      resolveLinkedThreadReplay({
        request,
        existingReceipt: {
          ...accepted.receipt,
          status: "waiting",
          recoveryReason: "Host reconnect required.",
        },
      }),
    ).toEqual({
      kind: "duplicate",
      receipt: expect.objectContaining({ status: "waiting" }),
    });
    expect(
      resolveLinkedThreadReplay({
        request: {
          ...request,
          requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          requestFingerprint: "c".repeat(64),
        },
        existingReceipt: accepted.receipt,
      }),
    ).toEqual({ kind: "new" });
    expect(() =>
      resolveLinkedThreadReplay({
        request: { ...request, requestFingerprint: "b".repeat(64) },
        existingReceipt: accepted.receipt,
      }),
    ).toThrow(/duplicate/i);
  });
});
