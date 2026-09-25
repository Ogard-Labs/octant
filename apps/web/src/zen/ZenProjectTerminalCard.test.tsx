import type {
  ProjectTerminalCommand,
  ProjectTerminalResult,
} from "@octant/contracts/project-terminals";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { XtermAdapterRuntime } from "../code/XtermTerminalAdapter";
import { ZenProjectTerminalCard } from "./ZenProjectTerminalCard";

const projectId = "00000000-0000-4000-8000-000000000091" as never;
const terminalId = "00000000-0000-4000-8000-000000000092" as never;

function running(text?: string): ProjectTerminalResult {
  return {
    kind: "project-terminal",
    terminal: { projectId, terminalId, state: "running", posture: "approval-gated" },
    ...(text === undefined ? {} : { output: { text, replace: false, characters: text.length } }),
  };
}

function client(answer: (command: ProjectTerminalCommand) => ProjectTerminalResult) {
  return { execute: vi.fn(async (command: ProjectTerminalCommand) => answer(command)) };
}

function xtermRuntime() {
  let options: Parameters<XtermAdapterRuntime["mount"]>[1] | undefined;
  const setOutput = vi.fn();
  const loadRuntime = vi.fn(
    async (): Promise<XtermAdapterRuntime> => ({
      mount: (_element, value) => {
        options = value;
        return {
          dispose: vi.fn(),
          focus: vi.fn(),
          readSelection: () => "",
          setInteractive: vi.fn(),
          setOutput,
        };
      },
    }),
  );
  return {
    loadRuntime,
    setOutput,
    get options() {
      return options;
    },
  };
}

describe("ZenProjectTerminalCard", () => {
  it("attaches to the Project's shell it was pinned to and sends what the person types", async () => {
    const shell = client((command) =>
      command.kind === "attach"
        ? running("% ")
        : running(command.kind === "write" ? undefined : ""),
    );
    const runtime = xtermRuntime();
    render(
      <ZenProjectTerminalCard
        client={shell}
        live
        loadRuntime={runtime.loadRuntime}
        projectId={projectId}
        terminalId={terminalId}
      />,
    );

    await waitFor(() => expect(runtime.options).toBeDefined());
    expect(shell.execute).toHaveBeenCalledWith(
      { kind: "attach", projectId, terminalId },
      expect.anything(),
    );
    // A pinned card is a window onto a shell, never a way to open one.
    expect(shell.execute).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "start" }),
      expect.anything(),
    );

    runtime.options?.onData("ls\r");
    await waitFor(() =>
      expect(shell.execute).toHaveBeenCalledWith(
        { kind: "write", projectId, terminalId, data: "ls\r" },
        undefined,
      ),
    );
  });

  it("says what the host said when the Project's shell was ended", async () => {
    const revoked = client(() => ({
      kind: "project-terminal-refused",
      reason: "authority-revoked",
      message: "This Project is archived, so its terminal ended.",
    }));
    render(
      <ZenProjectTerminalCard
        client={revoked}
        live
        loadRuntime={xtermRuntime().loadRuntime}
        projectId={projectId}
        terminalId={terminalId}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "This Project is archived, so its terminal ended.",
      ),
    );
  });

  it("stops reading the shell while the card is out of view", () => {
    const paused = client(() => running(""));
    render(
      <ZenProjectTerminalCard
        client={paused}
        live={false}
        loadRuntime={xtermRuntime().loadRuntime}
        projectId={projectId}
        terminalId={terminalId}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(/paused while this card is out of view/i);
    expect(paused.execute).not.toHaveBeenCalled();
  });
});
