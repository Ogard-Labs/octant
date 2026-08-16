import { describe, expect, it, vi } from "vitest";
import type {
  LinkedThreadContextSnapshotId,
  LinkedThreadRequestFingerprint,
  LinkedThreadRequestId,
  LinkedThreadSourceThreadId,
} from "@octant/contracts";
import { createLinkedThreadClient, LinkedThreadClientFailure } from "./linkedThreadClient";

const ids = {
  sourceThread: "11111111-1111-4111-8111-111111111111" as unknown as LinkedThreadSourceThreadId,
  request: "33333333-3333-4333-8333-333333333333" as unknown as LinkedThreadRequestId,
  fingerprint: "a".repeat(64) as unknown as LinkedThreadRequestFingerprint,
  snapshot: "44444444-4444-4444-8444-444444444444" as unknown as LinkedThreadContextSnapshotId,
};

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const authority = {
  filesystem: false,
  shell: false,
  git: false,
  network: false,
  tools: false,
  subagents: false,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
};
const scope = {
  hostId: "local",
  mode: "chat",
  workspace: { kind: "chat-virtual", projectId: "77777777-7777-4777-8777-777777777777" },
};

describe("linkedThreadClient", () => {
  it("posts preview and confirm commands to the linked-thread gateway", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "linked-thread-preview-proposed",
            preview: {
              previewId: "66666666-6666-4666-8666-666666666666",
              requestId: "33333333-3333-4333-8333-333333333333",
              requestFingerprint: "a".repeat(64),
              prompt: "Review the migration plan.",
              matchedDirective: "/review 2 threads",
              sourceThreadId: "11111111-1111-4111-8111-111111111111",
              sourceScope: scope,
              sourceVersion: 2,
              contextSnapshotId: "44444444-4444-4444-8444-444444444444",
              targetScope: scope,
              requestedCount: 2,
              threads: [
                {
                  targetIndex: 1,
                  label: "Reviewer 1",
                  prompt: "Review the migration plan.",
                  providerInstanceId: "88888888-8888-4888-8888-888888888888",
                  modelId: "gpt-4o",
                  effectiveAuthority: authority,
                  fallbackCandidates: [],
                  capabilityDegradations: [],
                },
                {
                  targetIndex: 2,
                  label: "Reviewer 2",
                  prompt: "Review the migration plan.",
                  providerInstanceId: "88888888-8888-4888-8888-888888888888",
                  modelId: "gpt-4o",
                  effectiveAuthority: authority,
                  fallbackCandidates: [],
                  capabilityDegradations: [],
                },
              ],
              requestedAuthority: authority,
              effectiveAuthority: authority,
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
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "linked-thread-preview-confirmed",
            preview: {
              previewId: "66666666-6666-4666-8666-666666666666",
              requestId: "33333333-3333-4333-8333-333333333333",
              requestFingerprint: "a".repeat(64),
              prompt: "Review the migration plan.",
              matchedDirective: "/review 2 threads",
              sourceThreadId: "11111111-1111-4111-8111-111111111111",
              sourceScope: scope,
              sourceVersion: 2,
              contextSnapshotId: "44444444-4444-4444-8444-444444444444",
              targetScope: scope,
              requestedCount: 2,
              threads: [
                {
                  targetIndex: 1,
                  label: "Reviewer 1",
                  prompt: "Review the migration plan.",
                  providerInstanceId: "88888888-8888-4888-8888-888888888888",
                  modelId: "gpt-4o",
                  effectiveAuthority: authority,
                  fallbackCandidates: [],
                  capabilityDegradations: [],
                },
                {
                  targetIndex: 2,
                  label: "Reviewer 2",
                  prompt: "Review the migration plan.",
                  providerInstanceId: "88888888-8888-4888-8888-888888888888",
                  modelId: "gpt-4o",
                  effectiveAuthority: authority,
                  fallbackCandidates: [],
                  capabilityDegradations: [],
                },
              ],
              requestedAuthority: authority,
              effectiveAuthority: authority,
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
              status: "confirmed",
              nestingDepth: 1,
              proposedBy: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000001" },
              proposedAt: "2026-08-02T12:00:00.000Z",
              expiresAt: "2026-08-02T12:05:00.000Z",
              decidedAt: "2026-08-02T12:01:00.000Z",
              version: 2,
            },
            receipt: {
              receiptId: "55555555-5555-4555-8555-555555555555",
              requestId: "33333333-3333-4333-8333-333333333333",
              requestFingerprint: "a".repeat(64),
              continuedFrom: {
                sourceThreadId: "11111111-1111-4111-8111-111111111111",
                sourceScope: scope,
                sourceVersion: 2,
                contextSnapshotId: "44444444-4444-4444-8444-444444444444",
                sourceRoutingReceipt: {
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
              },
              contextSnapshotId: "44444444-4444-4444-8444-444444444444",
              targetThreadIds: [
                "22222222-2222-4222-8222-222222222222",
                "33333333-3333-4333-8333-333333333334",
              ],
              createdThreadIds: [
                "22222222-2222-4222-8222-222222222222",
                "33333333-3333-4333-8333-333333333334",
              ],
              targetScope: scope,
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
              effectiveAuthority: authority,
              transferPolicy: {
                approvalsTransferred: false,
                credentialsTransferred: false,
                authorityTransferred: false,
                completionTransferred: false,
                activeHandlesTransferred: false,
                rootsTransferred: false,
                worktreesTransferred: false,
              },
              nestingDepth: 1,
              status: "accepted",
              createdAt: "2026-08-02T12:01:00.000Z",
              updatedAt: "2026-08-02T12:01:00.000Z",
            },
            aggregate: {
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
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const client = createLinkedThreadClient({
      baseUrl: "http://127.0.0.1",
      fetch,
      windowCapability: capability,
    });
    const proposed = await client.execute({
      kind: "linked-thread-prompt-preview",
      requestId: ids.request,
      requestFingerprint: ids.fingerprint,
      prompt: "/review 2 threads Review the migration plan.",
      sourceThreadId: ids.sourceThread,
      sourceScope: scope as never,
      sourceVersion: 2 as never,
      contextSnapshotId: ids.snapshot,
      targetScope: scope as never,
      requestedAuthority: authority as never,
      nestingDepth: 1,
    });
    expect(proposed.kind).toBe("linked-thread-preview-proposed");
    if (proposed.kind !== "linked-thread-preview-proposed") throw new Error("expected proposed");
    const confirmed = await client.execute({
      kind: "confirm-linked-thread-preview",
      previewId: proposed.preview.previewId,
      expectedVersion: proposed.preview.version,
      confirmed: true,
    });
    expect(confirmed.kind).toBe("linked-thread-preview-confirmed");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1/api/linked-threads/commands");
  });

  it("throws LinkedThreadClientFailure on gateway errors", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: "unsupported", message: "Unsupported prompt." }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createLinkedThreadClient({
      baseUrl: "http://127.0.0.1",
      fetch,
      windowCapability: capability,
    });
    await expect(
      client.execute({
        kind: "linked-thread-prompt-preview",
        requestId: ids.request,
        requestFingerprint: ids.fingerprint,
        prompt: "plain text",
        sourceThreadId: ids.sourceThread,
        sourceScope: scope as never,
        sourceVersion: 2 as never,
        contextSnapshotId: ids.snapshot,
        targetScope: scope as never,
        requestedAuthority: authority as never,
        nestingDepth: 1,
      }),
    ).rejects.toThrow(LinkedThreadClientFailure);
  });
});
