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

  it("lists each running subagent with its provider mark and opens the chosen one in Agents", async () => {
    const user = userEvent.setup();
    const onOpenAgents = vi.fn();
    const { container } = render(
      <EnvironmentSubagents
        client={summaryClient([
          entry(liveRunId, "running", { required: false, acknowledged: false }, CODEX),
          entry(otherLiveRunId, "running", { required: false, acknowledged: false }, CLAUDE),
          entry(reviewRunId, "completed", { required: true, acknowledged: false }),
          entry(completedRunId, "completed", { required: true, acknowledged: true }),
          entry(thirdFinishedRunId, "completed", { required: true, acknowledged: true }),
        ])}
        onOpenAgents={onOpenAgents}
        providers={providers}
        threadId={String(parentThreadId)}
      />,
    );

    expect(await screen.findByText("2 working · 1 to review · 2 done")).toBeVisible();
    const first = await screen.findByRole("button", {
      name: `Task ${String(liveRunId)}. Codex, GPT Astra, Working, 4m. Open in Agents`,
    });
    const second = screen.getByRole("button", {
      name: `Task ${String(otherLiveRunId)}. Claude, Opus Sonata, Working, 4m. Open in Agents`,
    });
    expect(first).toHaveTextContent("4m");
    expect(first.querySelector("svg[data-driver-kind='codex']")).not.toBeNull();
    expect(second.querySelector("svg[data-driver-kind='claude']")).not.toBeNull();
    // Two running rows, then the run that waits to be read on a line of its
    // own, then the ones that are simply done.
    expect(container.querySelectorAll(".environment-subagents__list > *")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "1 to review" })).toBeVisible();

    await user.click(first);
    expect(onOpenAgents).toHaveBeenCalledWith(String(liveRunId));
    await user.click(screen.getByRole("button", { name: "2 finished" }));
    expect(onOpenAgents).toHaveBeenLastCalledWith();
  });

  it("shows no mark or model for a running subagent whose host reported no route", async () => {
    render(
      <EnvironmentSubagents
        client={summaryClient([
          entry(liveRunId, "running", { required: false, acknowledged: false }),
        ])}
        onOpenAgents={vi.fn()}
        providers={providers}
        threadId={String(parentThreadId)}
      />,
    );

    const row = await screen.findByRole("button", {
      name: `Task ${String(liveRunId)}. Working, 4m. Open in Agents`,
    });
    expect(row.querySelector("svg[data-driver-kind]")).toBeNull();
    expect(row).not.toHaveAttribute("title", expect.stringContaining("Codex"));
  });

  it("caps the running rows and says how many more the Agents tool holds", async () => {
    const user = userEvent.setup();
    const onOpenAgents = vi.fn();
    const runs = Array.from({ length: 7 }, (_, index) =>
      entry(
        decodeAgentRunId(`70000000-0000-4000-8000-00000000000${String(index)}`),
        "running",
        { required: false, acknowledged: false },
        CODEX,
      ),
    );
    render(
      <EnvironmentSubagents
        client={summaryClient(runs)}
        onOpenAgents={onOpenAgents}
        providers={providers}
        threadId={String(parentThreadId)}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "+2 more" }));
    expect(onOpenAgents).toHaveBeenCalledWith();
    expect(screen.getAllByRole("button", { name: /Open in Agents$/ })).toHaveLength(5);
  });
});

const CODEX = "55555555-5555-4555-8555-555555555555";
const CLAUDE = "66666666-6666-4666-8666-666666666666";
const otherLiveRunId = decodeAgentRunId("50000000-0000-4000-8000-000000000002");
const thirdFinishedRunId = decodeAgentRunId("30000000-0000-4000-8000-000000000002");
const providers = new Map([
  [
    CODEX,
    { driverKind: "codex", displayName: "Codex", models: new Map([["gpt-astra", "GPT Astra"]]) },
  ],
  [
    CLAUDE,
    {
      driverKind: "claude",
      displayName: "Claude",
      models: new Map([["opus-sonata", "Opus Sonata"]]),
    },
  ],
]);

function summaryClient(entries: ReadonlyArray<ReturnType<typeof entry>>): AgentRunClient {
  return environmentClient({
    conversation: unusedClientMethod,
    parentSummary: async () => ({ parentThreadId, entries }),
  });
}

function entry(
  runId: typeof liveRunId,
  lifecycleStatus: "running" | "completed",
  resultAcknowledgement: { readonly required: boolean; readonly acknowledged: boolean },
  provider?: string,
) {
  return {
    ...(provider === undefined
      ? {}
      : {
          route: {
            requestedProviderInstanceId: provider,
            requestedModelId: provider === CODEX ? "gpt-astra" : "opus-sonata",
            executionProviderInstanceId: provider,
            executionModelId: provider === CODEX ? "gpt-astra" : "opus-sonata",
            poolDerived: false,
          },
        }),
    createdAt: new Date(Date.now() - 4 * 60_000).toISOString(),
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
