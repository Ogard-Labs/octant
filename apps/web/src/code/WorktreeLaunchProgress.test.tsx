import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectTerminalClient } from "@octant/client-runtime/project-terminal-client";
import { decodeProjectTerminalCommand, decodeProjectTerminalResult } from "@octant/contracts";
import {
  WorktreeLaunchContext,
  WorktreeLaunchProgress,
  type WorktreeLaunch,
} from "./WorktreeLaunchProgress";

afterEach(cleanup);

it("opens setup details and cancels the running recipe on this checkout", async () => {
  const user = userEvent.setup();
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
  let cancelled = false;
  const execute = vi.fn<ProjectTerminalClient["execute"]>(async (command) => {
    if (command.kind === "worktree-preparation" && command.action === "cancel") cancelled = true;
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
        state: cancelled ? "cancelled" : "running",
        startedAt: "2026-11-23T10:00:00.000Z",
        ...(cancelled ? { completedAt: "2026-11-23T10:00:00.850Z" } : {}),
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
  render(
    <WorktreeLaunchContext.Provider
      value={{
        client: { execute },
        launches: new Map([[launch.threadId, launch]]),
        detailsThreadId: undefined,
        onDetails,
      }}
    >
      <WorktreeLaunchProgress launch={launch} />
    </WorktreeLaunchContext.Provider>,
  );
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
