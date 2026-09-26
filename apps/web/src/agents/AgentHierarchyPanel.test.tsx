import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentHierarchyPanel } from "./AgentHierarchyPanel";
import type { AgentHierarchyInputEntry } from "./buildAgentHierarchyModel";

const entries: ReadonlyArray<AgentHierarchyInputEntry> = [
  {
    runId: "run-live",
    role: "research",
    task: "Active research",
    lifecycleStatus: "running",
    executionKind: "octant-managed",
    usageQuality: "provider-reported",
    resultAcknowledgement: { required: false, acknowledged: false },
    route: {
      requestedProviderInstanceId: "provider-a",
      requestedModelId: "gpt-6-astra",
      executionProviderInstanceId: "provider-a",
      executionModelId: "gpt-6-astra",
      poolDerived: false,
    },
    version: 2,
    updatedAt: "2026-08-01T15:01:00.000Z",
  },
  {
    runId: "run-older",
    role: "review",
    task: "Older review",
    lifecycleStatus: "completed",
    executionKind: "octant-managed",
    usageQuality: "estimated",
    resultAcknowledgement: { required: true, acknowledged: true },
    version: 3,
    updatedAt: "2026-08-01T15:00:00.000Z",
  },
  {
    runId: "run-newer",
    role: "review",
    task: "Newer review",
    lifecycleStatus: "completed",
    executionKind: "provider-native",
    usageQuality: "estimated",
    resultAcknowledgement: { required: true, acknowledged: false },
    version: 4,
    updatedAt: "2026-08-01T15:02:00.000Z",
  },
];

describe("AgentHierarchyPanel", () => {
  it("lists working subagents apart from finished ones, newest finished first", () => {
    render(<AgentHierarchyPanel entries={entries} creationPosture="automatic" />);

    const working = screen.getByRole("region", { name: "Working" });
    expect(within(working).getByRole("button", { name: /Active research/ })).toHaveTextContent(
      "Working · Research · gpt-6-astra",
    );
    const finished = screen.getByRole("region", { name: "Finished" });
    const rows = within(finished).getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Newer review"),
      expect.stringContaining("Older review"),
    ]);
    // Only the result nobody has looked at yet asks for review, in words.
    expect(rows[0]).toHaveTextContent("Needs review");
    expect(rows[1]).not.toHaveTextContent("Needs review");
  });

  it("opens the subagent whose row is chosen", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<AgentHierarchyPanel entries={entries} onOpen={onOpen} />);

    await user.click(screen.getByRole("button", { name: /Newer review/ }));

    expect(onOpen).toHaveBeenCalledWith("run-newer");
  });

  it("keeps New subagent folded behind New once the thread has subagents", async () => {
    const user = userEvent.setup();
    render(<AgentHierarchyPanel creation={<p>Create form</p>} entries={entries} />);

    expect(screen.queryByText("Create form")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New" }));
    expect(screen.getByText("Create form")).toBeVisible();
  });

  it("shows New subagent at once on a thread with none, under a plain empty line", () => {
    render(<AgentHierarchyPanel creation={<p>Create form</p>} entries={[]} />);

    expect(screen.getByRole("status")).toHaveTextContent("No subagents on this thread yet.");
    expect(screen.getByText("Create form")).toBeVisible();
    expect(screen.getByRole("button", { name: "New" })).toHaveAttribute("aria-expanded", "true");
  });
});
