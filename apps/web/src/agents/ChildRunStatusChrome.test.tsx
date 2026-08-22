import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChildRunStatusChrome } from "./ChildRunStatusChrome";
import type { AgentHierarchyInputEntry } from "./buildAgentHierarchyModel";
import { buildChildRunStatusSummary } from "./buildChildRunStatusSummary";

function entry(
  runId: string,
  lifecycleStatus: string,
  acknowledgement: { required?: boolean; acknowledged?: boolean } = {},
): AgentHierarchyInputEntry {
  return {
    runId,
    role: "worker",
    task: `task ${runId}`,
    lifecycleStatus,
    executionKind: "managed",
    usageQuality: "measured",
    resultAcknowledgement: {
      required: acknowledgement.required ?? false,
      acknowledged: acknowledgement.acknowledged ?? false,
    },
    version: 1,
    updatedAt: "2026-08-14T10:00:00.000Z",
  };
}

function renderChrome(
  entries: ReadonlyArray<AgentHierarchyInputEntry>,
  overrides: Partial<Parameters<typeof ChildRunStatusChrome>[0]> = {},
) {
  const onStopChildren = vi.fn();
  render(
    <ChildRunStatusChrome
      entries={entries}
      onStopChildren={onStopChildren}
      summary={buildChildRunStatusSummary(entries)}
      {...overrides}
    />,
  );
  return { onStopChildren };
}

describe("ChildRunStatusChrome", () => {
  it("renders an empty summary in words with nothing to stop", () => {
    renderChrome([]);

    const chrome = screen.getByRole("region", { name: "Child run status" });
    expect(chrome).toHaveTextContent("No child runs · Idle");
    expect(chrome).toHaveTextContent("This thread has no outstanding child runs.");
    expect(
      screen.queryByRole("button", { name: "Stop this thread's children" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show child runs" })).toBeDisabled();
  });

  it("offers Add agent so the Agents dock can open from an empty hierarchy", async () => {
    const user = userEvent.setup();
    const onAddAgent = vi.fn();
    renderChrome([], { onAddAgent });
    await user.click(screen.getByRole("button", { name: "Add agent" }));
    expect(onAddAgent).toHaveBeenCalled();
  });

  it("renders working, waiting, and blocked summaries as words beside an icon", () => {
    const cases = [
      { entries: [entry("a", "running")], text: "1 child run · Working" },
      { entries: [entry("a", "waiting")], text: "1 child run · Waiting" },
      { entries: [entry("a", "failed", { required: true })], text: "1 child run · Blocked" },
    ];
    for (const { entries, text } of cases) {
      const { unmount } = render(
        <ChildRunStatusChrome
          entries={entries}
          onStopChildren={vi.fn()}
          summary={buildChildRunStatusSummary(entries)}
        />,
      );
      // Every icon is aria-hidden, so the state must survive on text alone.
      expect(screen.getByRole("region", { name: "Child run status" })).toHaveTextContent(text);
      unmount();
    }
  });

  it("opens the existing hierarchy panel rather than a second child-run list", async () => {
    const user = userEvent.setup();
    renderChrome([entry("a", "running")]);

    expect(screen.queryByRole("region", { name: "Agents hierarchy" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show child runs" }));

    expect(screen.getByRole("region", { name: "Agents hierarchy" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Hide child runs" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("asks before stopping and does not stop until the user confirms", async () => {
    const user = userEvent.setup();
    const { onStopChildren } = renderChrome([entry("a", "running"), entry("b", "waiting")]);

    await user.click(screen.getByRole("button", { name: "Stop this thread's children" }));

    expect(onStopChildren).not.toHaveBeenCalled();
    const confirm = screen.getByRole("group", { name: "Confirm stopping child runs" });
    expect(confirm).toHaveTextContent("Stop all 2 live child runs on this thread?");
    expect(confirm).toHaveTextContent("Only this thread's children are affected.");

    await user.click(screen.getByRole("button", { name: "Stop 2 child runs" }));
    expect(onStopChildren).toHaveBeenCalledTimes(1);
  });

  it("keeps the children running when the confirmation is declined", async () => {
    const user = userEvent.setup();
    const { onStopChildren } = renderChrome([entry("a", "running"), entry("b", "running")]);

    await user.click(screen.getByRole("button", { name: "Stop this thread's children" }));
    await user.click(screen.getByRole("button", { name: "Keep running" }));

    expect(onStopChildren).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("group", { name: "Confirm stopping child runs" }),
    ).not.toBeInTheDocument();
  });

  it("confirms a single-child stop with its own exact wording", async () => {
    const user = userEvent.setup();
    renderChrome([entry("a", "running")]);

    await user.click(screen.getByRole("button", { name: "Stop this thread's children" }));

    expect(screen.getByRole("group", { name: "Confirm stopping child runs" })).toHaveTextContent(
      "Stop the 1 live child run on this thread?",
    );
    expect(screen.getByRole("button", { name: "Stop 1 child run" })).toBeVisible();
  });

  it("is keyboard operable end to end", async () => {
    const user = userEvent.setup();
    const { onStopChildren } = renderChrome([entry("a", "running"), entry("b", "running")]);

    screen.getByRole("button", { name: "Stop this thread's children" }).focus();
    await user.keyboard("{Enter}");
    screen.getByRole("button", { name: "Stop 2 child runs" }).focus();
    await user.keyboard("{Enter}");

    expect(onStopChildren).toHaveBeenCalledTimes(1);
  });

  it("says it is showing stale status while reconnecting", () => {
    renderChrome([entry("a", "running")], { reconnecting: true });

    expect(
      screen.getByText("Reconnecting. Showing the last child-run status the host reported."),
    ).toBeVisible();
  });

  it("surfaces a failed stop as an alert instead of implying success", () => {
    renderChrome([entry("a", "running")], {
      errorMessage: "Child runs could not be stopped. They are still running.",
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Child runs could not be stopped. They are still running.",
    );
  });

  it("disables the stop control while a stop is in flight", () => {
    renderChrome([entry("a", "running")], { busy: true });

    expect(screen.getByRole("button", { name: "Stop this thread's children" })).toBeDisabled();
  });
});
