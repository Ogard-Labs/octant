import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkTerminalTools,
  watchWorkTerminalsLeftBehind,
  type WorkTerminalStart,
} from "./workAgentTerminal";

const WORK_THREAD = "33333333-3333-4333-8333-333333333333";
const call = (body: unknown) => ({ name: "octant_terminal", inputJson: JSON.stringify(body) });

function terminals() {
  let running = false;
  let marker = "";
  const snapshot = () => ({
    terminalId: "t",
    status: running ? ("running" as const) : ("interrupted" as const),
    canRerun: true,
    transcript: {
      chunks: [marker === "" ? "" : `ok\u001b]777;octant=${marker};exit=0\u0007`],
      byteLength: 2,
      truncated: false,
      characters: 2,
    },
  });
  return {
    launch: vi.fn(async (_request: Record<string, unknown>) => {
      running = true;
      return snapshot();
    }),
    attach: vi.fn(() => {
      if (!running) throw new Error("No terminal.");
      return snapshot();
    }),
    write: vi.fn((_id: string, data: string) => {
      marker = /octant=(oo\w+)/.exec(data)?.[1] ?? "";
    }),
    terminate: vi.fn(async () => {
      running = false;
      return snapshot();
    }),
  };
}

const folder = { current: "/work/folder" };
const started: { current: WorkTerminalStart | undefined } = { current: undefined };
const shell = { current: "/bin/zsh" };

function tools(
  overrides: {
    readonly posture?: "plan" | "approval-gated" | "auto-accept-edits" | "full-access";
    readonly ask?: (summary: string, command: string) => Promise<"approved" | "denied">;
    readonly service?: ReturnType<typeof terminals>;
    readonly end?: () => Promise<void>;
  } = {},
) {
  const service = overrides.service ?? terminals();
  let posture = overrides.posture ?? "approval-gated";
  const set = createWorkTerminalTools({
    threadId: WORK_THREAD,
    projectId: "77777777-7777-4777-8777-777777777777",
    terminals: service as never,
    posture: () => posture,
    current: () => true,
    ...(overrides.ask === undefined ? {} : { ask: overrides.ask }),
    protections: async () => ({ launch: {}, end: overrides.end ?? (async () => undefined) }),
    platform: "darwin",
    strict: () => true,
    shell: () => shell.current,
    recordExternalContentIngestion: () => ({ kind: "ignored", reason: "not-tainting" }) as never,
    uuid: () => crypto.randomUUID(),
    folder: async () => folder.current,
    startedIn: {
      get: () => started.current,
      set: (value: WorkTerminalStart | undefined) => {
        started.current = value;
      },
    },
  });
  return {
    set,
    service,
    setPosture: (next: typeof posture) => {
      posture = next;
    },
  };
}

