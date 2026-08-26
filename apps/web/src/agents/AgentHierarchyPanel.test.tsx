import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentHierarchyPanel } from "./AgentHierarchyPanel";

const entries = [
  {
    runId: "run-1",
    role: "research",
    task: "Active research",
    lifecycleStatus: "running",
    executionKind: "octant-managed",
    usageQuality: "provider-reported",
    resultAcknowledgement: { required: false, acknowledged: false },
    version: 2,
    updatedAt: "2026-08-01T15:01:00.000Z",
  },
  {
    runId: "run-2",
    role: "review",
    task: "Completed review",
    lifecycleStatus: "completed",
    executionKind: "provider-native",
    usageQuality: "estimated",
    resultAcknowledgement: {
      required: true,
      acknowledged: false,
      followUpReason: "unacknowledged-child-result",
    },
    version: 4,
    updatedAt: "2026-08-01T15:02:00.000Z",
  },
];

describe("AgentHierarchyPanel", () => {
  it("renders active children and can switch to history", async () => {
    const user = userEvent.setup();
    render(<AgentHierarchyPanel entries={entries} creationPosture="automatic" />);
    expect(screen.getByText("Active research")).toBeInTheDocument();
    expect(screen.queryByText("Completed review")).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Agent hierarchy filter" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Agent hierarchy filter" })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
    await user.click(screen.getByRole("option", { name: "History" }));
    expect(screen.getByText("Completed review")).toBeInTheDocument();
    expect(screen.getByText(/native read-only/i)).toBeInTheDocument();
  });

  it("invokes acknowledge for completed unacknowledged children", async () => {
    const user = userEvent.setup();
    const onAcknowledge = vi.fn();
    render(
      <AgentHierarchyPanel entries={entries} creationPosture="ask" onAcknowledge={onAcknowledge} />,
    );
    await user.click(screen.getByRole("combobox", { name: "Agent hierarchy filter" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Agent hierarchy filter" })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
    await user.click(screen.getByRole("option", { name: "History" }));
    await user.click(screen.getByRole("button", { name: /acknowledge result/i }));
    expect(onAcknowledge).toHaveBeenCalledWith({ runId: "run-2", version: 4 });
  });

  it("shows the honest server-authored route receipt for pool-routed children", () => {
    render(
      <AgentHierarchyPanel
        creationPosture="automatic"
        entries={[
          {
            ...entries[0]!,
            route: {
              requestedProviderInstanceId: "provider-a",
              requestedModelId: "gpt-4o",
              executionProviderInstanceId: "provider-b",
              executionModelId: "claude-x",
              poolDerived: true,
              selectionKind: "fallback",
              routingReason: "The requested model is unavailable; a permitted fallback ran.",
            },
          },
        ]}
      />,
    );
    expect(screen.getByText(/gpt-4o → claude-x · pool fallback/)).toBeInTheDocument();
    expect(
      screen.getByText(/The requested model is unavailable; a permitted fallback ran\./),
    ).toBeInTheDocument();
  });

  it("offers cancellation only for active rows and reports the selected run", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <AgentHierarchyPanel entries={entries} creationPosture="automatic" onCancel={onCancel} />,
    );
    expect(
      screen.getByRole("button", { name: "View conversation for Active research" }),
    ).toHaveAttribute("data-variant", "ghost");
    expect(screen.getByRole("button", { name: "Cancel Active research" })).toHaveAttribute(
      "data-variant",
      "secondary",
    );
    await user.click(screen.getByRole("button", { name: "Cancel Active research" }));
    expect(onCancel).toHaveBeenCalledWith({ runId: "run-1" });

    await user.click(screen.getByRole("combobox", { name: "Agent hierarchy filter" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Agent hierarchy filter" })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
    await user.click(screen.getByRole("option", { name: "History" }));
    expect(
      screen.queryByRole("button", { name: "Cancel Completed review" }),
    ).not.toBeInTheDocument();
  });

  it("inspects a live transcript while remaining the control surface", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onInspectConversation = vi.fn();
    render(
      <AgentHierarchyPanel
        conversation={
          {
            runId: "run-1",
            parentThreadId: "11111111-1111-4111-8111-111111111111",
            executionKind: "octant-managed",
            modelId: "gpt-5.6-luna",
            lifecycleStatus: "running",
            status: "live",
            entries: [
              {
                sequence: 1,
                kind: "assistant",
                text: "Live child reply",
                occurredAt: "2026-08-23T00:00:00.000Z",
              },
            ],
            truncated: false,
          } as never
        }
        creationPosture="automatic"
        entries={entries}
        onCancel={onCancel}
        onInspectConversation={onInspectConversation}
      />,
    );
    expect(screen.getByText("Live child reply")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel Active research" }));
    expect(onCancel).toHaveBeenCalledWith({ runId: "run-1" });
    await user.click(screen.getByRole("button", { name: "View conversation for Active research" }));
    expect(onInspectConversation).toHaveBeenCalledWith("run-1");
  });
});
