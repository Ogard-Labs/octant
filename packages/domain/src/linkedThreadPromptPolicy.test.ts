import { describe, expect, it } from "vitest";
import type {
  ActorId,
  HostId,
  LinkedThreadContextSnapshotId,
  LinkedThreadLimitSnapshot,
  LinkedThreadPreviewId,
  LinkedThreadRequestId,
  LinkedThreadRoutingReceipt,
  LinkedThreadSourceThreadId,
  ProjectId,
  ProviderInstanceId,
  ProviderModelId,
  UtcTimestamp,
} from "@octant/contracts";
import { LINKED_THREAD_PREVIEW_NO_IMPLICIT_TRANSFERS } from "@octant/contracts/linked-thread-prompt";
import {
  buildLinkedThreadPreview,
  classifyLinkedThreadPreviewTransition,
  parseLinkedThreadPrompt,
  selectLinkedThreadRoute,
  type LinkedThreadRouteCandidate,
} from "./linkedThreadPromptPolicy";

const at = (value: string) => value as unknown as UtcTimestamp;
const actorId = (value: string) => value as unknown as ActorId;
const hostId = (value: string) => value as unknown as HostId;
const modelId = (value: string) => value as unknown as ProviderModelId;

const ids = {
  sourceThread: "11111111-1111-4111-8111-111111111111" as unknown as LinkedThreadSourceThreadId,
  request: "33333333-3333-4333-8333-333333333333" as unknown as LinkedThreadRequestId,
  snapshot: "44444444-4444-4444-8444-444444444444" as unknown as LinkedThreadContextSnapshotId,
  preview: "66666666-6666-4666-8666-666666666666" as unknown as LinkedThreadPreviewId,
  project: "77777777-7777-4777-8777-777777777777" as unknown as ProjectId,
  provider: "88888888-8888-4888-8888-888888888888" as unknown as ProviderInstanceId,
  fallbackProvider: "99999999-9999-4999-8999-999999999999" as unknown as ProviderInstanceId,
};
const actor = actorId("00000000-0000-4000-8000-000000000001");

const authority = {
  filesystem: false,
  shell: false,
  git: false,
  network: true,
  tools: true,
  subagents: false,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
} as const;

const scope = {
  hostId: "local",
  mode: "chat",
  workspace: { kind: "chat-virtual", projectId: ids.project },
} as never;

const routing: LinkedThreadRoutingReceipt = {
  executionResolution: {
    providerInstanceId: ids.provider,
    modelId: modelId("gpt-4o"),
    hostId: hostId("local"),
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
  selectedModelId: modelId("gpt-4o"),
  fallbackCandidates: [],
  capabilityDegradations: [],
  contextSnapshotId: ids.snapshot,
  effectiveAuthorityDigest: "digest-1",
  hostId: hostId("local"),
  mode: "chat",
  projectId: ids.project,
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
    providerInstanceId: ids.provider,
    active: 0,
    limit: 4,
    remaining: 4,
  },
};

const primaryRoute: LinkedThreadRouteCandidate = {
  providerInstanceId: ids.provider,
  modelId: modelId("gpt-4o"),
  executionPolicy: "plan",
  permissionPersistence: "current-session",
  capabilities: {
    filesystem: false,
    shell: false,
    git: false,
    network: true,
    tools: true,
    subagents: false,
  },
};

const fallbackRoute: LinkedThreadRouteCandidate = {
  providerInstanceId: ids.fallbackProvider,
  modelId: modelId("claude-3.5-sonnet"),
  executionPolicy: "plan",
  permissionPersistence: "current-session",
  capabilities: {
    filesystem: false,
    shell: false,
    git: false,
    network: true,
    tools: true,
    subagents: false,
  },
};

const privilegedRoute: LinkedThreadRouteCandidate = {
  providerInstanceId: ids.fallbackProvider,
  modelId: modelId("full-access-model"),
  executionPolicy: "full-access",
  permissionPersistence: "project-default",
  capabilities: {
    filesystem: true,
    shell: true,
    git: true,
    network: true,
    tools: true,
    subagents: true,
  },
};

function command(prompt: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: "linked-thread-prompt-preview",
    requestId: ids.request,
    requestFingerprint: "a".repeat(64),
    prompt,
    sourceThreadId: ids.sourceThread,
    sourceScope: scope,
    sourceVersion: 2,
    contextSnapshotId: ids.snapshot,
    targetScope: scope,
    requestedAuthority: authority,
    nestingDepth: 1,
    ...overrides,
  } as never;
}

