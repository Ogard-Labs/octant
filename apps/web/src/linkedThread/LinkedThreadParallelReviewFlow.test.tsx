import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LinkedThreadClient } from "@octant/client-runtime/linked-thread-client";
import type {
  LinkedThreadAggregate,
  LinkedThreadContextSnapshotId,
  LinkedThreadPreview,
  LinkedThreadPreviewId,
  LinkedThreadReceiptId,
  LinkedThreadRequestFingerprint,
  LinkedThreadRequestId,
  LinkedThreadSourceThreadId,
  LinkedThreadTargetThreadId,
  UtcTimestamp,
} from "@octant/contracts";
import { LinkedThreadParallelReviewFlow } from "./LinkedThreadParallelReviewFlow";
import type { LinkedThreadParallelReviewController } from "./useLinkedThreadParallelReview";

const threadId = "00000000-0000-4000-8000-000000000921";

const ids = {
  sourceThread: "11111111-1111-4111-8111-111111111111" as unknown as LinkedThreadSourceThreadId,
  request: "33333333-3333-4333-8333-333333333333" as unknown as LinkedThreadRequestId,
  fingerprint: "a".repeat(64) as unknown as LinkedThreadRequestFingerprint,
  snapshot: "44444444-4444-4444-8444-444444444444" as unknown as LinkedThreadContextSnapshotId,
  preview: "66666666-6666-4666-8666-666666666666" as unknown as LinkedThreadPreviewId,
  receipt: "55555555-5555-4555-8555-555555555555" as unknown as LinkedThreadReceiptId,
  targetThread1: "22222222-2222-4222-8222-222222222222" as unknown as LinkedThreadTargetThreadId,
  targetThread2: "33333333-3333-4333-8333-333333333334" as unknown as LinkedThreadTargetThreadId,
  createdAt: "2026-08-02T12:01:00.000Z" as unknown as UtcTimestamp,
};

const preview = {
  previewId: "66666666-6666-4666-8666-666666666666",
  requestId: "33333333-3333-4333-8333-333333333333",
  requestFingerprint: "a".repeat(64),
  prompt: "Review the migration plan.",
  matchedDirective: "/review 2 threads",
  sourceThreadId: "11111111-1111-4111-8111-111111111111",
  sourceScope: {
    hostId: "local",
    mode: "chat",
    workspace: { kind: "chat-virtual", projectId: "77777777-7777-4777-8777-777777777777" },
  },
  sourceVersion: 2,
  contextSnapshotId: "44444444-4444-4444-8444-444444444444",
  targetScope: {
    hostId: "local",
    mode: "chat",
    workspace: { kind: "chat-virtual", projectId: "77777777-7777-4777-8777-777777777777" },
  },
  requestedCount: 2,
  threads: [
    {
      targetIndex: 1,
      label: "Reviewer 1",
      prompt: "Review the migration plan.",
      providerInstanceId: "88888888-8888-4888-8888-888888888888",
      modelId: "gpt-4o",
      effectiveAuthority: {
        filesystem: false,
        shell: false,
        git: false,
        network: false,
        tools: false,
        subagents: false,
        executionPolicy: "plan",
        permissionPersistence: "current-session",
      },
      fallbackCandidates: [],
      capabilityDegradations: [],
    },
    {
      targetIndex: 2,
      label: "Reviewer 2",
      prompt: "Review the migration plan.",
      providerInstanceId: "88888888-8888-4888-8888-888888888888",
      modelId: "gpt-4o",
      effectiveAuthority: {
        filesystem: false,
        shell: false,
        git: false,
        network: false,
        tools: false,
        subagents: false,
        executionPolicy: "plan",
        permissionPersistence: "current-session",
      },
      fallbackCandidates: [],
      capabilityDegradations: [],
    },
  ],
  requestedAuthority: {
    filesystem: false,
    shell: false,
    git: false,
    network: false,
    tools: false,
    subagents: false,
    executionPolicy: "plan",
    permissionPersistence: "current-session",
  },
  effectiveAuthority: {
    filesystem: false,
    shell: false,
    git: false,
    network: false,
    tools: false,
    subagents: false,
    executionPolicy: "plan",
    permissionPersistence: "current-session",
  },
  routingReceipt: {
    executionResolution: {
      providerInstanceId: "88888888-8888-4888-8888-888888888888",
      modelId: "gpt-4o",
      hostId: "local",
      executionPolicy: "plan",
      permissionPersistence: "current-session",
      effectivePermissions: {
        filesystem: false,
        shell: false,
        git: false,
        network: false,
        tools: false,
        subagents: false,
      },
      source: "project-default",
      fallbackChain: ["project-default"],
      downgradeReasons: [],
    },
    selectedProviderInstanceId: "88888888-8888-4888-8888-888888888888",
    selectedModelId: "gpt-4o",
    fallbackCandidates: [],
    capabilityDegradations: [],
    contextSnapshotId: "44444444-4444-4444-8444-444444444444",
    effectiveAuthorityDigest: "digest-1",
    hostId: "local",
    mode: "chat",
    projectId: "77777777-7777-4777-8777-777777777777",
  },
  transferPolicy: {
    approvalsTransferred: false,
    credentialsTransferred: false,
    authorityTransferred: false,
    completionTransferred: false,
    activeHandlesTransferred: false,
    rootsTransferred: false,
    worktreesTransferred: false,
  },
  status: "proposed",
  nestingDepth: 1,
  proposedBy: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000001" },
  proposedAt: "2026-08-02T12:00:00.000Z",
  expiresAt: "2026-08-02T12:05:00.000Z",
  version: 1,
} as unknown as LinkedThreadPreview;

