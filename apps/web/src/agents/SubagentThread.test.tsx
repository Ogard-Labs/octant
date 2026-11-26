import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { AgentRunConversationEntry } from "@octant/contracts";
import { decodeAgentRunId, decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import { SubagentThread } from "./SubagentThread";

const parentThreadId = decodeAgentRunParentThreadId("11111111-1111-4111-8111-111111111111");
const runId = decodeAgentRunId("22222222-2222-4222-8222-222222222222");
const at = "2026-11-26T10:00:00.000Z" as AgentRunConversationEntry["occurredAt"];

function client(
  lifecycleStatus: string,
  options: {
    readonly executionKind?: string;
    readonly entries?: ReadonlyArray<AgentRunConversationEntry>;
  } = {},
): AgentRunClient {
  const executionKind = options.executionKind ?? "octant-managed";
  return {
    center: vi.fn(async () => ({ items: [] })),
    conversation: vi.fn(async () => ({
      runId,
      parentThreadId,
      executionKind: executionKind as never,
      modelId: "test-model" as never,
      lifecycleStatus: lifecycleStatus as never,
      status: "live" as const,
      entries: options.entries ?? [],
      truncated: false,
    })),
    parentSummary: vi.fn(async () => ({
      parentThreadId,
      entries: [
        {
          runId,
          requestId: "request-1",
          parentThreadId,
          role: "research",
          task: "Find the flaky test",
          lifecycleStatus,
          executionKind,
          usageQuality: "provider-reported",
          resultAcknowledgement: { required: false, acknowledged: false },
          version: 3,
          updatedAt: "2026-11-26T10:01:00.000Z",
        },
      ],
    })),
    acknowledge: vi.fn(async () => ({ kind: "run-updated" as const, run: {} as never })),
    cancel: vi.fn(async () => ({ results: [] })),
    steer: vi.fn(async () => ({ kind: "run-updated" as const, run: {} as never })),
    retry: vi.fn(async () => ({ kind: "run-updated" as const, run: {} as never })),
    resume: vi.fn(async () => ({ kind: "run-updated" as const, run: {} as never })),
    usageResume: vi.fn(async () => ({ kind: "run-updated" as const, run: {} as never })),
    snapshotCanvas: vi.fn(),
  } as unknown as AgentRunClient;
}

function view(runs: AgentRunClient, onOpenParent = vi.fn()) {
  render(
    <SubagentThread
      client={runs}
      onOpenParent={onOpenParent}
      parentThreadId={parentThreadId}
      parentTitle="Fix the release build"
      runId={String(runId)}
      title="Find the flaky test"
    />,
  );
  return onOpenParent;
}

describe("SubagentThread", () => {
  it("opens headed Subagent of its thread, which leads back there", async () => {
    const onOpenParent = view(client("running"));
    expect(await screen.findByRole("heading", { name: "Find the flaky test" })).toBeVisible();
    expect(screen.getByText("Subagent of")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Fix the release build" }));
    expect(onOpenParent).toHaveBeenCalledOnce();
  });

  it("shows the brief, its replies and the tool steps it took", async () => {
    view(
      client("running", {
        entries: [
          { sequence: 1, kind: "assistant", text: "Running the tests.", occurredAt: at },
          {
            sequence: 2,
            kind: "tool",
            text: "bun run test",
            occurredAt: at,
            tool: {
              toolCallId: "call-1",
              toolName: "Bash",
              state: "started",
              summary: "bun run test",
            },
          },
        ],
      }),
    );
    expect(
      await screen.findByRole("article", { name: "The brief it was given" }),
    ).toHaveTextContent("Find the flaky test");
    expect(await screen.findByText("Running the tests.")).toBeVisible();
    // The step's line sits in its activity row, folded as in any thread.
    expect((await screen.findAllByText(/bun run test/)).length).toBeGreaterThan(0);
  });

  it("steers a running subagent with what is typed in its composer", async () => {
    const runs = client("running");
    view(runs);
    const field = await screen.findByRole("textbox", { name: "Steering note" });
    await userEvent.type(field, "Skip the docs{Enter}");
    await waitFor(() =>
      expect(runs.steer).toHaveBeenCalledWith(
        expect.objectContaining({ runId, message: "Skip the docs", expectedVersion: 3 }),
      ),
    );
  });

  it("continues a finished subagent with the typed message", async () => {
    const runs = client("completed");
    view(runs);
    const field = await screen.findByRole("textbox", { name: "Message to continue it" });
    await userEvent.type(field, "Now fix it{Enter}");
    await waitFor(() =>
      expect(runs.resume).toHaveBeenCalledWith(
        expect.objectContaining({ runId, message: "Now fix it", expectedVersion: 3 }),
      ),
    );
    expect(runs.steer).not.toHaveBeenCalled();
  });

  it("reads the conversation again once a continued subagent works again", async () => {
    let status = "completed";
    const runs = client("completed");
    const summary = runs.parentSummary as ReturnType<typeof vi.fn>;
    const first = await (
      summary.getMockImplementation() as () => Promise<{
        readonly entries: ReadonlyArray<Record<string, unknown>>;
      }>
    )();
    summary.mockImplementation(async () => ({
      ...first,
      parentThreadId,
      entries: first.entries.map((entry) => ({ ...entry, lifecycleStatus: status })),
    }));
    (runs.resume as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      status = "running";
      return { kind: "run-updated" as const, run: {} as never };
    });
    view(runs);
    const field = await screen.findByRole("textbox", { name: "Message to continue it" });
    await waitFor(() => expect(runs.conversation).toHaveBeenCalledTimes(1));
    await userEvent.type(field, "Now fix it{Enter}");
    await waitFor(() => expect(runs.conversation).toHaveBeenCalledTimes(2));
  });

  it("opens a subagent the provider runs read-only, with no composer", async () => {
    view(client("running", { executionKind: "provider-native" }));
    expect(
      await screen.findByText("Runs inside the provider. Octant can read it but not steer it."),
    ).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
