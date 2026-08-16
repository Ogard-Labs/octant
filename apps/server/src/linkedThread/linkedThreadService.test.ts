import { describe, expect, it } from "vitest";
import type {
  ActorId,
  AgentRunAuthority,
  LinkedThreadLimitSnapshot,
  LinkedThreadRoutingReceipt,
  ProviderInstanceId,
  ProviderModelId,
  UtcTimestamp,
  WindowId,
} from "@octant/contracts";
import { LINKED_THREAD_REVIEW_ISOLATED_AUTHORITY } from "@octant/domain";
import { LinkedThreadService } from "./linkedThreadService";

const at = (value: string) => value as UtcTimestamp;
const actor = "00000000-0000-4000-8000-000000000001" as ActorId;
const ids = {
  window: "00000000-0000-4000-8000-000000000099",
  sourceThread: "11111111-1111-4111-8111-111111111111",
  request: "33333333-3333-4333-8333-333333333333",
  snapshot: "44444444-4444-4444-8444-444444444444",
  project: "77777777-7777-4777-8777-777777777777",
  provider: "88888888-8888-4888-8888-888888888888",
  threadA: "22222222-2222-4222-8222-222222222222",
  threadB: "33333333-3333-4333-8333-333333333334",
};

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
} as const;

const routingReceipt: LinkedThreadRoutingReceipt = {
  executionResolution: {
    providerInstanceId: ids.provider as ProviderInstanceId,
    modelId: "gpt-4o" as ProviderModelId,
    hostId: "local" as never,
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
  selectedProviderInstanceId: ids.provider as ProviderInstanceId,
  selectedModelId: "gpt-4o" as ProviderModelId,
  fallbackCandidates: [],
  capabilityDegradations: [],
  contextSnapshotId: ids.snapshot as never,
  effectiveAuthorityDigest: "digest-1",
  hostId: "local" as never,
  mode: "chat",
  projectId: ids.project as never,
};

const limits: LinkedThreadLimitSnapshot = {
  requestedCount: 2,
  nestingDepth: 1,
  activeGlobal: 0,
  activeForSource: 0,
  activeForProject: 0,
  activeForHost: 0,
  providerCapacity: {
    status: "available",
    providerInstanceId: ids.provider as ProviderInstanceId,
    active: 0,
    limit: 4,
    remaining: 4,
  },
};

function service(
  now = at("2026-08-02T12:00:00.000Z"),
  create?: ConstructorParameters<typeof LinkedThreadService>[0]["creation"]["create"],
) {
  return new LinkedThreadService({
    creation: {
      create:
        create ??
        (async ({ targets }) =>
          targets.map((target) => ({
            targetIndex: target.targetIndex,
            label: target.label,
            status: "created" as const,
            threadId: target.threadId,
            resultRefId: `chat-thread:${String(target.threadId)}`,
          }))),
    },
    selectRoute: () => ({
      kind: "selected",
      providerInstanceId: ids.provider,
      modelId: "gpt-4o",
      rejectedCandidates: [],
      capabilityDegradations: [],
    }),
    routingReceiptFor: () => routingReceipt,
    limitsFor: ({ requestedCount }) => ({ ...limits, requestedCount }),
    authorityCeiling: authority,
    targetAuthorityCeiling: authority,
    actor: { kind: "local-user", actorId: actor },
    now: () => now,
  });
}

describe("LinkedThreadService", () => {
  it("previews and confirms a linked-thread fan-out with aggregate results", async () => {
    const linkedThreadService = service();
    const proposed = await linkedThreadService.execute(ids.window as WindowId, {
      kind: "linked-thread-prompt-preview",
      requestId: ids.request as never,
      requestFingerprint: "a".repeat(64) as never,
      prompt: "/review 2 threads Review the migration plan.",
      sourceThreadId: ids.sourceThread as never,
      sourceScope: scope as never,
      sourceVersion: 2 as never,
      contextSnapshotId: ids.snapshot as never,
      targetScope: scope as never,
      requestedAuthority: authority,
      nestingDepth: 1,
    });
    expect(proposed).toMatchObject({ kind: "linked-thread-preview-proposed" });
    if (proposed.kind !== "linked-thread-preview-proposed") throw new Error("expected proposed");
    const confirmed = await linkedThreadService.execute(ids.window as WindowId, {
      kind: "confirm-linked-thread-preview",
      previewId: proposed.preview.previewId,
      expectedVersion: proposed.preview.version,
      confirmed: true,
    });
    expect(confirmed).toMatchObject({ kind: "linked-thread-preview-confirmed" });
    if (confirmed.kind !== "linked-thread-preview-confirmed") throw new Error("expected confirmed");
    expect(confirmed.aggregate.status).toBe("created");
    expect(confirmed.aggregate.results).toHaveLength(2);
  });

  it("applies read-only isolated defaults for the bundled review skill", () => {
    const linkedThreadService = service();
    const preview = linkedThreadService.previewSkill({
      task: "Check the API surface.",
      requestedCount: 2,
      command: {
        kind: "linked-thread-prompt-preview",
        requestId: ids.request as never,
        requestFingerprint: "a".repeat(64) as never,
        prompt: "placeholder",
        sourceThreadId: ids.sourceThread as never,
        sourceScope: scope as never,
        sourceVersion: 2 as never,
        contextSnapshotId: ids.snapshot as never,
        targetScope: scope as never,
        requestedAuthority: authority,
        nestingDepth: 1,
      },
    });
    if ("code" in preview) throw new Error("expected preview outcome");
    expect(preview.kind === "ready" || preview.kind === "limited").toBe(true);
    if (preview.kind !== "ready" && preview.kind !== "limited") throw new Error("expected preview");
    const previewRecord = preview.preview;
    expect(previewRecord.effectiveAuthority).toEqual(LINKED_THREAD_REVIEW_ISOLATED_AUTHORITY);
    expect(previewRecord.matchedDirective).toContain("/review 2 threads");
  });

  it("records failed creation outcomes without claiming synthetic thread ids", async () => {
    const linkedThreadService = service(undefined, async ({ targets }) =>
      targets.map((target) => ({
        targetIndex: target.targetIndex,
        label: target.label,
        status: "failed" as const,
        reason: "Provider unavailable.",
      })),
    );
    const proposed = await linkedThreadService.execute(ids.window as WindowId, {
      kind: "linked-thread-prompt-preview",
      requestId: ids.request as never,
      requestFingerprint: "a".repeat(64) as never,
      prompt: "/review 2 threads Review the migration plan.",
      sourceThreadId: ids.sourceThread as never,
      sourceScope: scope as never,
      sourceVersion: 2 as never,
      contextSnapshotId: ids.snapshot as never,
      targetScope: scope as never,
      requestedAuthority: authority,
      nestingDepth: 1,
    });
    if (proposed.kind !== "linked-thread-preview-proposed") throw new Error("expected proposed");

    const confirmed = await linkedThreadService.execute(ids.window as WindowId, {
      kind: "confirm-linked-thread-preview",
      previewId: proposed.preview.previewId,
      expectedVersion: proposed.preview.version,
      confirmed: true,
    });

    expect(confirmed).toMatchObject({
      kind: "linked-thread-preview-confirmed",
      receipt: { status: "waiting", createdThreadIds: [] },
      aggregate: { status: "failed" },
    });
  });
});
