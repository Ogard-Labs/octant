import { resolveSnoozePresets } from "@octant/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { threadRestRowActions } from "../app/threadRestRowActions";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import { buildOctantCommands, type OctantCommandSources } from "./buildOctantCommands";
import type { OctantCommand } from "./commandModel";

const CODE_ID = "00000000-0000-4000-8000-0000000000c1";
const WORK_ID = "00000000-0000-4000-8000-0000000000d1";
const CHAT_ID = "00000000-0000-4000-8000-0000000000e1";
const IDS = { code: CODE_ID, work: WORK_ID, chat: CHAT_ID } as const;
const SNOOZE = { until: "2099-01-01T00:00:00.000Z", at: "2026-11-24T12:00:00.000Z" };

type Mode = keyof typeof IDS;

function shellActions() {
  return {
    completeChatThread: vi.fn(async () => ({ status: "ok" as const })),
    reopenChatThread: vi.fn(async () => ({ status: "ok" as const })),
    snoozeChatThread: vi.fn(async () => ({ status: "ok" as const })),
    wakeChatThread: vi.fn(async () => ({ status: "ok" as const })),
    completeCodeThread: vi.fn(async () => ({ status: "ok" as const })),
    reopenCodeThread: vi.fn(async () => ({ status: "ok" as const })),
    snoozeCodeThread: vi.fn(async () => ({ status: "ok" as const })),
    wakeCodeThread: vi.fn(async () => ({ status: "ok" as const })),
    pinCodeThread: vi.fn(async () => true),
    markCodeThreadDone: vi.fn(async () => ({ status: "ok" as const })),
    tryWorkRestCommand: vi.fn(async () => ({ status: "ok" as const })),
    setThreadExportNotice: vi.fn(),
    offerThreadRestUndo: vi.fn(),
    threadRestRow: vi.fn(() => undefined),
  };
}

function sources(overrides: Partial<OctantCommandSources> = {}): OctantCommandSources {
  return {
    activeMode: "code",
    modes: ["chat", "work", "code"],
    onSelectMode: vi.fn(),
    onNewThread: vi.fn(),
    onOpenSearch: vi.fn(),
    onOpenSettings: vi.fn(),
    threads: [],
    onOpenThread: vi.fn(),
    projects: [],
    onOpenProject: vi.fn(),
    skills: [],
    pluginServers: [],
    appleProjects: [],
    onOpenAppleProject: vi.fn(),
    ...overrides,
  };
}

function frontCommands(
  mode: Mode,
  state: Partial<ChatThreadNavigationItem> = {},
  shell = shellActions(),
): ReadonlyArray<OctantCommand> {
  const thread = { threadId: IDS[mode], title: "Controller foundation", ...state };
  return buildOctantCommands(
    sources({
      activeMode: mode,
      frontThread: { thread, actions: threadRestRowActions(shell)[mode] },
    }),
  ).filter((command) => command.id.startsWith("thread:front:"));
}

const titles = (commands: ReadonlyArray<OctantCommand>) => commands.map((command) => command.title);

function run(commands: ReadonlyArray<OctantCommand>, title: string): void {
  const command = commands.find((candidate) => candidate.title === title);
  if (command?.action.kind !== "run") throw new Error(`expected a run command ${title}`);
  command.action.run();
}

