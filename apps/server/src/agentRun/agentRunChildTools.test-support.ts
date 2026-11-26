import { vi } from "vitest";
import { decodeAgentRun, type AgentRun, type ProviderExecutionPolicy } from "@octant/contracts";
import type { AgentRunChildToolHost } from "./agentRunChildTools";

const PROJECT = "77777777-7777-4777-8777-777777777777";
export const CHILD_WINDOW = "10000000-0000-4000-8000-000000000001";
export const CHILD_RUN = "11111111-1111-4111-8111-111111111111";
export const CHILD_PARENT = "33333333-3333-4333-8333-333333333333";

export function childRun(
  overrides: {
    readonly mode?: "chat" | "work" | "code";
    readonly policy?: ProviderExecutionPolicy;
    readonly tools?: boolean;
    readonly root?: string;
  } = {},
): AgentRun {
  const mode = overrides.mode ?? "code";
  const executionPolicy = overrides.policy ?? (mode === "chat" ? "plan" : "approval-gated");
  const granted = {
    filesystem: mode !== "chat",
    shell: mode === "code" && executionPolicy !== "plan",
    git: mode === "code" && executionPolicy !== "plan",
    network: mode === "code" && executionPolicy !== "plan",
    tools: overrides.tools ?? true,
    subagents: false,
  };
  const root = overrides.root ?? "/child";
  return decodeAgentRun({
    id: CHILD_RUN,
    requestId: "22222222-2222-4222-8222-222222222222",
    parentThreadId: CHILD_PARENT,
    depth: 0,
    role: "implementation",
    task: "Fix the footer",
    creationPosture: "automatic",
    executionKind: "octant-managed",
    lifecycleStatus: "running",
    authority: { ...granted, executionPolicy, permissionPersistence: "current-session" },
    routingReceipt: {
      executionResolution: {
        providerInstanceId: "55555555-5555-4555-8555-555555555555",
        modelId: "worker-model",
        hostId: "local",
        executionPolicy,
        permissionPersistence: "current-session",
        effectivePermissions: granted,
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
      mode,
    },
    workspaceReceipt:
      mode === "chat"
        ? { kind: "chat-virtual", mode }
        : mode === "work"
          ? {
              kind: "work-root",
              mode,
              projectId: PROJECT,
              bindingRevisionId: "60000000-0000-4000-8000-000000000001",
              canonicalRoot: root,
            }
          : {
              kind: "code-worktree",
              mode,
              projectId: PROJECT,
              checkoutRoot: "/parent",
              worktreeRoot: root,
              verified: true,
            },
    resultAcknowledgement: { required: false, acknowledged: false },
    version: 2,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  });
}

/** A child that holds its grant, with a person at its window, unless told otherwise. */
export function childHost(
  overrides: Parameters<typeof childRun>[0] & {
    readonly attended?: boolean;
    readonly current?: () => boolean;
    readonly ask?: AgentRunChildToolHost["ask"];
  } = {},
): AgentRunChildToolHost {
  const run = childRun(overrides);
  return {
    run,
    runId: String(run.id),
    mode: run.routingReceipt.mode,
    parentThreadId: String(run.parentThreadId),
    projectId: "projectId" in run.workspaceReceipt ? run.workspaceReceipt.projectId : undefined,
    target: {
      providerInstanceId: run.routingReceipt.selectedProviderInstanceId,
      modelId: run.routingReceipt.selectedModelId,
    },
    authority: run.authority,
    executionPolicy: run.authority.executionPolicy,
    folder: run.workspaceReceipt.kind === "chat-virtual" ? undefined : (overrides.root ?? "/child"),
    window: () => CHILD_WINDOW as never,
    current: overrides.current ?? (() => true),
    attended: () => (overrides.attended ?? true) && run.authority.executionPolicy !== "plan",
    ask: overrides.ask ?? vi.fn(async () => "approved" as const),
  };
}
