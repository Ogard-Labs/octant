import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThreadSubagentOpenContext, ThreadSubagentsContext } from "../agents/threadSubagents";
import { ThreadInfo, useThreadInfoAttention, useThreadInfoPanel } from "./ThreadInfo";

function PendingReview(props: { readonly pending: boolean }) {
  useThreadInfoAttention("review", props.pending);
  return <p>Saved commands</p>;
}

function OpensPanel() {
  const panel = useThreadInfoPanel();
  return (
    <button onClick={() => panel?.open()} type="button">
      Show access
    </button>
  );
}

describe("ThreadInfo", () => {
  it("says on its button that a row inside the closed panel waits for the person", () => {
    const { rerender } = render(
      <ThreadInfo>
        <PendingReview pending />
      </ThreadInfo>,
    );

    expect(screen.getByText("Saved commands")).not.toBeVisible();
    // The button is an icon; a waiting review is the one thing it says in words.
    expect(screen.getByRole("button", { name: "Thread info, review required" })).toHaveTextContent(
      "Review required",
    );

    rerender(
      <ThreadInfo>
        <PendingReview pending={false} />
      </ThreadInfo>,
    );

    expect(screen.getByRole("button", { name: "Thread info" })).toHaveTextContent("");
  });

  it("keeps its rows mounted while closed and closes on a press outside it", () => {
    render(
      <>
        <ThreadInfo>
          <PendingReview pending={false} />
        </ThreadInfo>
        <p>Transcript</p>
      </>,
    );
    const row = screen.getByText("Saved commands");

    fireEvent.click(screen.getByRole("button", { name: "Thread info" }));
    expect(row).toBeVisible();

    fireEvent.pointerDown(screen.getByText("Transcript"));
    expect(row).not.toBeVisible();
    expect(screen.getByText("Saved commands")).toBe(row);
  });

  it("opens for a control that leads to one of its rows", () => {
    render(
      <ThreadInfo>
        <OpensPanel />
      </ThreadInfo>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show access", hidden: true }));

    expect(screen.getByRole("region", { name: "Thread info" })).toBeVisible();
  });

  it("leaves the panel open when Escape closes a menu one of its rows opened", () => {
    render(
      <ThreadInfo>
        <div role="menu">
          <button type="button">Low</button>
        </div>
      </ThreadInfo>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Thread info" }));

    fireEvent.keyDown(screen.getByRole("button", { name: "Low" }), { key: "Escape" });
    expect(screen.getByRole("region", { name: "Thread info" })).toBeVisible();

    fireEvent.keyDown(screen.getByRole("region", { name: "Thread info" }), { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Thread info" })).toBeNull();
    expect(screen.getByRole("button", { name: "Thread info" })).toHaveFocus();
  });

  it("lists the thread's running subagents, then the earlier ones, and opens each", () => {
    const entry = (runId: string, task: string, lifecycleStatus: string) => ({
      runId,
      requestId: `request-${runId}`,
      parentThreadId: "11111111-1111-4111-8111-111111111111",
      role: "research",
      task,
      lifecycleStatus,
      executionKind: "octant-managed",
      usageQuality: "provider-reported",
      resultAcknowledgement: { required: false, acknowledged: false },
      version: 1,
      updatedAt: "2026-11-26T10:00:00.000Z",
    });
    const onOpen = vi.fn();
    render(
      <ThreadSubagentsContext
        value={
          {
            status: "ready",
            entries: [
              entry("22222222-2222-4222-8222-222222222221", "Find the flaky test", "running"),
              entry("22222222-2222-4222-8222-222222222222", "Read the changelog", "completed"),
            ],
            observations: [],
          } as never
        }
      >
        <ThreadSubagentOpenContext value={onOpen}>
          <ThreadInfo>
            <p>Other rows</p>
          </ThreadInfo>
        </ThreadSubagentOpenContext>
      </ThreadSubagentsContext>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Thread info" }));
    expect(screen.getByText("1 running")).toBeVisible();
    expect(screen.getByText("Previous")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^Open Read the changelog/ }));
    expect(onOpen).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
  });
});
