import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import {
  decodeAgentRunId,
  decodeAgentRunParentThreadId,
  decodeProviderModelId,
  decodeUtcTimestamp,
  type AgentRunConversationResponse,
} from "@octant/contracts";
import { EnvironmentSubagents } from "./EnvironmentSubagents";

const parentThreadId = decodeAgentRunParentThreadId("20000000-0000-4000-8000-000000000001");
const completedRunId = decodeAgentRunId("30000000-0000-4000-8000-000000000001");
const liveRunId = decodeAgentRunId("50000000-0000-4000-8000-000000000001");
const nativeRunId = decodeAgentRunId("60000000-0000-4000-8000-000000000001");
const modelId = decodeProviderModelId("gpt-5.6-luna");
const occurredAt = decodeUtcTimestamp("2026-08-23T00:00:00.000Z");

const unusedClientMethod = (): Promise<never> =>
  Promise.reject(new Error("AgentRun client method is unused in this fixture"));

function environmentClient(
  input: Pick<AgentRunClient, "conversation" | "parentSummary">,
): AgentRunClient {
  return {
    conversation: input.conversation,
    parentSummary: input.parentSummary,
    center: unusedClientMethod,
    acknowledge: unusedClientMethod,
    prepareWorkspace: unusedClientMethod,
    confirmWorkspace: unusedClientMethod,
    preview: unusedClientMethod,
    requestRun: unusedClientMethod,
    cancel: unusedClientMethod,
    steer: unusedClientMethod,
    retry: unusedClientMethod,
    resume: unusedClientMethod,
  };
}

describe("EnvironmentSubagents", () => {
  it("shows active and completed runs with model and retained conversation", async () => {
    const user = userEvent.setup();
    const onOpenAgents = vi.fn();
    const conversation: AgentRunConversationResponse = {
      runId: completedRunId,
      parentThreadId,
      executionKind: "octant-managed",
      modelId,
      lifecycleStatus: "completed",
      status: "complete",
      entries: [
        {
          sequence: 1,
          kind: "assistant",
          text: "The shell is consistent.",
          occurredAt,
        },
      ],
      truncated: false,
    };
    render(
      <EnvironmentSubagents
        client={environmentClient({
          conversation: async () => conversation,
          parentSummary: async () => ({
            parentThreadId,
            entries: [
              {
                runId: completedRunId,
                requestId: "40000000-0000-4000-8000-000000000001",
                parentThreadId,
                role: "review",
                task: "Review the shell",
                lifecycleStatus: "completed",
                executionKind: "octant-managed",
                usageQuality: "exact",
                route: {
                  requestedProviderInstanceId: "provider",
                  requestedModelId: "gpt-5",
                  executionProviderInstanceId: "provider",
                  executionModelId: "gpt-5.6-luna",
                  poolDerived: false,
                },
                resultAcknowledgement: { required: false, acknowledged: false },
                result: {
                  reference: "result",
                  text: "The shell is consistent.",
                  truncated: false,
                },
                version: 2,
                updatedAt: "2026-08-23T00:00:00Z",
              },
            ],
          }),
        })}
        onOpenAgents={onOpenAgents}
        threadId={String(parentThreadId)}
      />,
    );

    expect(await screen.findByText("0 active · 1 done")).toBeVisible();
    expect(screen.getByText(/gpt-5\.6-luna · completed/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Review the shell/ }));
    expect(screen.getByText("The shell is consistent.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open Agents" }));
    expect(onOpenAgents).toHaveBeenCalledOnce();
  });

  it("shows a live managed response and stale copy without inventing native text", async () => {
    const user = userEvent.setup();
    const conversation: AgentRunConversationResponse = {
      runId: liveRunId,
      parentThreadId,
      executionKind: "octant-managed",
      modelId,
      lifecycleStatus: "running",
      status: "stale",
      entries: [],
      truncated: false,
      staleReason: "The child session is no longer connected to this host.",
    };
    render(
      <EnvironmentSubagents
        client={environmentClient({
          conversation: async () => conversation,
          parentSummary: async () => ({
            parentThreadId,
            entries: [
              {
                runId: liveRunId,
                requestId: "40000000-0000-4000-8000-000000000002",
                parentThreadId,
                role: "research",
                task: "Investigate the outage",
                lifecycleStatus: "running",
                executionKind: "octant-managed",
                usageQuality: "unavailable",
                resultAcknowledgement: { required: false, acknowledged: false },
                version: 2,
                updatedAt: "2026-08-23T00:00:00.000Z",
              },
            ],
          }),
        })}
        threadId={String(parentThreadId)}
      />,
    );
    await user.click(await screen.findByRole("button", { name: /Investigate the outage/ }));
    expect(await screen.findByText(/child session is no longer connected/i)).toBeVisible();
  });

  it("shows a compact live preview without inventing native text or offering Agents controls", async () => {
    const user = userEvent.setup();
    const onOpenAgents = vi.fn();
    const liveConversation: AgentRunConversationResponse = {
      runId: liveRunId,
      parentThreadId,
      executionKind: "octant-managed",
      modelId,
      lifecycleStatus: "running",
      status: "live",
      entries: [
        {
          sequence: 1,
          kind: "assistant",
          text: "Partial finding from the child.",
          occurredAt,
        },
      ],
      truncated: false,
    };
    const nativeConversation: AgentRunConversationResponse = {
      runId: nativeRunId,
      parentThreadId,
      executionKind: "provider-native",
      modelId,
      lifecycleStatus: "running",
      status: "unavailable",
      entries: [],
      truncated: false,
      staleReason: "Provider-native child transcript is not available through this host.",
    };
    render(
      <EnvironmentSubagents
        client={environmentClient({
          conversation: async (runId) =>
            String(runId) === String(liveRunId) ? liveConversation : nativeConversation,
          parentSummary: async () => ({
            parentThreadId,
            entries: [
              {
                runId: liveRunId,
                requestId: "40000000-0000-4000-8000-000000000002",
                parentThreadId,
                role: "research",
                task: "Investigate the outage",
                lifecycleStatus: "running",
                executionKind: "octant-managed",
                usageQuality: "unavailable",
                resultAcknowledgement: { required: false, acknowledged: false },
                version: 2,
                updatedAt: "2026-08-23T00:00:00.000Z",
              },
              {
                runId: nativeRunId,
                requestId: "40000000-0000-4000-8000-000000000003",
                parentThreadId,
                role: "research",
                task: "Native scout",
                lifecycleStatus: "running",
                executionKind: "provider-native",
                usageQuality: "unavailable",
                resultAcknowledgement: { required: false, acknowledged: false },
                version: 2,
                updatedAt: "2026-08-23T00:00:00.000Z",
              },
            ],
          }),
        })}
        onOpenAgents={onOpenAgents}
        threadId={String(parentThreadId)}
      />,
    );
    await user.click(await screen.findByRole("button", { name: /Investigate the outage/ }));
    expect(await screen.findByText("Partial finding from the child.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Native scout/ }));
    expect(await screen.findByText(/live response text is unavailable/i)).toBeVisible();
    expect(screen.queryByText("secret native transcript")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Agents" }));
    expect(onOpenAgents).toHaveBeenCalledOnce();
  });
});
