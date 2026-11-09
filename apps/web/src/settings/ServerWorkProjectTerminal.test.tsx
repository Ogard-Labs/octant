import {
  decodeProjectId,
  type ProjectTerminalCommand,
  type ProjectTerminalResult,
} from "@octant/contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ServerWorkProjectTerminal } from "./ServerWorkProjectTerminal";

vi.mock("../zen/ZenProjectTerminalCard", () => ({
  ZenProjectTerminalCard: () => <section aria-label="Project terminal">SSH output</section>,
}));

const projectId = decodeProjectId("11111111-1111-4111-8111-111111111111");
function answer(command: ProjectTerminalCommand): ProjectTerminalResult {
  if (!("terminalId" in command)) throw Error("Expected an owned terminal command");
  return {
    kind: "project-terminal",
    terminal: {
      projectId,
      terminalId: command.terminalId,
      posture: "full-access",
      state: command.kind === "stop" ? "interrupted" : "running",
    },
  };
}

describe("the person's server Work terminal panel", () => {
  it("shows the real login and full remote access before opening and closes only its own SSH session", async () => {
    const execute = vi.fn(async (command: ProjectTerminalCommand) => answer(command));
    const user = userEvent.setup();
    const rendered = render(
      <ServerWorkProjectTerminal
        client={{ execute }}
        projectId={projectId}
        login="deploy@work-host"
        folder="/srv/notes"
      />,
    );
    expect(screen.getByText(/Your SSH shell has Full access/)).toHaveTextContent(
      "Full access on this server",
    );
    expect(execute).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Open terminal" }));
    await screen.findByRole("region", { name: "Project terminal" });
    const command = execute.mock.calls[0]?.[0];
    if (command?.kind !== "start") throw Error("Expected explicit start");
    expect(command).toEqual({
      kind: "start",
      projectId,
      terminalId: expect.any(String),
      columns: 100,
      rows: 24,
    });
    await user.click(screen.getByRole("button", { name: "Close terminal" }));
    expect(execute).toHaveBeenCalledWith({
      kind: "stop",
      projectId,
      terminalId: command.terminalId,
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Programs may still be running on the server",
    );
    rendered.unmount();
    expect(execute.mock.calls.filter(([sent]) => sent.kind === "start")).toHaveLength(1);
  });

  it("cancels a pending acquisition on unmount and stops a late SSH receipt without reopening it", async () => {
    let resolveStart: ((value: ProjectTerminalResult) => void) | undefined;
    const pending = new Promise<ProjectTerminalResult>((resolve) => {
      resolveStart = resolve;
    });
    const execute = vi.fn((command: ProjectTerminalCommand) =>
      command.kind === "start" ? pending : Promise.resolve(answer(command)),
    );
    const user = userEvent.setup();
    const rendered = render(
      <ServerWorkProjectTerminal
        client={{ execute }}
        projectId={projectId}
        login="deploy@work-host"
        folder="/srv/notes"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open terminal" }));
    const command = execute.mock.calls[0]?.[0];
    if (command?.kind !== "start") throw Error("Expected explicit start");
    rendered.unmount();
    expect(execute).toHaveBeenCalledWith({
      kind: "stop",
      projectId,
      terminalId: command.terminalId,
    });
    await act(async () => {
      resolveStart?.(answer(command));
      await pending;
    });
    expect(execute.mock.calls.filter(([sent]) => sent.kind === "stop")).toHaveLength(2);
    expect(
      execute.mock.calls.every(
        ([sent]) => "terminalId" in sent && sent.terminalId === command.terminalId,
      ),
    ).toBe(true);
  });

  it("shows an uncertain start and never replays the launch after a lost reply", async () => {
    const execute = vi.fn(async (command: ProjectTerminalCommand) => {
      if (command.kind === "start") throw Error("Reply lost");
      return answer(command);
    });
    const user = userEvent.setup();
    render(
      <ServerWorkProjectTerminal
        client={{ execute }}
        projectId={projectId}
        login="deploy@work-host"
        folder="/srv/notes"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open terminal" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Nothing was retried"));
    expect(screen.queryByText("Opening SSH session…")).toBeNull();
    expect(execute.mock.calls.filter(([sent]) => sent.kind === "start")).toHaveLength(1);
    expect(execute.mock.calls.filter(([sent]) => sent.kind === "stop")).toHaveLength(1);
  });
});
