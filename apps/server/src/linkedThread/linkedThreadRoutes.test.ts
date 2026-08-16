import { describe, expect, it } from "vitest";
import type {
  ActorId,
  AgentRunAuthority,
  LinkedThreadLimitSnapshot,
  LinkedThreadRoutingReceipt,
} from "@octant/contracts";
import { decodeWindowId } from "@octant/contracts";
import { createLinkedThreadRouteHandler } from "./linkedThreadRoutes";
import { LinkedThreadService } from "./linkedThreadService";
import { WindowAuthorityStore } from "../windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000701");
const actor = "00000000-0000-4000-8000-000000000001" as ActorId;
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
  workspace: { kind: "chat-virtual", projectId: "77777777-7777-4777-8777-777777777777" },
} as const;
const routingReceipt = {
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
      network: true,
      tools: true,
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
} as unknown as LinkedThreadRoutingReceipt;
const limits: LinkedThreadLimitSnapshot = {
  requestedCount: 2,
  nestingDepth: 1,
  activeGlobal: 0,
  activeForSource: 0,
  activeForProject: 0,
  activeForHost: 0,
  providerCapacity: {
    status: "available",
    providerInstanceId: "88888888-8888-4888-8888-888888888888" as never,
    active: 0,
    limit: 4,
    remaining: 4,
  },
};

function handler() {
  const service = new LinkedThreadService({
    creation: {
      create: async ({ targets }) =>
        targets.map((target) => ({
          targetIndex: target.targetIndex,
          label: target.label,
          status: "created" as const,
          threadId: target.threadId,
          resultRefId: `chat-thread:${String(target.threadId)}`,
        })),
    },
    selectRoute: () => ({
      kind: "selected",
      providerInstanceId: "88888888-8888-4888-8888-888888888888",
      modelId: "gpt-4o",
      rejectedCandidates: [],
      capabilityDegradations: [],
    }),
    routingReceiptFor: () => routingReceipt,
    limitsFor: ({ requestedCount }) => ({ ...limits, requestedCount }),
    authorityCeiling: authority,
    targetAuthorityCeiling: authority,
    actor: { kind: "local-user", actorId: actor },
    now: () => "2026-08-02T12:00:00.000Z" as never,
  });
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: Date.now() });
  return createLinkedThreadRouteHandler({
    service,
    windowAuthorityStore: store,
    now: () => Date.now(),
  });
}

describe("createLinkedThreadRouteHandler", () => {
  it("proposes and confirms linked-thread fan-out through the command route", async () => {
    const route = handler();
    const proposed = await route(
      new Request("http://127.0.0.1/api/linked-threads/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({
          kind: "linked-thread-prompt-preview",
          requestId: "33333333-3333-4333-8333-333333333333",
          requestFingerprint: "a".repeat(64),
          prompt: "/review 2 threads Review the migration plan.",
          sourceThreadId: "11111111-1111-4111-8111-111111111111",
          sourceScope: scope,
          sourceVersion: 2,
          contextSnapshotId: "44444444-4444-4444-8444-444444444444",
          targetScope: scope,
          requestedAuthority: authority,
          nestingDepth: 1,
        }),
      }),
    );
    expect(proposed?.status).toBe(200);
    const proposedBody = await proposed!.json();
    const confirmed = await route(
      new Request("http://127.0.0.1/api/linked-threads/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({
          kind: "confirm-linked-thread-preview",
          previewId: proposedBody.preview.previewId,
          expectedVersion: proposedBody.preview.version,
          confirmed: true,
        }),
      }),
    );
    expect(confirmed?.status).toBe(200);
    const confirmedBody = await confirmed!.json();
    expect(confirmedBody.aggregate.status).toBe("created");
  });
});
