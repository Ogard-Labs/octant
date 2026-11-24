import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectTerminalClient } from "@octant/client-runtime/project-terminal-client";
import { decodeProjectTerminalCommand, decodeProjectTerminalResult } from "@octant/contracts";
import { WorktreeLaunchProgress } from "./WorktreeLaunchProgress";
import { WorktreeLaunchContext, type WorktreeLaunch } from "./worktreeLaunchContext";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function progressFixture() {
  const target = decodeProjectTerminalCommand({
    kind: "worktree-preparation",
    projectId: "90000000-0000-4000-8000-000000000001",
    thread: {
      threadId: "90000000-0000-4000-8000-000000000002",
      checkoutId: "90000000-0000-4000-8000-000000000003",
    },
    action: "inspect",
  });
  if (target.kind !== "worktree-preparation") throw new Error("Expected worktree preparation");
  const { kind: _kind, action: _action, ...binding } = target;
  let state: "running" | "cancelled" | "succeeded" = "running";
  const execute = vi.fn<ProjectTerminalClient["execute"]>(async (command) => {
    if (command.kind === "worktree-preparation" && command.action === "cancel") state = "cancelled";
    return decodeProjectTerminalResult({
      kind: "worktree-preparation",
      receiptId: "90000000-0000-4000-8000-000000000004",
      output: "",
      outputTruncated: false,
      preparation: {
        recipe: {
          id: "90000000-0000-4000-8000-000000000005",
          name: "Prepare",
          command: "bun install",
          directory: ".",
        },
        state,
        startedAt: "2026-11-23T10:00:00.000Z",
        ...(state === "running" ? {} : { completedAt: "2026-11-23T10:00:00.850Z" }),
      },
    });
  });
  const onDetails = vi.fn();
  const launch: WorktreeLaunch = {
    threadId: binding.thread.threadId,
    composerId: "composer",
    projectId: binding.projectId,
    startFromOrigin: true,
    phase: "ready",
    sourceMs: 80,
    checkoutMs: 240,
    target: binding,
    turn: "starting",
  };
  const panel = (initial: WorktreeLaunch, detailsOpen = false) => (
    <WorktreeLaunchContext.Provider
      value={{
        client: { execute },
        launches: new Map([[launch.threadId, launch]]),
        detailsThreadId: detailsOpen ? initial.threadId : undefined,
        onDetails,
      }}
    >
      <WorktreeLaunchProgress launch={initial} />
    </WorktreeLaunchContext.Provider>
  );
  return { binding, execute, launch, onDetails, panel, finish: () => (state = "succeeded") };
}

it("opens setup details and cancels the running recipe on this checkout", async () => {
  const user = userEvent.setup();
  const { binding, execute, launch, onDetails, panel } = progressFixture();
  render(panel(launch));
  const list = screen.getByRole("list", { name: "Worktree setup stages" });
  expect(within(list).getByText("Done · 80 ms")).toBeVisible();
  await user.click(await screen.findByRole("button", { name: "Setup details" }));
  expect(onDetails).toHaveBeenCalledExactlyOnceWith(binding);
  await user.click(await screen.findByRole("button", { name: "Cancel setup" }));
  expect(execute).toHaveBeenCalledWith({
    kind: "worktree-preparation",
    ...binding,
    action: "cancel",
  });
  expect(await within(list).findByText("Cancelled · 850 ms")).toBeVisible();
});

it("updates until a retry finishes after closing setup details on a refused start", async () => {
  vi.useFakeTimers();
  const { execute, finish, launch, panel } = progressFixture();
  const refused: WorktreeLaunch = { ...launch, blocked: true };
  const { rerender } = render(panel(refused, true));
  expect(execute).not.toHaveBeenCalled();

  await act(async () => rerender(panel(refused)));
  expect(screen.getByRole("button", { name: "Cancel setup" })).toBeVisible();
  expect(screen.getByText("Setting up worktree")).toBeVisible();
  finish();
  await act(async () => vi.advanceTimersByTimeAsync(1000));

  expect(screen.getByText("Done · 850 ms")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Cancel setup" })).not.toBeInTheDocument();
  expect(execute).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(execute).toHaveBeenCalledTimes(2);
});
