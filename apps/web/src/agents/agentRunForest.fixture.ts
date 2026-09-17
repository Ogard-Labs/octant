import { decodeAgentRunCenterSummary, type AgentRunCenterSummary } from "@octant/contracts";

const PROVIDER = "44444444-4444-4444-8444-444444444444";

export function forestRun(overrides: {
  readonly runId: string;
  readonly task: string;
  readonly parentThreadId?: string;
  readonly parentThreadTitle?: string;
  readonly parentRunId?: string;
  readonly role?: AgentRunCenterSummary["role"];
  readonly lifecycleStatus?: AgentRunCenterSummary["lifecycleStatus"];
  readonly createdAt?: string;
}): AgentRunCenterSummary {
  return decodeAgentRunCenterSummary({
    runId: overrides.runId,
    requestId: "22222222-2222-4222-8222-222222222222",
    parentThreadId: overrides.parentThreadId ?? "33333333-3333-4333-8333-333333333333",
    parentThreadTitle: overrides.parentThreadTitle ?? "Design chat",
    ...(overrides.parentRunId === undefined ? {} : { parentRunId: overrides.parentRunId }),
    mode: "chat",
    role: overrides.role ?? "research",
    task: overrides.task,
    lifecycleStatus: overrides.lifecycleStatus ?? "running",
    executionKind: "octant-managed",
    authority: {
      filesystem: false,
      shell: false,
      git: false,
      network: true,
      tools: true,
      subagents: false,
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    },
    workspaceKind: "chat-virtual",
    usageQuality: "provider-reported",
    route: {
      requestedProviderInstanceId: PROVIDER,
      requestedModelId: "gpt-4o",
      executionProviderInstanceId: PROVIDER,
      executionModelId: "gpt-4o",
      poolDerived: false,
    },
    resultAcknowledgement: { required: false, acknowledged: false },
    version: 2,
    createdAt: overrides.createdAt ?? "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:01:00.000Z",
  });
}
