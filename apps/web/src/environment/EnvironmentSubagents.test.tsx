import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { decodeAgentRunId, decodeAgentRunParentThreadId } from "@octant/contracts";
import { EnvironmentSubagents } from "./EnvironmentSubagents";

const parentThreadId = decodeAgentRunParentThreadId("20000000-0000-4000-8000-000000000001");
const completedRunId = decodeAgentRunId("30000000-0000-4000-8000-000000000001");
const liveRunId = decodeAgentRunId("50000000-0000-4000-8000-000000000001");
const reviewRunId = decodeAgentRunId("60000000-0000-4000-8000-000000000001");

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
    cancel: unusedClientMethod,
    steer: unusedClientMethod,
    retry: unusedClientMethod,
    resume: unusedClientMethod,
    usageResume: unusedClientMethod,
    snapshotCanvas: unusedClientMethod,
  };
}

describe("EnvironmentSubagents", () => {
  it("says None rather than vanishing when the thread has delegated nothing", async () => {
    const user = userEvent.setup();
    render(
      <EnvironmentSubagents
        client={environmentClient({
          conversation: unusedClientMethod,
          parentSummary: async () => ({ parentThreadId, entries: [] }),
        })}
        threadId={String(parentThreadId)}
      />,
    );

    expect(await screen.findByText("None")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^Subagents/ }));
    expect(screen.getByText(/They appear when the agent hands off part of its work/)).toBeVisible();
  });

  it("does not claim there are none before the first read has answered", async () => {
    const user = userEvent.setup();
    render(
      <EnvironmentSubagents
        client={environmentClient({
          conversation: unusedClientMethod,
          parentSummary: () => new Promise(() => {}),
        })}
        threadId={String(parentThreadId)}
      />,
    );

    await user.click(screen.getByRole("button", { name: /^Subagents/ }));
    expect(screen.queryByText(/They appear when the agent hands off part of its work/)).toBeNull();
    expect(screen.getByText("Reading subagents…")).toBeVisible();
  });

  it("lists every subagent, working and finished, and opens the chosen one in Agents", async () => {
    const user = userEvent.setup();
    const onOpenAgents = vi.fn();
    render(
      <EnvironmentSubagents
        client={environmentClient({
          conversation: unusedClientMethod,
          parentSummary: async () => ({
            parentThreadId,
            entries: [
              entry(liveRunId, "running", { required: false, acknowledged: false }),
              entry(reviewRunId, "completed", { required: true, acknowledged: false }),
              entry(completedRunId, "completed", { required: true, acknowledged: true }),
            ],
          }),
        })}
        onOpenAgents={onOpenAgents}
        threadId={String(parentThreadId)}
      />,
    );

    expect(await screen.findByText("1 working · 1 to review · 1 done")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^Subagents/ }));
    expect(
      within(screen.getByRole("region", { name: "Working" })).getAllByRole("listitem"),
    ).toHaveLength(1);
    expect(
      within(screen.getByRole("region", { name: "Finished" })).getAllByRole("listitem"),
    ).toHaveLength(2);

    await user.click(
      screen.getByRole("button", {
        name: `Task ${String(reviewRunId)}. To review. Open in Agents`,
      }),
    );
    expect(onOpenAgents).toHaveBeenCalledWith(String(reviewRunId));
  });
});

function entry(
  runId: typeof liveRunId,
  lifecycleStatus: "running" | "completed",
  resultAcknowledgement: { readonly required: boolean; readonly acknowledged: boolean },
) {
  return {
    runId,
    requestId: "40000000-0000-4000-8000-000000000001",
    parentThreadId,
    role: "review" as const,
    task: `Task ${String(runId)}`,
    lifecycleStatus,
    executionKind: "octant-managed" as const,
    usageQuality: "exact" as const,
    resultAcknowledgement,
    version: 2,
    updatedAt: "2026-08-23T00:00:00Z",
  };
}