function selectedFor(commandInput: Record<string, unknown>) {
  return selectLinkedThreadRoute({
    requestedAuthority: (commandInput.requestedAuthority ?? authority) as never,
    ...(commandInput.requestedModelId === undefined
      ? {}
      : { requestedModelId: commandInput.requestedModelId }),
    ...(commandInput.requestedProviderInstanceId === undefined
      ? {}
      : { requestedProviderInstanceId: commandInput.requestedProviderInstanceId }),
    primary: primaryRoute,
    fallbackChain: [fallbackRoute],
  } as never);
}

describe("parseLinkedThreadPrompt", () => {
  it("parses a prompt requesting N parallel threads", () => {
    const result = parseLinkedThreadPrompt({
      prompt: "Review this proposal in 3 parallel threads.",
    });
    expect(result).toMatchObject({ kind: "spawn-linked-threads", requestedCount: 3 });
  });

  it("parses slash-style and bracketed directives", () => {
    expect(parseLinkedThreadPrompt({ prompt: "/review 4 threads: check each file" })).toMatchObject(
      { kind: "spawn-linked-threads", requestedCount: 4 },
    );
    expect(parseLinkedThreadPrompt({ prompt: "[parallel: 2] audit both options" })).toMatchObject({
      kind: "spawn-linked-threads",
      requestedCount: 2,
    });
    expect(
      parseLinkedThreadPrompt({ prompt: "spawn 3 review threads for the diff" }),
    ).toMatchObject({ kind: "spawn-linked-threads", requestedCount: 3 });
  });

  it("returns unsupported for an ordinary single-thread prompt", () => {
    expect(parseLinkedThreadPrompt({ prompt: "Please summarize the current thread." })).toEqual({
      kind: "unsupported",
    });
    expect(parseLinkedThreadPrompt({ prompt: "review in 0 parallel threads" })).toEqual({
      kind: "unsupported",
    });
  });

  it("clamps an excessive request to the configured maximum and flags the clamp", () => {
    const result = parseLinkedThreadPrompt({
      prompt: "review in 99 parallel threads",
      maxTargets: 4,
    });
    expect(result).toMatchObject({
      kind: "spawn-linked-threads",
      requestedCount: 4,
      countClamped: true,
    });
  });

  it("strips the directive from the per-thread prompt while keeping it visible", () => {
    const result = parseLinkedThreadPrompt({
      prompt: "Review the diff in 2 parallel threads for correctness.",
    });
    if (result.kind !== "spawn-linked-threads") throw new Error("expected spawn");
    expect(result.prompt).toContain("Review the diff");
    expect(result.prompt).not.toContain("2 parallel threads");
    expect(result.matchedDirective).toContain("2");
  });
});

describe("selectLinkedThreadRoute", () => {
  it("selects the requested available model without a fallback", () => {
    const selection = selectLinkedThreadRoute({
      requestedAuthority: authority,
      requestedModelId: "gpt-4o",
      requestedProviderInstanceId: ids.provider,
      primary: primaryRoute,
      fallbackChain: [fallbackRoute],
    });
    expect(selection).toMatchObject({ kind: "selected", modelId: "gpt-4o" });
    if (selection.kind === "selected") expect(selection.selectedFallback).toBeUndefined();
  });

  it("surfaces a capability-checked fallback visibly when the requested model is unavailable", () => {
    const selection = selectLinkedThreadRoute({
      requestedAuthority: authority,
      requestedModelId: "unavailable-model",
      requestedProviderInstanceId: ids.provider,
      primary: primaryRoute,
      fallbackChain: [fallbackRoute],
    });
    expect(selection).toMatchObject({
      kind: "selected",
      modelId: "claude-3.5-sonnet",
    });
    if (selection.kind === "selected") {
      expect(selection.selectedFallback?.modelId).toBe("claude-3.5-sonnet");
      expect(selection.capabilityDegradations.length).toBeGreaterThan(0);
    }
  });

  it("denies when the only fallback would widen authority silently", () => {
    const selection = selectLinkedThreadRoute({
      requestedAuthority: authority,
      requestedModelId: "unavailable-model",
      requestedProviderInstanceId: ids.provider,
      primary: primaryRoute,
      fallbackChain: [privilegedRoute],
    });
    expect(selection).toMatchObject({ kind: "denied" });
    if (selection.kind === "denied") expect(selection.reason).toMatch(/privileged|authority/i);
  });

  it("denies when the requested route itself exceeds the requested authority", () => {
    const selection = selectLinkedThreadRoute({
      requestedAuthority: authority,
      requestedModelId: "full-access-model",
      requestedProviderInstanceId: ids.fallbackProvider,
      primary: primaryRoute,
      fallbackChain: [privilegedRoute],
    });
    expect(selection).toMatchObject({ kind: "denied" });
  });

  it("denies when no route is available", () => {
    const selection = selectLinkedThreadRoute({
      requestedAuthority: authority,
      primary: privilegedRoute,
      fallbackChain: [],
    });
    expect(selection.kind).toBe("denied");
  });
});