describe("the commands for the thread in front", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-25T10:00:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const snoozeTitles = () =>
    resolveSnoozePresets(new Date()).map((preset) => `Snooze · ${preset.label}`);

  it.each([
    ["code", ["Pin", "Settle"]],
    ["work", ["Settle"]],
    ["chat", ["Settle"]],
  ] as const)("offers an open %s thread what its row menu offers", (mode, first) => {
    expect(titles(frontCommands(mode))).toEqual([...first, ...snoozeTitles()]);
  });

  it.each(["code", "work", "chat"] as const)(
    "offers a snoozed %s thread Wake in place of the snooze times",
    (mode) => {
      expect(titles(frontCommands(mode, { snooze: SNOOZE }))).toEqual([
        ...(mode === "code" ? ["Pin"] : []),
        "Settle",
        "Wake",
      ]);
    },
  );

  it.each(["code", "work", "chat"] as const)(
    "offers a settled %s thread Un-settle in place of Settle",
    (mode) => {
      const offered = titles(frontCommands(mode, { completedAt: "2026-11-24T09:00:00.000Z" }));
      expect(offered).toContain("Un-settle");
      expect(offered).not.toContain("Settle");
    },
  );

  it("offers Reopen for a thread marked done that never settled", () => {
    const offered = titles(frontCommands("code", { markedDone: true }));
    expect(offered).toContain("Reopen");
    expect(offered).not.toContain("Settle");
  });

  it("offers Unpin for a pinned Code thread", () => {
    const offered = titles(frontCommands("code", { pinned: true }));
    expect(offered).toContain("Unpin");
    expect(offered).not.toContain("Pin");
  });

  it("offers nothing when no thread is in front", () => {
    expect(
      buildOctantCommands(sources()).some((command) => command.id.startsWith("thread:front:")),
    ).toBe(false);
  });

  it("lists them ahead of the other threads, so an empty search still reaches them", () => {
    const commands = buildOctantCommands(
      sources({
        threads: [{ threadId: "other", title: "Other", mode: "code" }],
        frontThread: {
          thread: { threadId: CODE_ID, title: "Controller foundation" },
          actions: threadRestRowActions(shellActions()).code,
        },
      }),
    );
    const ids = commands.map((command) => command.id);
    expect(ids.indexOf("thread:front:pin")).toBeLessThan(ids.indexOf("thread:code:other"));
  });

  it("runs the row menu's own Code actions with the thread's id", async () => {
    const shell = shellActions();
    const open = frontCommands("code", {}, shell);
    run(open, "Settle");
    run(open, "Pin");
    run(open, "Snooze · In 1 hour");
    run(frontCommands("code", { pinned: true }, shell), "Unpin");
    run(frontCommands("code", { snooze: SNOOZE }, shell), "Wake");
    run(frontCommands("code", { completedAt: SNOOZE.at }, shell), "Un-settle");

    expect(shell.completeCodeThread).toHaveBeenCalledWith(CODE_ID);
    expect(shell.pinCodeThread.mock.calls).toEqual([
      [CODE_ID, true],
      [CODE_ID, false],
    ]);
    expect(shell.snoozeCodeThread).toHaveBeenCalledWith(
      CODE_ID,
      new Date(Date.now() + 3_600_000).toISOString(),
    );
    expect(shell.wakeCodeThread).toHaveBeenCalledWith(CODE_ID);
    expect(shell.reopenCodeThread).toHaveBeenCalledWith(CODE_ID);
  });

  it("counts a snooze time from when it is run, not from when the list was built", () => {
    const shell = shellActions();
    const commands = frontCommands("chat", {}, shell);
    vi.setSystemTime(new Date("2026-11-25T10:40:00"));
    run(commands, "Snooze · In 1 hour");
    expect(shell.snoozeChatThread).toHaveBeenCalledWith(
      CHAT_ID,
      new Date(Date.now() + 3_600_000).toISOString(),
    );
  });

  it("reports a refused rest command the way a sidebar row does", async () => {
    const shell = shellActions();
    shell.completeChatThread.mockResolvedValue({
      status: "refused",
      message: "This thread is waiting on you.",
    } as never);
    run(frontCommands("chat", {}, shell), "Settle");
    await vi.waitFor(() =>
      expect(shell.setThreadExportNotice).toHaveBeenCalledWith("This thread is waiting on you."),
    );
  });

  it("sends a Work thread's rest through the Work command with the row's version", () => {
    const shell = shellActions();
    run(frontCommands("work", {}, shell), "Settle");
    run(frontCommands("work", { snooze: SNOOZE }, shell), "Wake");
    const built = (shell.tryWorkRestCommand.mock.calls as unknown[][]).map((call) => {
      const [threadId, command] = call as [string, (version: number) => unknown];
      return [threadId, command(4)];
    });
    expect(built).toEqual([
      [WORK_ID, { kind: "complete-work-thread", threadId: WORK_ID, expectedVersion: 4 }],
      [WORK_ID, { kind: "wake-work-thread", threadId: WORK_ID, expectedVersion: 4 }],
    ]);
  });
});
