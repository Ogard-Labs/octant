import { describe, expect, it } from "vitest";
import {
  LINKED_THREAD_EVENT_NAMES,
  MAX_LINKED_THREAD_CONTEXT_BYTES,
  decodeLinkedThreadContextSnapshot,
  decodeLinkedThreadCreationRequest,
  decodeLinkedThreadLimitSnapshot,
  decodeLinkedThreadScope,
} from "./linkedThread";

const ids = {
  sourceThread: "11111111-1111-4111-8111-111111111111",
  targetThread: "22222222-2222-4222-8222-222222222222",
  request: "33333333-3333-4333-8333-333333333333",
  snapshot: "44444444-4444-4444-8444-444444444444",
  receipt: "55555555-5555-4555-8555-555555555555",
  project: "66666666-6666-4666-8666-666666666666",
  provider: "77777777-7777-4777-8777-777777777777",
};

const sourceScope = {
  hostId: "local",
  mode: "chat",
  workspace: { kind: "chat-virtual", projectId: ids.project },
};

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
    {
      kind: "decision",
      referenceId: "decision:1",
      label: "Decision",
      sourceVersion: 2,
      byteLength: 20,
    },
  ],
  totalByteLength: 30,
  trust: "untrusted-context",
};

const authority = {
  filesystem: false,
  shell: false,
  git: false,
  network: true,
  tools: true,
  subagents: false,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
};

const routingReceipt = {
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
    sourceScope,
    sourceVersion: 2,
    contextSnapshotId: ids.snapshot,
    sourceRoutingReceipt: routingReceipt,
  },
  contextSnapshot: snapshot,
  targetScope: sourceScope,
  routingReceipt,
  requestedAuthority: authority,
  nestingDepth: 1,
};

describe("linked-thread contracts", () => {
  it("decodes a provenance-linked request with an explicit bounded snapshot", () => {
    const decoded = decodeLinkedThreadCreationRequest(request);
    expect(decoded.continuedFrom.contextSnapshotId).toBe(ids.snapshot);
    expect(decoded.contextSnapshot.totalByteLength).toBe(30);
    expect(decoded.contextSnapshot.trust).toBe("untrusted-context");
  });

  it("rejects duplicate snapshot references and mismatched byte totals", () => {
    expect(() =>
      decodeLinkedThreadContextSnapshot({
        ...snapshot,
        items: [snapshot.items[0], snapshot.items[0]],
      }),
    ).toThrow();
    expect(() => decodeLinkedThreadContextSnapshot({ ...snapshot, totalByteLength: 31 })).toThrow();
    expect(() =>
      decodeLinkedThreadContextSnapshot({
        ...snapshot,
        items: [{ ...snapshot.items[0], sourceVersion: 3 }],
      }),
    ).toThrow();
    expect(() =>
      decodeLinkedThreadContextSnapshot({
        ...snapshot,
        totalByteLength: MAX_LINKED_THREAD_CONTEXT_BYTES + 1,
      }),
    ).toThrow();
  });

  it("rejects workspace/mode mismatches and implicit transfer fields", () => {
    expect(() =>
      decodeLinkedThreadScope({
        ...sourceScope,
        mode: "code",
      }),
    ).toThrow();
    expect(() =>
      decodeLinkedThreadCreationRequest({
        ...request,
        approvalsTransferred: false,
      }),
    ).toThrow();
    expect(() =>
      decodeLinkedThreadCreationRequest({
        ...request,
        targetThreadIds: [ids.targetThread, ids.targetThread],
      }),
    ).toThrow();
  });

  it("keeps provider capacity and replay receipts structurally bounded", () => {
    expect(() =>
      decodeLinkedThreadLimitSnapshot({
        requestedCount: 1,
        nestingDepth: 1,
        activeGlobal: 0,
        activeForSource: 0,
        activeForProject: 0,
        activeForHost: 0,
        providerCapacity: {
          status: "available",
          providerInstanceId: ids.provider,
          active: 3,
          limit: 4,
          remaining: 2,
        },
      }),
    ).toThrow();
  });

  it("exports versioned linked-thread event names", () => {
    expect(LINKED_THREAD_EVENT_NAMES).toEqual([
      "linked.thread-creation-requested@1",
      "linked.thread-creation-receipt-recorded@1",
    ]);
  });
});

export { authority, ids, request, routingReceipt, snapshot, sourceScope };
