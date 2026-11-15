import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { decodeCodeThreadId, type CodeLiveTask } from "@octant/contracts";
import { CodeLiveTasks } from "./CodeLiveTasks";
import type { CodeSessionClient } from "./codeSessionClient";

const threadId = decodeCodeThreadId("22222222-2222-4222-8222-222222222223");

function client(initial: ReadonlyArray<CodeLiveTask>, turnRunning = false) {
  let tasks = initial;
  const stopLiveTasks = vi.fn<CodeSessionClient["stopLiveTasks"]>(async () => {
    tasks = [];
    return { kind: "code-live-tasks-stopped", stopped: true };
  });
  const value: CodeSessionClient = {
    liveTasks: async () => ({ threadId, tasks, turnRunning }),
    stopLiveTasks,
  };
  return { value, stopLiveTasks };
}

describe("Code live tasks", () => {
  it("shows the background tasks a finished turn left running and stops them with the session", async () => {
    const user = userEvent.setup();
    const { value, stopLiveTasks } = client([
      { taskId: "bash-1", description: "bun run dev" },
      { taskId: "bash-2", description: "tail -f server.log" },
    ]);
    render(<CodeLiveTasks threadId={threadId} client={value} />);

    expect(await screen.findByText("bun run dev")).toBeTruthy();
    expect(screen.getByText("tail -f server.log")).toBeTruthy();
    expect(screen.getByText("2 running")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Stop the live tasks" }));
    expect(stopLiveTasks).toHaveBeenCalledWith(threadId);
    await waitFor(() => expect(screen.queryByLabelText("Live tasks")).toBeNull());
  });

  it("shows nothing while a turn holds the session, which shows its own tasks", async () => {
    const { value } = client([{ taskId: "bash-1", description: "bun run dev" }], true);
    const liveTasks = vi.spyOn(value, "liveTasks");
    const { container } = render(<CodeLiveTasks threadId={threadId} client={value} />);
    await waitFor(() => expect(liveTasks).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});