const aggregate = {
  aggregateId: "99999999-9999-4999-8999-999999999999",
  requestId: "33333333-3333-4333-8333-333333333333",
  receiptId: "55555555-5555-4555-8555-555555555555",
  previewId: "66666666-6666-4666-8666-666666666666",
  sourceThreadId: "11111111-1111-4111-8111-111111111111",
  skillName: "review-in-parallel",
  requestedCount: 2,
  status: "created",
  results: [
    {
      targetIndex: 1,
      label: "Reviewer 1",
      status: "created",
      threadId: "22222222-2222-4222-8222-222222222222",
      resultRefId: "linked-thread:22222222-2222-4222-8222-222222222222",
    },
    {
      targetIndex: 2,
      label: "Reviewer 2",
      status: "created",
      threadId: "33333333-3333-4333-8333-333333333334",
      resultRefId: "linked-thread:33333333-3333-4333-8333-333333333334",
    },
  ],
  createdAt: "2026-08-02T12:01:00.000Z",
  updatedAt: "2026-08-02T12:01:00.000Z",
} as unknown as LinkedThreadAggregate;

function controller(
  overrides: Partial<LinkedThreadParallelReviewController> = {},
): LinkedThreadParallelReviewController {
  return {
    skillName: "review-in-parallel",
    dialogOpen: true,
    submitting: false,
    close: vi.fn(),
    confirm: vi.fn(async () => true),
    startFromDraft: vi.fn(async () => true),
    preview,
    ...overrides,
  };
}

describe("LinkedThreadParallelReviewFlow", () => {
  it("renders the preview dialog and aggregate view from controller state", () => {
    render(<LinkedThreadParallelReviewFlow controller={controller({ aggregate })} />);
    expect(screen.getByRole("dialog", { name: "Confirm parallel review" })).toBeInTheDocument();
    expect(screen.getByLabelText("Linked-thread aggregate")).toBeInTheDocument();
    expect(screen.getAllByText(/review-in-parallel/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reviewer 1").length).toBeGreaterThan(0);
  });

  it("calls confirm when the user accepts the fan-out", async () => {
    const user = userEvent.setup();
    const confirm = vi.fn(async () => true);
    render(<LinkedThreadParallelReviewFlow controller={controller({ confirm })} />);
    await user.click(screen.getByRole("button", { name: "Confirm fan-out" }));
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe("useLinkedThreadParallelReview integration", () => {
  it("drives preview and confirm through the linked-thread gateway client", async () => {
    const execute = vi
      .fn<LinkedThreadClient["execute"]>()
      .mockResolvedValueOnce({ kind: "linked-thread-preview-proposed", preview })
      .mockResolvedValueOnce({
        kind: "linked-thread-preview-confirmed",
        preview: { ...preview, status: "confirmed", version: 2 as never },
        receipt: {
          receiptId: ids.receipt,
          requestId: ids.request,
          requestFingerprint: ids.fingerprint,
          createdThreadIds: [ids.targetThread1, ids.targetThread2],
          targetScope: preview.targetScope,
          nestingDepth: 1,
          createdAt: ids.createdAt,
        } as never,
        aggregate,
      });
    const { useLinkedThreadParallelReview } = await import("./useLinkedThreadParallelReview");
    const { renderHook, act } = await import("@testing-library/react");
    const { result } = renderHook(() =>
      useLinkedThreadParallelReview({
        client: { execute },
        thread: {
          id: threadId as never,
          title: "Calm planning",
          lifecycle: "active",
          providerInstanceId: "10000000-0000-4000-8000-000000000001" as never,
          modelId: "model-a" as never,
          researchEnabled: false,
          researchRouting: "automatic",
          personalityInstructions: "Be calm.",
          version: 3 as never,
          createdAt: "2026-07-20T08:00:00.000Z" as never,
          updatedAt: "2026-07-20T08:00:00.000Z" as never,
        },
        uuid: () => "33333333-3333-4333-8333-333333333333",
      }),
    );
    await act(async () => {
      await result.current.startFromDraft("$review-in-parallel Check the API surface.");
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "linked-thread-prompt-preview",
        prompt: "/review 2 threads Check the API surface.",
      }),
    );
    expect(result.current.preview).toEqual(preview);
    await act(async () => {
      await result.current.confirm();
    });
    expect(execute).toHaveBeenLastCalledWith({
      kind: "confirm-linked-thread-preview",
      previewId: preview.previewId,
      expectedVersion: preview.version,
      confirmed: true,
    });
    expect(result.current.aggregate).toEqual(aggregate);
    expect(result.current.dialogOpen).toBe(false);
  });
});
