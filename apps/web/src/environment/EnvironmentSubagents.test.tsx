import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentSubagents } from "./EnvironmentSubagents";

describe("EnvironmentSubagents", () => {
  it("shows active and completed runs with model and retained conversation", async () => {
    const user = userEvent.setup();
    const onOpenAgents = vi.fn();
    render(
      <EnvironmentSubagents
        client={
          {
            conversation: async () => ({
              runId: "30000000-0000-4000-8000-000000000001",
              parentThreadId: "20000000-0000-4000-8000-000000000001",
              executionKind: "octant-managed",
              modelId: "gpt-5.6-luna",
              lifecycleStatus: "completed",
              status: "complete",
              entries: [
                {
                  sequence: 1,
                  kind: "assistant",
                  text: "The shell is consistent.",
                  occurredAt: "2026-08-23T00:00:00.000Z",
                },
              ],
              truncated: false,
            }),
            parentSummary: async () => ({
              parentThreadId: "20000000-0000-4000-8000-000000000001",
              entries: [
                {
                  runId: "30000000-0000-4000-8000-000000000001",
                  requestId: "40000000-0000-4000-8000-000000000001",
                  parentThreadId: "20000000-0000-4000-8000-000000000001",
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
          } as never
        }
        onOpenAgents={onOpenAgents}
        threadId="20000000-0000-4000-8000-000000000001"
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
    render(
      <EnvironmentSubagents
        client={
          {
            conversation: async (runId: string) => ({
              runId: runId as never,
              parentThreadId: "20000000-0000-4000-8000-000000000001" as never,
              executionKind: "octant-managed",
              modelId: "gpt-5.6-luna" as never,
              lifecycleStatus: "running",
              status: "stale",
              entries: [],
              truncated: false,
              staleReason: "The child session is no longer connected to this host.",
            }),
            parentSummary: async () => ({
              parentThreadId: "20000000-0000-4000-8000-000000000001" as never,
              entries: [
                {
                  runId: "50000000-0000-4000-8000-000000000001" as never,
                  requestId: "40000000-0000-4000-8000-000000000002" as never,
                  parentThreadId: "20000000-0000-4000-8000-000000000001" as never,
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
          } as never
        }
        threadId="20000000-0000-4000-8000-000000000001"
      />,
    );
    await user.click(await screen.findByRole("button", { name: /Investigate the outage/ }));
    expect(await screen.findByText(/child session is no longer connected/i)).toBeVisible();
  });
});