describe("a Work thread's terminal", () => {
  beforeEach(() => {
    folder.current = "/work/folder";
    started.current = undefined;
    shell.current = "/bin/zsh";
  });

  it("asks before each command below Full access, and runs it in the thread's folder at its level", async () => {
    const ask = vi.fn(async (_summary: string) => "approved" as const);
    const { set, service } = tools({ ask });
    const run = call({ operation: "run", command: "npm run dev" });
    expect((await set.execute(run)).isError).toBe(false);
    expect(ask.mock.calls[0]?.[0]).toContain("npm run dev");
    expect(service.launch.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/work/folder",
      executionPolicy: "approval-gated",
      credentialReferences: [],
    });
    await set.execute(run);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("starts nothing the person declined, or where nobody can be asked", async () => {
    const declined = tools({ ask: async () => "denied" });
    expect(
      await declined.set.execute(call({ operation: "run", command: "rm -rf build" })),
    ).toMatchObject({ isError: true, result: { error: "terminal-approval-denied" } });
    expect(declined.service.launch).not.toHaveBeenCalled();
    const nobody = tools();
    expect(await nobody.set.execute(call({ operation: "run", command: "ls" }))).toMatchObject({
      isError: true,
      result: { error: "terminal-approval-required" },
    });
    expect(nobody.service.launch).not.toHaveBeenCalled();
  });

  it("is refused in Plan, and runs at Full access without asking", async () => {
    const ask = vi.fn(async () => "approved" as const);
    const planned = tools({ posture: "plan", ask });
    expect(await planned.set.execute(call({ operation: "run", command: "ls" }))).toMatchObject({
      isError: true,
      result: { error: "plan-mode-read-only" },
    });
    const full = tools({ posture: "full-access", ask });
    expect((await full.set.execute(call({ operation: "run", command: "ls" }))).isError).toBe(false);
    expect(ask).not.toHaveBeenCalled();
    expect(planned.service.launch).not.toHaveBeenCalled();
  });

  it("is one shell for the thread across its turns", async () => {
    const service = terminals();
    const first = tools({ posture: "full-access", service });
    await first.set.execute(call({ operation: "run", command: "npm run dev" }));
    const next = tools({ posture: "full-access", service });
    expect((await next.set.execute(call({ operation: "read" }))).result).toMatchObject({
      status: "running",
    });
    expect(service.launch).toHaveBeenCalledTimes(1);
    await next.set.execute(call({ operation: "stop" }));
    expect(service.terminate).toHaveBeenCalledTimes(1);
  });

  it("ends a shell started in a folder the thread no longer works in", async () => {
    const service = terminals();
    const first = tools({ posture: "full-access", service });
    await first.set.execute(call({ operation: "run", command: "npm run dev" }));
    folder.current = "/work/folder/docs";
    const next = tools({ posture: "full-access", service });
    expect(await next.set.execute(call({ operation: "write", command: "rm x" }))).toMatchObject({
      isError: true,
      result: { error: "terminal-folder-changed" },
    });
    expect(service.terminate).toHaveBeenCalledTimes(1);
    expect(service.write).not.toHaveBeenCalledWith(expect.anything(), "rm x");
    await next.set.execute(call({ operation: "run", command: "ls" }));
    expect(service.launch.mock.calls[1]?.[0]).toMatchObject({ cwd: "/work/folder/docs" });
  });

  it("starts nothing when the thread is archived while its sandbox is prepared", async () => {
    const service = terminals();
    let active = true;
    const set = createWorkTerminalTools({
      threadId: WORK_THREAD,
      projectId: "77777777-7777-4777-8777-777777777777",
      terminals: service as never,
      folder: async () => "/work/folder",
      posture: () => "full-access",
      current: () => active,
      protections: async () => {
        active = false;
        return { launch: {}, end: async () => undefined };
      },
      platform: "darwin",
      strict: () => true,
      shell: () => "/bin/zsh",
      recordExternalContentIngestion: () => ({ kind: "ignored", reason: "not-tainting" }) as never,
      uuid: () => crypto.randomUUID(),
      startedIn: { get: () => undefined, set: () => undefined },
    });
    await set.execute(call({ operation: "run", command: "ls" }));
    const admit = service.launch.mock.calls[0]?.[0]["admit"];
    expect(typeof admit === "function" && admit()).toBe(false);
  });

  it("releases the sandbox it prepared when the shell cannot start, so a later start is not refused", async () => {
    const service = terminals();
    service.launch.mockRejectedValueOnce(new Error("The shell could not be spawned."));
    const end = vi.fn(async () => undefined);
    const { set } = tools({ posture: "full-access", service, end });
    expect(await set.execute(call({ operation: "run", command: "ls" }))).toMatchObject({
      isError: true,
      result: { error: "terminal-unavailable" },
    });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("ends a shell as soon as its thread is archived or moves to another folder, and keeps one still in place", async () => {
    const started = new Map<string, WorkTerminalStart>([
      ["archived", { folder: "/work/a", shell: "/bin/zsh" }],
      ["moved", { folder: "/work/b", shell: "/bin/zsh" }],
      ["kept", { folder: "/work/c", shell: "/bin/zsh" }],
    ]);
    // The projection the sweep reads, still as it was when the journal tells its listeners.
    const now = new Map<string, string | undefined>([
      ["archived", "/work/a"],
      ["moved", "/work/b"],
      ["kept", "/work/c"],
    ]);
    const listeners: Array<(append: { readonly events: ReadonlyArray<never> }) => void> = [];
    const terminate = vi.fn(async (_threadId: string) => undefined);
    watchWorkTerminalsLeftBehind({
      subscribeCommitted: (listener) => {
        listeners.push(listener as never);
        return () => undefined;
      },
      alsoOn: [],
      started,
      folderNow: async (threadId) => now.get(threadId),
      terminate,
      onError: (error) => {
        throw error;
      },
    });
    // A service appends, the journal tells its listeners, and only then does
    // the service apply the change to its projection.
    for (const listener of listeners)
      listener({
        events: [{ aggregateType: "work-thread", eventName: "work.thread-updated@1" } as never],
      });
    now.set("archived", undefined);
    now.set("moved", "/work/b/docs");
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledTimes(2));
    expect(terminate.mock.calls.map(([threadId]) => threadId).sort()).toEqual([
      "archived",
      "moved",
    ]);
    expect([...started.keys()]).toEqual(["kept"]);
  });

  it("types the completion line for the shell the terminal started in, not the one Settings names now", async () => {
    const service = terminals();
    await tools({ posture: "full-access", service }).set.execute(
      call({ operation: "run", command: "npm run dev" }),
    );
    shell.current = "C:\\Windows\\System32\\cmd.exe";
    await tools({ posture: "full-access", service }).set.execute(
      call({ operation: "run", command: "ls" }),
    );
    const typed = service.write.mock.calls.map(([, data]) => data).at(-1);
    expect(typed).toContain("printf");
    expect(typed).not.toContain("%ERRORLEVEL%");
  });

  it("hands the approval the whole command apart from its question", async () => {
    const ask = vi.fn(async (_summary: string, _command: string) => "approved" as const);
    const command = "x".repeat(8_192);
    await tools({ ask }).set.execute(call({ operation: "run", command }));
    expect(ask.mock.calls[0]?.[1]).toBe(command);
  });
});
