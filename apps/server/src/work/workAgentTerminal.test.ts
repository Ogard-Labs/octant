import { describe, expect, it, vi } from "vitest";
import { createWorkTerminalTools } from "./workAgentTerminal";

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

function tools(
  overrides: {
    readonly posture?: "plan" | "approval-gated" | "auto-accept-edits" | "full-access";
    readonly ask?: (summary: string) => Promise<"approved" | "denied">;
    readonly service?: ReturnType<typeof terminals>;
  } = {},
) {
  const service = overrides.service ?? terminals();
  let posture = overrides.posture ?? "approval-gated";
  const set = createWorkTerminalTools({
    threadId: WORK_THREAD,
    projectId: "77777777-7777-4777-8777-777777777777",
    terminals: service as never,
    folder: async () => "/work/folder",
    posture: () => posture,
    current: () => true,
    ...(overrides.ask === undefined ? {} : { ask: overrides.ask }),
    protections: async () => ({ launch: {}, end: async () => undefined }),
    platform: "darwin",
    strict: () => true,
    shell: () => "/bin/zsh",
    recordExternalContentIngestion: () => ({ kind: "ignored", reason: "not-tainting" }) as never,
    uuid: () => crypto.randomUUID(),
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
});
