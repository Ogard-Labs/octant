import { describe, expect, it } from "vitest";
import { decodeAgentRunCenterSummary } from "@octant/contracts";
import {
  agentRunCenterThreadTarget,
  agentRunCommandFailureMessage,
  agentRunLifecycleLabel,
  agentRunModeLabel,
  filterAgentsCenterRows,
} from "./agentsCenterModel";

const summary = decodeAgentRunCenterSummary({
  runId: "11111111-1111-4111-8111-111111111111",
  requestId: "22222222-2222-4222-8222-222222222222",
  parentThreadId: "33333333-3333-4333-8333-333333333333",
  parentThreadTitle: "Design chat",
  mode: "chat",
  role: "research",
  task: "Summarize the design",
  lifecycleStatus: "running",
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
    requestedProviderInstanceId: "44444444-4444-4444-8444-444444444444",
    requestedModelId: "gpt-4o",
    executionProviderInstanceId: "44444444-4444-4444-8444-444444444444",
    executionModelId: "gpt-4o",
    poolDerived: false,
  },
  resultAcknowledgement: { required: false, acknowledged: false },
  version: 2,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:01:00.000Z",
});

describe("agentsCenterModel", () => {
  it("names lifecycle and mode in plain text", () => {
    expect(agentRunLifecycleLabel("running")).toBe("Running");
    expect(agentRunModeLabel("work")).toBe("Work");
  });

  it("filters rows client-side without changing server authority", () => {
    const rows = filterAgentsCenterRows([summary], {
      status: "active",
      mode: "chat",
      search: "summarize",
    });
    expect(rows).toHaveLength(1);
    expect(
      filterAgentsCenterRows([summary], {
        status: "history",
        mode: "chat",
        search: "",
      }),
    ).toHaveLength(0);
  });

  it("navigates Code child runs to the derived child thread", () => {
    expect(
      agentRunCenterThreadTarget({
        ...summary,
        mode: "code",
        childThreadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
      }),
    ).toEqual({
      mode: "code",
      threadId: String(summary.parentThreadId),
      childThreadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
  });

  it("surfaces stale-version refusal copy", () => {
    expect(agentRunCommandFailureMessage({ reason: "stale-version" })).toContain("Refresh");
  });
});