describe("buildLinkedThreadPreview", () => {
  it("builds a proposed structured preview with no implicit transfers", () => {
    const result = buildLinkedThreadPreview({
      command: command("Review this in 2 parallel threads."),
      selection: selectedFor(command("Review this in 2 parallel threads.")),
      routingReceipt: routing,
      limits,
      authorityCeiling: authority,
      proposedBy: { kind: "local-user", actorId: actor },
      previewId: ids.preview,
      now: at("2026-08-02T08:00:00.000Z"),
      expiresAt: at("2026-08-02T08:15:00.000Z"),
    });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.preview.status).toBe("proposed");
    expect(result.preview.requestedCount).toBe(2);
    expect(result.preview.threads).toHaveLength(2);
    expect(result.preview.transferPolicy).toEqual(LINKED_THREAD_PREVIEW_NO_IMPLICIT_TRANSFERS);
    expect(result.preview.effectiveAuthority).toEqual(authority);
    expect(result.preview.threads[0]).toMatchObject({
      label: "Reviewer 1",
      modelId: "gpt-4o",
    });
  });

  it("returns limited with a visible notice when a fallback is selected", () => {
    const result = buildLinkedThreadPreview({
      command: command("Review this in 1 parallel thread.", {
        requestedModelId: "unavailable-model",
        requestedProviderInstanceId: ids.provider,
      }),
      selection: selectedFor(
        command("Review this in 1 parallel thread.", {
          requestedModelId: "unavailable-model",
          requestedProviderInstanceId: ids.provider,
        }),
      ),
      routingReceipt: routing,
      limits: {
        requestedCount: 1,
        nestingDepth: 1,
        activeGlobal: 0,
        activeForSource: 0,
        activeForProject: 0,
        activeForHost: 0,
        providerCapacity: {
          status: "available",
          providerInstanceId: ids.fallbackProvider,
          active: 0,
          limit: 4,
          remaining: 4,
        },
      },
      authorityCeiling: authority,
      proposedBy: { kind: "local-user", actorId: actor },
      previewId: ids.preview,
      now: at("2026-08-02T08:00:00.000Z"),
      expiresAt: at("2026-08-02T08:15:00.000Z"),
    });
    expect(result.kind).toBe("limited");
    if (result.kind !== "limited") return;
    expect(result.notice).toMatch(/fallback/i);
    expect(result.preview.threads[0]!.selectedFallback?.modelId).toBe("claude-3.5-sonnet");
  });

  it("denies without creating anything when only a privileged route exists", () => {
    const result = buildLinkedThreadPreview({
      command: command("Review this in 1 parallel thread.", {
        requestedModelId: "unavailable-model",
        requestedProviderInstanceId: ids.provider,
      }),
      selection: selectLinkedThreadRoute({
        requestedAuthority: authority,
        requestedModelId: "unavailable-model",
        requestedProviderInstanceId: ids.provider,
        primary: primaryRoute,
        fallbackChain: [privilegedRoute],
      }),
      routingReceipt: routing,
      limits: {
        ...limits,
        requestedCount: 1,
        providerCapacity: {
          status: "available",
          providerInstanceId: ids.provider,
          active: 0,
          limit: 4,
          remaining: 4,
        },
      },
      authorityCeiling: authority,
      proposedBy: { kind: "local-user", actorId: actor },
      previewId: ids.preview,
      now: at("2026-08-02T08:00:00.000Z"),
      expiresAt: at("2026-08-02T08:15:00.000Z"),
    });
    expect(result.kind).toBe("denied");
  });

  it("returns unsupported when the prompt is not a multi-thread request", () => {
    const result = buildLinkedThreadPreview({
      command: command("Please summarize the current thread."),
      selection: selectedFor(command("Please summarize the current thread.")),
      routingReceipt: routing,
      limits,
      authorityCeiling: authority,
      proposedBy: { kind: "local-user", actorId: actor },
      previewId: ids.preview,
      now: at("2026-08-02T08:00:00.000Z"),
      expiresAt: at("2026-08-02T08:15:00.000Z"),
    });
    expect(result).toMatchObject({ kind: "unsupported" });
  });

  it("fails closed when linked-thread limits cannot admit the request", () => {
    const result = buildLinkedThreadPreview({
      command: command("Review this in 2 parallel threads."),
      selection: selectedFor(command("Review this in 2 parallel threads.")),
      routingReceipt: routing,
      limits: { ...limits, activeGlobal: 3 },
      authorityCeiling: authority,
      proposedBy: { kind: "local-user", actorId: actor },
      previewId: ids.preview,
      now: at("2026-08-02T08:00:00.000Z"),
      expiresAt: at("2026-08-02T08:15:00.000Z"),
    });
    expect(result).toMatchObject({ kind: "denied" });
  });

  it("never widens authority beyond the target ceiling", () => {
    const result = buildLinkedThreadPreview({
      command: command("Review this in 1 parallel thread.", {
        requestedAuthority: { ...authority, filesystem: true, shell: true, git: true },
      }),
      selection: selectLinkedThreadRoute({
        requestedAuthority: { ...authority, filesystem: true, shell: true, git: true },
        primary: {
          ...primaryRoute,
          capabilities: { ...primaryRoute.capabilities, filesystem: true, shell: true, git: true },
        },
        fallbackChain: [],
      }),
      routingReceipt: routing,
      limits: {
        ...limits,
        requestedCount: 1,
        providerCapacity: {
          status: "available",
          providerInstanceId: ids.provider,
          active: 0,
          limit: 4,
          remaining: 4,
        },
      },
      authorityCeiling: authority,
      proposedBy: { kind: "local-user", actorId: actor },
      previewId: ids.preview,
      now: at("2026-08-02T08:00:00.000Z"),
      expiresAt: at("2026-08-02T08:15:00.000Z"),
    });
    expect(result.kind).toBe("denied");
  });
});

