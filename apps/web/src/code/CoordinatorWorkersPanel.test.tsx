import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  CoordinatorWorkerCards,
  CoordinatorWorkersPanel,
  CoordinatorWorkersPanelSlot,
  CoordinatorWorkersToggle,
  WorkerOfStrip,
} from "./CoordinatorWorkersPanel";
import type { CoordinatorWorkerRow } from "./coordinatorWorkerPanel";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");

function row(id: string, state: CoordinatorWorkerRow["state"], extra = {}): CoordinatorWorkerRow {
  return {
    threadId: id,
    title: `Worker ${id}`,
    projectId: "p" as never,
    state,
    modelLabel: "Sonnet 5.5",
    updatedAt: "2026-11-15T11:00:00.000Z",
    ...extra,
  };
}

describe("the coordinator's Workers panel", () => {
  const rows = [
    row("ask", "needs-you"),
    row("run", "working"),
    row("pr", "in-review", {
      pullRequest: { identity: { number: 12 }, state: "open", checks: "passing" },
    }),
    row("d1", "done"),
    row("d2", "done"),
  ];

  it("lists Needs you, Working, In review, then Done folded, with each row's title, state, model and time", async () => {
    const onOpenWorker = vi.fn();
    const onSelectPullRequest = vi.fn();
    render(
      <CoordinatorWorkersPanel
        coordinatorThreadId="c"
        coordinatorTitle="Backlog"
        now={NOW}
        onSelectPullRequest={onSelectPullRequest}
        source={{ rows, onOpenWorker }}
      />,
    );
    const panel = screen.getByRole("complementary", { name: "Workers of Backlog" });
    expect(
      within(panel)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Needs you · 1", "Working · 1", "In review · 1", "Done · 2"]);
    const askRow = within(panel).getByRole("button", { name: /Worker ask/ });
    expect(askRow).toHaveTextContent("Needs you");
    expect(askRow).toHaveTextContent("Sonnet 5.5");
    expect(askRow).toHaveTextContent("1h ago");
    await userEvent.click(within(panel).getByRole("button", { name: "Pull request #12 · Open" }));
    expect(onSelectPullRequest).toHaveBeenCalledWith(expect.objectContaining({ threadId: "pr" }));
    // Done is folded until asked for.
    expect(within(panel).queryByRole("button", { name: /Worker d1/ })).toBeNull();

    await userEvent.click(within(panel).getByRole("button", { name: "Show more" }));
    await userEvent.click(within(panel).getByRole("button", { name: /Worker d1/ }));
    expect(onOpenWorker).toHaveBeenCalledWith("d1");
  });

  it("opens from the pane header's Workers button, says who needs you, and closes", async () => {
    render(
      <>
        <CoordinatorWorkersToggle coordinatorThreadId="toggle" needsYouCount={2} workerCount={5} />
        <CoordinatorWorkersPanelSlot
          coordinatorThreadId="toggle"
          coordinatorTitle="Backlog"
          source={{ rows, onOpenWorker: vi.fn() }}
        />
      </>,
    );
    const button = screen.getByRole("button", { name: /Workers/ });
    expect(button).toHaveTextContent("5");
    expect(button).toHaveAccessibleName(/2 need you/);
    expect(screen.queryByRole("complementary")).toBeNull();
    await userEvent.click(button);
    expect(screen.getByRole("complementary", { name: "Workers of Backlog" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Close Workers" }));
    expect(screen.queryByRole("complementary")).toBeNull();
  });
});

describe("worker cards in the coordinator's transcript", () => {
  it("follows the worker's live state and opens it", async () => {
    const onOpenWorker = vi.fn();
    const { rerender } = render(
      <CoordinatorWorkerCards onOpenWorker={onOpenWorker} rows={[row("w", "working")]} />,
    );
    const card = screen.getByRole("button", { name: "Worker Worker w, Working" });
    expect(card).toHaveTextContent("Sonnet 5.5");

    rerender(<CoordinatorWorkerCards onOpenWorker={onOpenWorker} rows={[row("w", "needs-you")]} />);
    await userEvent.click(screen.getByRole("button", { name: "Worker Worker w, Needs you" }));
    expect(onOpenWorker).toHaveBeenCalledWith("w");
  });
});

describe("a worker's pane header", () => {
  it("names its coordinator and offers the way back", async () => {
    const onBack = vi.fn();
    render(<WorkerOfStrip coordinatorTitle="Backlog" onBack={onBack} />);
    expect(screen.getByRole("img", { name: "Worker of Backlog" })).toBeVisible();
    expect(screen.getByText("Worker of Backlog")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back to coordinator" }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
