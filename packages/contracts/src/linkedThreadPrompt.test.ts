import { describe, expect, it } from "vitest";
import {
  LINKED_THREAD_PREVIEW_NO_IMPLICIT_TRANSFERS,
  LinkedThreadPreviewCommand,
  decodeLinkedThreadPreview,
  decodeLinkedThreadPreviewCommand,
  decodeLinkedThreadPreviewCommandResult,
  decodeLinkedThreadPreviewOutcome,
  decodeLinkedThreadPromptIntent,
  decodeLinkedThreadPromptPreviewCommand,
  type LinkedThreadPreview,
} from "./linkedThreadPrompt";
import { MAX_LINKED_THREAD_TARGETS } from "./linkedThread";

const ids = {
  sourceThread: "11111111-1111-4111-8111-111111111111",
  request: "33333333-3333-4333-8333-333333333333",
  snapshot: "44444444-4444-4444-8444-444444444444",
  receipt: "55555555-5555-4555-8555-555555555555",
  preview: "66666666-6666-4666-8666-666666666666",
  project: "77777777-7777-4777-8777-777777777777",
  provider: "88888888-8888-4888-8888-888888888888",
  target: "99999999-9999-4999-8999-999999999999",
};

const scope = {
  hostId: "local",
  mode: "chat",
  workspace: { kind: "chat-virtual", projectId: ids.project },
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

const preview = {
  previewId: ids.preview,
  requestId: ids.request,
  requestFingerprint: "a".repeat(64),
  prompt: "Review the proposal for correctness and risks.",
  matchedDirective: "review in 2 parallel threads",
  sourceThreadId: ids.sourceThread,
  sourceScope: scope,
  sourceVersion: 2,
  contextSnapshotId: ids.snapshot,
  targetScope: scope,
  requestedCount: 2,
  threads: [
    {
      targetIndex: 1,
      label: "Reviewer 1",
      prompt: "Review the proposal for correctness and risks.",
      providerInstanceId: ids.provider,
      modelId: "gpt-4o",
      effectiveAuthority: authority,
      fallbackCandidates: [],
      capabilityDegradations: [],
    },
    {
      targetIndex: 2,
      label: "Reviewer 2",
      prompt: "Review the proposal for correctness and risks.",
      providerInstanceId: ids.provider,
      modelId: "gpt-4o",
      effectiveAuthority: authority,
      fallbackCandidates: [],
      capabilityDegradations: [],
    },
  ],
  requestedAuthority: authority,
  effectiveAuthority: authority,
  routingReceipt,
  transferPolicy: LINKED_THREAD_PREVIEW_NO_IMPLICIT_TRANSFERS,
  status: "proposed",
  nestingDepth: 1,
  proposedBy: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000001" },
  proposedAt: "2026-08-02T08:00:00.000Z",
  expiresAt: "2026-08-02T08:15:00.000Z",
  version: 1,
};

const promptCommand = {
  kind: "linked-thread-prompt-preview",
  requestId: ids.request,
  requestFingerprint: "a".repeat(64),
  prompt: "Review the proposal in 2 parallel threads.",
  sourceThreadId: ids.sourceThread,
  sourceScope: scope,
  sourceVersion: 2,
  contextSnapshotId: ids.snapshot,
  targetScope: scope,
  requestedAuthority: authority,
  requestedModelId: "gpt-4o",
  requestedProviderInstanceId: ids.provider,
  nestingDepth: 1,
};

describe("linked-thread prompt preview contracts", () => {
  it("decodes a structured multi-thread preview with visible routing and no transfers", () => {
    const decoded = decodeLinkedThreadPreview(preview);
    expect(decoded.requestedCount).toBe(2);
    expect(decoded.threads).toHaveLength(2);
    expect(decoded.transferPolicy).toEqual(LINKED_THREAD_PREVIEW_NO_IMPLICIT_TRANSFERS);
    expect(decoded.routingReceipt.contextSnapshotId).toBe(ids.snapshot);
    expect(decoded.status).toBe("proposed");
  });

  it("rejects previews with inconsistent count, duplicate indices, or mismatched routing", () => {
    expect(() =>
      decodeLinkedThreadPreview({ ...preview, threads: preview.threads.slice(0, 1) }),
    ).toThrow();
    expect(() =>
      decodeLinkedThreadPreview({
        ...preview,
        threads: [preview.threads[0], { ...preview.threads[1], targetIndex: 1 }],
      }),
    ).toThrow();
    expect(() =>
      decodeLinkedThreadPreview({
        ...preview,
        threads: [{ ...preview.threads[1], targetIndex: 3 }],
        requestedCount: 1,
      }),
    ).toThrow();
    expect(() =>
      decodeLinkedThreadPreview({
        ...preview,
        routingReceipt: { ...routingReceipt, contextSnapshotId: ids.target },
      }),
    ).toThrow();
    expect(() =>
      decodeLinkedThreadPreview({
        ...preview,
        status: "confirmed",
        decidedAt: undefined,
      }),
    ).toThrow();
  });

  it("rejects previews that expire in the past or carry implicit transfers", () => {
    expect(() =>
      decodeLinkedThreadPreview({
        ...preview,
        proposedAt: "2026-08-02T08:15:00.000Z",
        expiresAt: "2026-08-02T08:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      decodeLinkedThreadPreview({
        ...preview,
        transferPolicy: {
          ...LINKED_THREAD_PREVIEW_NO_IMPLICIT_TRANSFERS,
          approvalsTransferred: true,
        },
      }),
    ).toThrow();
  });

  it("requires a selected fallback to differ from the thread primary route", () => {
    expect(() =>
      decodeLinkedThreadPreview({
        ...preview,
        threads: [
          {
            ...preview.threads[0],
            selectedFallback: {
              providerInstanceId: ids.provider,
              modelId: "gpt-4o",
              reason: "Primary capacity exhausted.",
            },
          },
          preview.threads[1],
        ],
      }),
    ).toThrow();
  });

  it("decodes prompt preview commands and confirmation/denial commands", () => {
    const decoded = decodeLinkedThreadPromptPreviewCommand(promptCommand);
    expect(decoded.requestedModelId).toBe("gpt-4o");

    const confirmed = decodeLinkedThreadPreviewCommand({
      kind: "confirm-linked-thread-preview",
      previewId: ids.preview,
      expectedVersion: 1,
      confirmed: true,
    });
    expect(confirmed.kind).toBe("confirm-linked-thread-preview");

    const denied = decodeLinkedThreadPreviewCommand({
      kind: "deny-linked-thread-preview",
      previewId: ids.preview,
      expectedVersion: 1,
      denied: true,
    });
    expect(denied.kind).toBe("deny-linked-thread-preview");
    expect(() => decodeLinkedThreadPreviewCommand({ kind: "unknown-kind" })).toThrow();
  });

  it("decodes ready and limited outcomes and explicit decision results", () => {
    const ready = decodeLinkedThreadPreviewOutcome({ kind: "ready", preview });
    expect(ready.kind).toBe("ready");
    const limited = decodeLinkedThreadPreviewOutcome({
      kind: "limited",
      preview,
      notice: "Fallback model selected; capabilities are unchanged.",
    });
    expect(limited.kind).toBe("limited");
    expect(() =>
      decodeLinkedThreadPreviewOutcome({
        kind: "ready",
        preview: { ...preview, status: "denied" },
      }),
    ).toThrow();

    const confirmedResult = decodeLinkedThreadPreviewCommandResult({
      kind: "linked-thread-preview-confirmed",
      preview: { ...preview, status: "confirmed", decidedAt: "2026-08-02T08:01:00.000Z" },
      receipt: {
        receiptId: ids.receipt,
        requestId: ids.request,
        requestFingerprint: "a".repeat(64),
        continuedFrom: {
          sourceThreadId: ids.sourceThread,
          sourceScope: scope,
          sourceVersion: 2,
          contextSnapshotId: ids.snapshot,
          sourceRoutingReceipt: routingReceipt,
        },
        contextSnapshotId: ids.snapshot,
        targetThreadIds: [ids.target],
        createdThreadIds: [ids.target],
        targetScope: scope,
        routingReceipt,
        effectiveAuthority: authority,
        transferPolicy: LINKED_THREAD_PREVIEW_NO_IMPLICIT_TRANSFERS,
        nestingDepth: 1,
        status: "accepted",
        createdAt: "2026-08-02T08:01:00.000Z",
        updatedAt: "2026-08-02T08:01:00.000Z",
      },
      aggregate: {
        aggregateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        requestId: ids.request,
        receiptId: ids.receipt,
        previewId: ids.preview,
        sourceThreadId: ids.sourceThread,
        skillName: "review-in-parallel",
        requestedCount: 1,
        status: "created",
        results: [
          {
            targetIndex: 1,
            label: "Reviewer 1",
            status: "created",
            threadId: ids.target,
            resultRefId: `linked-thread:${ids.target}`,
          },
        ],
        createdAt: "2026-08-02T08:01:00.000Z",
        updatedAt: "2026-08-02T08:01:00.000Z",
      },
    });
    expect(confirmedResult.kind).toBe("linked-thread-preview-confirmed");

    const deniedResult = decodeLinkedThreadPreviewCommandResult({
      kind: "linked-thread-preview-denied",
      preview: { ...preview, status: "denied", decidedAt: "2026-08-02T08:01:00.000Z" },
    });
    expect(deniedResult.kind).toBe("linked-thread-preview-denied");
  });

  it("keeps the union command decodable from raw JSON", () => {
    const decoded: typeof LinkedThreadPreviewCommand.Type = decodeLinkedThreadPreviewCommand(
      JSON.parse(JSON.stringify(promptCommand)),
    );
    expect(decoded.kind).toBe("linked-thread-prompt-preview");
  });

  it("bounds a decoded prompt intent and count within the target limit", () => {
    const intent = decodeLinkedThreadPromptIntent({
      kind: "spawn-linked-threads",
      requestedCount: MAX_LINKED_THREAD_TARGETS,
      prompt: "Review each option.",
      matchedDirective: "review in 4 parallel threads",
    });
    expect(intent.requestedCount).toBe(MAX_LINKED_THREAD_TARGETS);
    expect(() =>
      decodeLinkedThreadPromptIntent({
        kind: "spawn-linked-threads",
        requestedCount: MAX_LINKED_THREAD_TARGETS + 1,
        prompt: "Review each option.",
        matchedDirective: "review in 5 parallel threads",
      }),
    ).toThrow();
  });
});

export type { LinkedThreadPreview };