describe("classifyLinkedThreadPreviewTransition", () => {
  const base = {
    currentVersion: 1,
    expectedVersion: 1,
    now: at("2026-08-02T08:05:00.000Z"),
    expiresAt: at("2026-08-02T08:15:00.000Z"),
  } as const;

  it("allows confirm and deny only on a proposed preview with a matching version", () => {
    expect(
      classifyLinkedThreadPreviewTransition({
        ...base,
        currentStatus: "proposed",
        transition: "confirm",
      }),
    ).toBe("allow");
    expect(
      classifyLinkedThreadPreviewTransition({
        ...base,
        currentStatus: "proposed",
        transition: "deny",
      }),
    ).toBe("allow");
  });

  it("denies transitions on decided previews, version mismatch, and after expiry", () => {
    expect(
      classifyLinkedThreadPreviewTransition({
        ...base,
        currentStatus: "confirmed",
        transition: "deny",
      }),
    ).toBe("deny");
    expect(
      classifyLinkedThreadPreviewTransition({
        ...base,
        currentStatus: "denied",
        transition: "confirm",
      }),
    ).toBe("deny");
    expect(
      classifyLinkedThreadPreviewTransition({
        ...base,
        currentStatus: "proposed",
        expectedVersion: 2,
        transition: "confirm",
      }),
    ).toBe("deny");
    expect(
      classifyLinkedThreadPreviewTransition({
        ...base,
        currentStatus: "proposed",
        now: at("2026-08-02T08:16:00.000Z"),
        transition: "confirm",
      }),
    ).toBe("deny");
  });

  it("allows expiry only for an undecided preview that has passed its deadline", () => {
    expect(
      classifyLinkedThreadPreviewTransition({
        ...base,
        currentStatus: "proposed",
        transition: "expire",
        now: at("2026-08-02T08:16:00.000Z"),
      }),
    ).toBe("allow");
    expect(
      classifyLinkedThreadPreviewTransition({
        ...base,
        currentStatus: "proposed",
        transition: "expire",
      }),
    ).toBe("deny");
  });
});
