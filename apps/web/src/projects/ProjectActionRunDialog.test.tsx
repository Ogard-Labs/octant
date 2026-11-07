import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeProjectTerminalResult,
  decodeProjectId,
  decodeProjectActionId,
} from "@octant/contracts";
import { ProjectActionRunDialog } from "./ProjectActionRunDialog";
const projectId = decodeProjectId("90000000-0000-4000-8000-000000000002");
const actionId = decodeProjectActionId("93000000-0000-4000-8000-000000000001");
const target = { projectId, actionId };
const preview = decodeProjectTerminalResult({
  kind: "project-action-preview",
  projectId,
  projectVersion: 1,
  action: { actionId, name: "Test", folder: "/worktrees/child", branch: "feature/child" },
});
beforeEach(() => sessionStorage.clear());
describe("a saved action beside its task", () => {
  it("shows the checkout before launch and never retries a lost launch reply", async () => {
    const execute = vi.fn(async (command: { kind: string }) => {
      if (command.kind === "preview-action") return preview;
      if (command.kind === "start-action") throw new Error("lost reply");
      return decodeProjectTerminalResult({
        kind: "project-terminal-refused",
        reason: "unavailable",
        message: "Run status is unavailable.",
      });
    });
    const user = userEvent.setup();
    render(
      <ProjectActionRunDialog
        client={{ execute } as never}
        target={target}
        storageKey="action-fixture"
        open
        onClose={() => {}}
        onOpenTerminal={() => {}}
      />,
    );
    expect(await screen.findByText("/worktrees/child")).toBeVisible();
    expect(screen.getByText(/feature\/child/)).toBeVisible();
    expect(execute.mock.calls.filter(([c]) => c.kind === "start-action")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Run action" }));
    await waitFor(() =>
      expect(execute.mock.calls.filter(([c]) => c.kind === "start-action")).toHaveLength(1),
    );
    expect(sessionStorage.getItem("action-fixture")).toMatch(/^[a-f0-9-]{36}$/);
    expect(await screen.findByRole("button", { name: "Open terminal" })).toBeVisible();
    expect(execute.mock.calls.filter(([c]) => c.kind === "start-action")).toHaveLength(1);
  });
  it("reattaches a retained run after remount without launching a command", async () => {
    sessionStorage.setItem("action-fixture", "90000000-0000-4000-8000-000000000008");
    const execute = vi.fn(async (_command: { kind: string }) =>
      decodeProjectTerminalResult({
        kind: "project-terminal",
        terminal: {
          projectId,
          terminalId: "90000000-0000-4000-8000-000000000008",
          state: "exited",
          exitCode: 7,
          posture: "approval-gated",
        },
        output: { text: "failed fixture", characters: 14, replace: false },
      }),
    );
    render(
      <ProjectActionRunDialog
        client={{ execute } as never}
        target={target}
        storageKey="action-fixture"
        open
        onClose={() => {}}
        onOpenTerminal={() => {}}
      />,
    );
    expect(await screen.findByText("Exited with code 7")).toBeVisible();
    expect(screen.getByText("failed fixture")).toBeVisible();
    expect(execute.mock.calls.every((args) => args[0]?.kind !== "start-action")).toBe(true);
  });
});
