import type { LinkedThreadPreview } from "@octant/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LinkedThreadPreviewDialog } from "./LinkedThreadPreviewDialog";

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

describe("LinkedThreadPreviewDialog", () => {
  it("renders fan-out confirmation with per-thread labels and read-only authority", () => {
    render(
      <LinkedThreadPreviewDialog
        notice="Read-only reviewers will be created as independent linked threads."
        onClose={() => {}}
        onConfirm={() => {}}
        open
        preview={preview}
        skillName="review-in-parallel"
      />,
    );
    expect(screen.getByRole("dialog", { name: "Confirm parallel review" })).toBeInTheDocument();
    expect(screen.getByText("Reviewer 1")).toBeInTheDocument();
    expect(screen.getAllByText(/Read-only/).length).toBeGreaterThan(0);
    expect(screen.getByText(/review-in-parallel/)).toBeInTheDocument();
  });

  it("calls confirm and cancel handlers", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <LinkedThreadPreviewDialog onClose={onClose} onConfirm={onConfirm} open preview={preview} />,
    );
    await user.click(screen.getByRole("button", { name: "Confirm fan-out" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
