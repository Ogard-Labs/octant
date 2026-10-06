import type { AgentObservedChild, AgentRunResultPacket } from "@octant/contracts";
import {
  decodeAgentRunId,
  decodeAgentRunParentThreadId,
  decodeAgentRunWorkspaceReceipt,
} from "@octant/contracts/agent-run";
import {
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderSessionId,
} from "@octant/contracts/providers";
import { decodeUtcTimestamp } from "@octant/contracts/events";

export function observedChildFixture(
  overrides: Partial<AgentObservedChild> = {},
): AgentObservedChild {
  return {
    kind: "observed",
    observationId: "provider-child",
    parentThreadId: decodeAgentRunParentThreadId("11111111-1111-4111-8111-111111111111"),
    mode: "code",
    control: "unavailable",
    providerInstanceId: decodeProviderInstanceId("55555555-5555-4555-8555-555555555555"),
    sessionId: decodeProviderSessionId("66666666-6666-4666-8666-666666666666"),
    childAgentId: "child-one",
    task: "Inspect parser",
    lifecycleStatus: "running",
    latestSummary: "Reading the parser",
    firstObservedAt: decodeUtcTimestamp("2026-09-26T10:00:00.000Z"),
    updatedAt: decodeUtcTimestamp("2026-09-26T10:00:12.000Z"),
    historyStatus: "partial",
    history: [],
    ...overrides,
  };
}

export function resultPacketFixture(
  overrides: Omit<Partial<AgentRunResultPacket>, "modelId"> & { readonly modelId?: string } = {},
): AgentRunResultPacket {
  return {
    runId: decodeAgentRunId("22222222-2222-4222-8222-222222222222"),
    parentThreadId: decodeAgentRunParentThreadId("11111111-1111-4111-8111-111111111111"),
    generation: 1,
    providerInstanceId: decodeProviderInstanceId("55555555-5555-4555-8555-555555555555"),
    executionKind: "octant-managed",
    workspace: decodeAgentRunWorkspaceReceipt({
      kind: "code-worktree",
      mode: "code",
      projectId: "44444444-4444-4444-8444-444444444444",
      checkoutRoot: "/workspace",
      worktreeRoot: "/workspace/child",
      verified: true,
    }),
    lifecycleStatus: "completed",
    occurredAt: decodeUtcTimestamp("2026-09-26T10:00:12.000Z"),
    reportedSummary: { status: "unavailable", truncated: false },
    files: {
      status: "recorded",
      items: [
        {
          path: "src/parser.ts",
          change: "modified",
          reference: "recorded-file",
          source: "provider-reported",
          verified: false,
        },
      ],
    },
    checks: { status: "unavailable", items: [] },
    blockers: { status: "recorded", items: [] },
    ...overrides,
    modelId: decodeProviderModelId(overrides.modelId ?? "first-model"),
  };
}
