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
  it("reviews the exact server and unconstrained SSH authority and echoes placement without retrying transport loss", async () => {
    const server = {
      serverId: "5e7e0000-0000-4000-8000-000000000001",
      alias: "web-1",
      user: "deploy",
      profile: "operate",
      confinement: "none",
      taskExecutionPolicy: "approval-gated",
      placementRevision: `sha256:${"a".repeat(64)}`,
    };
    const remote = decodeProjectTerminalResult({
      ...preview,
      action: { ...("action" in preview ? preview.action : {}), server },
    });
    const execute = vi.fn(async (command: { kind: string; terminalId?: string }) =>
      command.kind === "preview-action"
        ? remote
        : decodeProjectTerminalResult({
            kind: "project-terminal",
            terminal: {
              projectId,
              terminalId: command.terminalId,
              state: "interrupted",
              posture: "full-access",
              uncertainty: "server-transport-lost",
              action: "action" in remote ? remote.action : undefined,
            },
          }),
    );
    const user = userEvent.setup();
    render(
      <ProjectActionRunDialog
        client={{ execute }}
        target={target}
        storageKey="remote-action"
        open
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("deploy@web-1")).toBeVisible();
    expect(screen.getByText(/No OS confinement on the server/)).toBeVisible();
    expect(screen.getByText(/Task policy approval-gated/)).toBeVisible();
    expect(execute.mock.calls.filter(([c]) => c.kind === "start-action")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Run action" }));
    expect(await screen.findByText(/Server connection lost/)).toBeVisible();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "start-action",
        placementRevision: server.placementRevision,
        projectVersion: 1,
      }),
    );
    expect(execute.mock.calls.filter(([c]) => c.kind === "start-action")).toHaveLength(1);
  });
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
