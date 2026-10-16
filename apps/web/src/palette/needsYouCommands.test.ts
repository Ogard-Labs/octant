import { describe, expect, it, vi } from "vitest";
import { filterOctantCommands, groupOctantCommands, type OctantCommand } from "./commandModel";
import { buildNeedsYouCommands, type NeedsYouSources } from "./needsYouCommands";
import {
  chatQuestion,
  codeApproval,
  codeChildQuestion,
  codeDecision,
  codeQuestion,
  pendingIds,
  workApproval,
  workChildApproval,
  workLeadApproval,
} from "./pendingRequests.test-fixtures";

const NOW = Date.parse("2026-10-06T08:04:30.000Z");

function sources(overrides: Partial<NeedsYouSources> = {}): NeedsYouSources {
  return {
    requests: [],
    nowMs: NOW,
    onOpenThread: vi.fn(),
    onAnswerApproval: vi.fn(),
    onAnswerDecision: vi.fn(),
    onOpenSubagentRequest: vi.fn(),
    ...overrides,
  };
}

function run(command: OctantCommand | undefined): void {
  if (command?.action.kind !== "run") throw new Error("expected a run command");
  command.action.run();
}

describe("the Needs you commands", () => {
  it("lists one row per waiting thread with its mode, what it waits on, and how long", () => {
    const commands = buildNeedsYouCommands(
      sources({ requests: [workApproval(), codeApproval(), codeQuestion(), chatQuestion()] }),
    );

    expect(
      commands
        .filter((command) => command.id.startsWith("needs-you:thread:"))
        .map((command) => [command.title, command.detail]),
    ).toEqual([
      ["Quarterly report", "Work · waiting on approval · 4m"],
      ["Fix the parser", "Code · waiting on approval and your answer · 3m"],
      ["Trip plan", "Chat · waiting on your answer · 1m"],
    ]);
    expect(commands.every((command) => command.group === "Needs you")).toBe(true);
  });

  it("opens the waiting thread with its own Project", () => {
    const onOpenThread = vi.fn();
    const commands = buildNeedsYouCommands(sources({ requests: [codeApproval()], onOpenThread }));

    run(commands.find((command) => command.id.startsWith("needs-you:thread:")));

    expect(onOpenThread).toHaveBeenCalledWith({
      threadId: pendingIds.codeThread,
      title: "Fix the parser",
      mode: "code",
      projectId: pendingIds.project,
    });
  });

  it("opens a Chat thread filed under no Project without inventing one", () => {
    const onOpenThread = vi.fn();
    const commands = buildNeedsYouCommands(sources({ requests: [chatQuestion()], onOpenThread }));

    run(commands[0]);

    expect(onOpenThread).toHaveBeenCalledWith({
      threadId: pendingIds.chatThread,
      title: "Trip plan",
      mode: "chat",
    });
  });

  it("offers Approve and Deny for an approval and hands the command its handle", () => {
    const onAnswerApproval = vi.fn();
    const work = workApproval();
    const code = codeApproval();
    const commands = buildNeedsYouCommands(sources({ requests: [work, code], onAnswerApproval }));

    run(commands.find((command) => command.title === "Approve: Quarterly report"));
    run(commands.find((command) => command.title === "Deny: Fix the parser"));

    expect(onAnswerApproval).toHaveBeenNthCalledWith(1, work, "approved");
    expect(onAnswerApproval).toHaveBeenNthCalledWith(2, code, "denied");
    expect(commands.find((command) => command.title === "Approve: Fix the parser")?.detail).toBe(
      "Code · Allow `bun test`?",
    );
  });

  it("lists a question's row but never its choices as commands", () => {
    const commands = buildNeedsYouCommands(sources({ requests: [codeQuestion()] }));

    expect(commands.map((command) => command.title)).toEqual(["Fix the parser"]);
  });

  it("lists a decision's row and each option as a command that sends its words", () => {
    const onAnswerDecision = vi.fn();
    const decision = codeDecision();
    const commands = buildNeedsYouCommands(sources({ requests: [decision], onAnswerDecision }));

    expect(commands.map((command) => [command.title, command.detail])).toEqual([
      ["Fix the parser", "Code · waiting on your decision · <1m"],
      [
        "Wait for review: Fix the parser",
        "Code · The fix is ready. Should I open the pull request now?",
      ],
      [
        "Open it: Fix the parser",
        "Recommended · Code · The fix is ready. Should I open the pull request now?",
      ],
    ]);
    expect(filterOctantCommands(commands, "open it").map((command) => command.title)[0]).toBe(
      "Open it: Fix the parser",
    );
    run(commands.find((command) => command.title === "Open it: Fix the parser"));
    expect(onAnswerDecision).toHaveBeenCalledExactlyOnceWith(decision, "Open it");
  });

  it("lists a waiting subagent as one Review request that opens it, with no Approve or Deny", () => {
    const onOpenSubagentRequest = vi.fn();
    const onOpenThread = vi.fn();
    const onAnswerApproval = vi.fn();
    const child = workChildApproval();
    const commands = buildNeedsYouCommands(
      sources({ requests: [child], onOpenSubagentRequest, onOpenThread, onAnswerApproval }),
    );

    expect(commands.map((command) => [command.title, command.detail])).toEqual([
      ["Quarterly report", "Work · waiting on a subagent · <1m"],
      [
        "Review request: Quarterly report",
        "Work · Research subagent needs your approval · shell: bun run collect",
      ],
    ]);
    expect(commands.some((command) => /Approve|Deny/.test(command.title))).toBe(false);

    for (const command of commands) run(command);
    expect(onOpenSubagentRequest).toHaveBeenCalledTimes(2);
    expect(onOpenSubagentRequest).toHaveBeenCalledWith(child);
    expect(onOpenThread).not.toHaveBeenCalled();
    expect(onAnswerApproval).not.toHaveBeenCalled();
  });

  it("lists the agent's own approval as one row that opens the thread, with no Approve or Deny", () => {
    const onOpenThread = vi.fn();
    const onAnswerApproval = vi.fn();
    const commands = buildNeedsYouCommands(
      sources({ requests: [workLeadApproval()], onOpenThread, onAnswerApproval }),
    );

    expect(commands.map((command) => [command.title, command.detail])).toEqual([
      ["Quarterly report", "Work · waiting on approval · <1m"],
    ]);
    run(commands[0]);
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith({
      threadId: pendingIds.workThread,
      title: "Quarterly report",
      mode: "work",
      projectId: pendingIds.project,
    });
    expect(onAnswerApproval).not.toHaveBeenCalled();
  });

  it("opens the thread itself when a subagent is not the only thing it waits on", () => {
    const onOpenSubagentRequest = vi.fn();
    const onOpenThread = vi.fn();
    const commands = buildNeedsYouCommands(
      sources({
        requests: [codeApproval(), codeChildQuestion()],
        onOpenSubagentRequest,
        onOpenThread,
      }),
    );

    const row = commands.find((command) => command.id.startsWith("needs-you:thread:"));
    expect(row?.detail).toBe("Code · waiting on approval and a subagent · 3m");
    run(row);
    expect(onOpenThread).toHaveBeenCalledOnce();
    expect(onOpenSubagentRequest).not.toHaveBeenCalled();
  });

  it("offers nothing when nothing is waiting", () => {
    expect(buildNeedsYouCommands(sources())).toEqual([]);
  });

  it("shows Needs you first for an empty query and still ranks across groups for a search", () => {
    const others: ReadonlyArray<OctantCommand> = [
      {
        id: "mode:chat",
        title: "Switch to Chat",
        group: "Modes",
        action: { kind: "run", run: vi.fn() },
      },
      {
        id: "thread:code:1",
        title: "Open Fix the parser",
        group: "Threads",
        action: { kind: "run", run: vi.fn() },
      },
    ];
    const all = [...buildNeedsYouCommands(sources({ requests: [codeApproval()] })), ...others];

    expect(groupOctantCommands(filterOctantCommands(all, "")).map((group) => group.group)).toEqual([
      "Needs you",
      "Modes",
      "Threads",
    ]);
    expect(filterOctantCommands(all, "approve").map((command) => command.title)).toEqual([
      "Approve: Fix the parser",
    ]);
    expect(
      groupOctantCommands(filterOctantCommands(all, "fix")).map((group) => group.group),
    ).toEqual(["Needs you", "Threads"]);
  });
});
