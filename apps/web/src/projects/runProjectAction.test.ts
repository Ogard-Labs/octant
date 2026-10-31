import type {
  CodeTerminalId,
  ProjectAction,
  ProjectId,
  ProjectTerminalCommand,
  ProjectTerminalResult,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { runProjectAction } from "./runProjectAction";

const projectId = "p1" as unknown as ProjectId;
const first = "t1" as unknown as CodeTerminalId;
const second = "t2" as unknown as CodeTerminalId;
const action = { id: "a1", name: "Dev", command: "bun run dev", directory: "." } as ProjectAction;
const ran = { kind: "project-terminal", terminal: { state: "running" } } as ProjectTerminalResult;
const refused = {
  kind: "project-terminal-refused",
  reason: "unavailable",
  message: "This terminal is not running on this host.",
} as ProjectTerminalResult;

function setup(replies: ReadonlyArray<ProjectTerminalResult | Error>) {
  const sent: ProjectTerminalCommand[] = [];
  const notices: string[] = [];
  const openTerminal = vi.fn(async () => second);
  let index = 0;
  const dependencies = {
    execute: async (command: ProjectTerminalCommand) => {
      sent.push(command);
      const reply = replies[index++];
      if (reply === undefined || reply instanceof Error) throw reply ?? new Error("none");
      return reply;
    },
    pinnedTerminals: [first],
    openTerminal,
    notify: (message: string) => notices.push(message),
  };
  return { dependencies, sent, notices, openTerminal };
}

describe("running a Project action", () => {
  it("reports an unknown outcome and types the action once when the reply is lost", async () => {
    const { dependencies, sent, notices, openTerminal } = setup([new Error("connection lost")]);

    await runProjectAction(dependencies, projectId, action);

    expect(sent).toHaveLength(1);
    expect(openTerminal).not.toHaveBeenCalled();
    expect(notices).toEqual([expect.stringContaining("may or may not have run")]);
  });

  it("opens a new terminal when the pinned one confirms it is gone", async () => {
    const { dependencies, sent, notices, openTerminal } = setup([refused, ran]);

    await runProjectAction(dependencies, projectId, action);

    expect(openTerminal).toHaveBeenCalledTimes(1);
    expect(sent.map((command) => "terminalId" in command && command.terminalId)).toEqual([
      first,
      second,
    ]);
    expect(notices).toEqual([]);
  });
});
