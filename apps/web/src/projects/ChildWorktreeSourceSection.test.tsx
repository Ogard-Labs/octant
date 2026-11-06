import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { decodeProjectTerminalCommand, decodeProjectTerminalResult } from "@octant/contracts";
import { ChildWorktreeSourceSection } from "./ChildWorktreeSourceSection";
afterEach(cleanup);
it("keeps committed source until the person reviews and explicitly selects a captured snapshot", async () => {
  const target = decodeProjectTerminalCommand({
    kind: "child-worktree-source",
    projectId: "90000000-0000-4000-8000-000000000001",
    thread: {
      threadId: "90000000-0000-4000-8000-000000000002",
      checkoutId: "90000000-0000-4000-8000-000000000003",
    },
    action: "inspect",
  });
  if (target.kind !== "child-worktree-source") throw new Error("Invalid fixture");
  const preview = {
    id: "90000000-0000-4000-8000-000000000004",
    baseRevision: "a".repeat(40),
    capturedAt: "2026-11-06T10:00:00.000Z",
    files: [{ path: "new.txt", index: "?", worktree: "?" }],
  };
  const execute = vi.fn(
    async (
      command: Parameters<
        import("@octant/client-runtime/project-terminal-client").ProjectTerminalClient["execute"]
      >[0],
    ) =>
      decodeProjectTerminalResult({
        kind: "child-worktree-source",
        review:
          command.kind === "child-worktree-source" && command.action === "use-snapshot"
            ? { selection: "snapshot", selected: preview, preview }
            : command.kind === "child-worktree-source" && command.action === "capture"
              ? { selection: "committed", preview }
              : { selection: "committed" },
      }),
  );
  render(<ChildWorktreeSourceSection client={{ execute }} target={target} />);
  await screen.findByText("Committed revision selected");
  await userEvent.click(screen.getByRole("button", { name: "Review current edits" }));
  expect(await screen.findByText(/new.txt — untracked/)).toBeVisible();
  expect(screen.getByText("Committed revision selected")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Use this snapshot" }));
  await waitFor(() =>
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "use-snapshot",
        snapshotId: preview.id,
        thread: target.thread,
      }),
    ),
  );
  expect(await screen.findByText(/Current edits snapshot selected:/)).toBeVisible();
});
