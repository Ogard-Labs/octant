import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_PROVIDER_TOOL_RESULT_BYTES,
  decodeNativeHarnessContextRemaining,
  type ToolActionAuthority,
} from "@octant/contracts";
import { boundedToolResultJson } from "../providers/toolResultJson";
import { ToolCallAuthorityService, type ToolCallLiveFacts } from "../toolCallAuthorityService";
import { GoalService } from "../goal/goalService";
import { InMemoryGoalStore } from "../goal/goalService.test-support";
import { NativeHarnessFileSystem } from "./nativeHarnessFileSystem";
import { createNativeHarnessGoalPort } from "./nativeHarnessGoal";
import {
  createNativeHarnessTools,
  type NativeHarnessToolPorts,
  type NativeHarnessDelegatePort,
} from "./nativeHarnessTools";

const uuid = (() => {
  let counter = 0;
  return () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
})();

const authority = {
  hostId: "00000000-0000-4000-8000-0000000000aa",
  mode: "code",
  projectId: "00000000-0000-4000-8000-0000000000bb",
  rootId: "00000000-0000-4000-8000-0000000000cc",
  worktreeId: "00000000-0000-4000-8000-0000000000dd",
  providerInstanceId: "00000000-0000-4000-8000-0000000000ee",
  extension: { kind: "core" },
} as const;

function service(facts: Partial<ToolCallLiveFacts>, authorized = true): ToolCallAuthorityService {
  return new ToolCallAuthorityService({
    resolveGrantedAuthority: () =>
      authorized ? (authority as unknown as ToolActionAuthority) : undefined,
    resolveLiveFacts: () => ({
      providerAppManagedTools: "supported",
      host: { computerUseEnabled: false },
      executionPolicy: "full-access",
      approvalSatisfied: true,
      externalContentIngested: false,
      ...facts,
    }),
  });
}

async function fixture(
  facts: Partial<ToolCallLiveFacts> = {},
  ports: Partial<NativeHarnessToolPorts> = {},
  mode: "chat" | "work" | "code" = "code",
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "octant-harness-tools-")));
  await writeFile(join(root, "a.ts"), "hello\n");
  const filesystem = new NativeHarnessFileSystem({ root });
  const tools = createNativeHarnessTools({
    threadId: "thread-1",
    mode,
    authority: service(facts),
    resolveAuthority: () =>
      (mode === "chat"
        ? {
            hostId: authority.hostId,
            mode,
            providerInstanceId: authority.providerInstanceId,
            extension: authority.extension,
          }
        : mode === "work"
          ? { ...authority, mode: "work" }
          : { ...authority, mode: "code" }) as unknown as ToolActionAuthority,
    ports: { filesystem, ...ports },
    uuid,
  });
  return { root, tools };
}

const call = (tools: ReturnType<typeof createNativeHarnessTools>, name: string, input: unknown) =>
  tools.execute({ name, inputJson: JSON.stringify(input) });

describe("native harness tools", () => {
  it("offers no file or shell tool in Chat and every read in Code", async () => {
    const chat = await fixture({}, {}, "chat");
    expect(chat.tools.definitions.map((definition) => definition.name)).toEqual([]);
    const code = await fixture(
      {},
      {
        shell: { run: async () => ({ status: "ran", exitCode: 0, output: "", truncated: false }) },
      },
    );
    expect(code.tools.definitions.map((definition) => definition.name)).toEqual([
      "read",
      "grep",
      "glob",
      "bash",
      "edit",
      "write",
    ]);
  });

  it("forwards a versioned child follow-up and refuses hosts without that capability", async () => {
    const inputs: unknown[] = [];
    const delegate: NativeHarnessDelegatePort = {
      capabilities: async () => {
        throw new Error("unexpected capabilities read");
      },
      start: async () => {
        throw new Error("must not start a new child");
      },
      status: async () => [],
      collect: async () => ({ status: "refused", reason: "run-not-found" }),
      wait: async () => ({ finished: true, children: [] }),
    };
    const input = {
      operation: "follow-up",
      runId: "00000000-0000-4000-8000-000000000001",
      expectedVersion: 7,
      message: "Check the conclusion",
    };
    const unsupported = await fixture({}, { delegate });
    expect((await call(unsupported.tools, "delegate", input)).result).toMatchObject({
      error: "follow-up-unavailable",
    });
    const supported = await fixture(
      {},
      {
        delegate: {
          ...delegate,
          followUp: async (request) => {
            inputs.push(request);
            return {
              status: "accepted",
              runId: request.runId,
              version: 8,
              generation: 2,
              lifecycleStatus: "starting",
            };
          },
        },
      },
    );
    expect((await call(supported.tools, "delegate", input)).result).toMatchObject({
      status: "accepted",
      version: 8,
      generation: 2,
    });
    expect(inputs).toEqual([{ runId: input.runId, expectedVersion: 7, message: input.message }]);
  });

  it("bounds native batch status and wait without collecting omitted children", async () => {
    let collected = 0;
    const children = Array.from({ length: 24 }, (_, i) => ({
      runId: `child-${i}`,
      role: "research",
      task: "x".repeat(8192),
      lifecycleStatus: "completed",
      resultAvailable: true,
      version: 3,
      generation: 1,
    }));
    const delegate: NativeHarnessDelegatePort = {
      capabilities: async () => {
        throw new Error("unexpected capabilities read");
      },
      start: async () => {
        throw new Error("must not start a new child");
      },
      status: async () => children,
      collect: async () => {
        collected++;
        return { status: "refused", reason: "unexpected collection" };
      },
      wait: async () => ({ finished: true, children }),
    };
    const { tools } = await fixture({}, { delegate });
    for (const operation of ["status", "wait"]) {
      const outcome = await call(tools, "delegate", { operation });
      const encoded = boundedToolResultJson(outcome.result);
      expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_PROVIDER_TOOL_RESULT_BYTES);
      const wire = JSON.parse(encoded);
      expect(wire).toMatchObject({ bounds: { truncated: true } });
      expect(wire.children.length).toBeGreaterThan(0);
      expect(wire.children.length).toBeLessThan(24);
      expect(wire.bounds.omittedChildren).toBe(24 - wire.children.length);
      if (operation === "wait") expect(wire.finished).toBe(true);
    }
    expect(collected).toBe(0);
  });

  it("refuses a tool the model invented without consulting any port", async () => {
    const { tools } = await fixture();
    expect(await call(tools, "rm-rf", {})).toEqual({
      result: { error: "tool-unavailable" },
      isError: true,
    });
  });

  it("refuses malformed arguments before authority is consulted", async () => {
    const { tools } = await fixture({}, {}, "code");
    const outcome = await call(tools, "read", { path: 42 });
    expect(outcome.isError).toBe(true);
    expect((outcome.result as { error: string }).error).toBe("invalid-tool-input");
  });

  it("lets a read through under approval-gated but asks before a write", async () => {
    const { tools } = await fixture({
      executionPolicy: "approval-gated",
      approvalSatisfied: false,
    });
    const read = await call(tools, "read", { path: "a.ts" });
    expect(read.isError).toBe(false);
    const write = await call(tools, "write", { path: "b.ts", content: "x" });
    expect(write.isError).toBe(true);
    expect((write.result as { error: string }).error).toBe("approval-required");
  });

  it("refuses edits, writes, and the shell in Plan mode by policy", async () => {
    const { tools } = await fixture(
      { executionPolicy: "plan", approvalSatisfied: false },
      {
        shell: { run: async () => ({ status: "ran", exitCode: 0, output: "", truncated: false }) },
      },
    );
    for (const [name, input] of [
      ["write", { path: "b.ts", content: "x" }],
      ["edit", { path: "a.ts", oldText: "hello", newText: "bye" }],
      ["bash", { command: "echo hi" }],
    ] as const) {
      const outcome = await call(tools, name, input);
      expect(outcome.isError).toBe(true);
      expect((outcome.result as { error: string }).error).toBe("plan-mode-denied");
    }
    expect((await call(tools, "read", { path: "a.ts" })).isError).toBe(false);
  });

  it("asks for a fresh confirmation before a write on a tainted thread, even with full access", async () => {
    const { tools } = await fixture({ externalContentIngested: true });
    const write = await call(tools, "write", { path: "b.ts", content: "x" });
    expect((write.result as { error: string }).error).toBe("approval-required");
    expect((write.result as { message: string }).message).toContain("project-file-writes");
    expect((await call(tools, "read", { path: "a.ts" })).isError).toBe(false);
  });

  it("refuses everything when the thread no longer holds authority", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "octant-harness-tools-")));
    const tools = createNativeHarnessTools({
      threadId: "thread-1",
      mode: "code",
      authority: service({}, false),
      resolveAuthority: () => undefined,
      ports: { filesystem: new NativeHarnessFileSystem({ root }) },
      uuid,
    });
    expect(await call(tools, "read", { path: "." })).toEqual({
      result: { error: "tool-authority-stale" },
      isError: true,
    });
  });

  it("runs a command through the shell port and reports its exit code and bounded output", async () => {
    const seen: string[] = [];
    const { tools, root } = await fixture(
      {},
      {
        shell: {
          run: async (input) => {
            seen.push(input.cwd);
            return { status: "ran", exitCode: 3, output: "x".repeat(40_000), truncated: false };
          },
        },
      },
    );
    const outcome = await call(tools, "bash", { command: "false" });
    expect(seen).toEqual([root]);
    expect(outcome.isError).toBe(true);
    const result = outcome.result as {
      exitCode: number;
      bounds: { truncated: boolean; omittedBytes: number };
    };
    expect(result.exitCode).toBe(3);
    expect(result.bounds.truncated).toBe(true);
    expect(result.bounds.omittedBytes).toBe(40_000 - 32 * 1024);
  });

  it("returns the planner's context figure and refuses when none is known", async () => {
    const present = await fixture(
      {},
      {
        contextRemaining: () =>
          decodeNativeHarnessContextRemaining({
            safeInputBudgetTokens: 100,
            usedTokens: 40,
            remainingTokens: 60,
            confidence: "high",
            source: "capacity-planner",
            measuredAt: "2026-09-05T10:00:00.000Z",
          }),
      },
    );
    expect((await call(present.tools, "context-remaining", {})).isError).toBe(false);
    const absent = await fixture({}, { contextRemaining: () => undefined });
    expect((await call(absent.tools, "context-remaining", {})).result).toEqual({
      error: "context-unavailable",
    });
  });

  it("tells the observer about every call, with how it ended and how long it took", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "octant-harness-tools-")));
    await writeFile(join(root, "a.ts"), "hello\n");
    const seen: unknown[] = [];
    const tools = createNativeHarnessTools({
      threadId: "thread-1",
      mode: "code",
      authority: service({}),
      resolveAuthority: () => authority as unknown as ToolActionAuthority,
      ports: { filesystem: new NativeHarnessFileSystem({ root }) },
      uuid,
      observe: (call) => seen.push(call),
      clock: () => "2026-09-05T12:00:00.000Z",
    });
    await call(tools, "read", { path: "a.ts" });
    await call(tools, "bash", { command: "ls" });
    expect(seen).toMatchObject([
      { name: "read", summary: "read: a.ts", status: "ok", at: "2026-09-05T12:00:00.000Z" },
      { name: "bash", summary: "bash: ls", status: "refused" },
    ]);
  });

  it("asks the person before a gated call and runs it only when they allow it", async () => {
    const decisions: string[] = [];
    const answers = ["approved", "denied"] as const;
    let index = 0;
    const gated = await fixture(
      { executionPolicy: "approval-gated", approvalSatisfied: false },
      {
        approvals: async (input) => {
          decisions.push(`${input.toolName}:${input.approvalClass}`);
          return answers[index++] ?? "expired";
        },
      },
    );
    const allowed = await call(gated.tools, "write", { path: "b.ts", content: "x" });
    expect(allowed.isError).toBe(false);
    const denied = await call(gated.tools, "write", { path: "c.ts", content: "x" });
    expect(denied.result).toMatchObject({ error: "approval-denied" });
    expect(decisions).toEqual(["write:project-file-writes", "write:project-file-writes"]);
  });

  it("hands a queued note to the lead inside the next tool result", async () => {
    const notes = ["Skip the docs."];
    const steered = await fixture({}, { steering: () => notes.splice(0) });
    expect((await call(steered.tools, "read", { path: "a.ts" })).result).toMatchObject({
      note_from_person: ["Skip the docs."],
    });
    expect((await call(steered.tools, "read", { path: "a.ts" })).result).not.toHaveProperty(
      "note_from_person",
    );
  });

  it("keeps a queued note for the next tool result when a collected child reply fills the budget", async () => {
    const runId = "00000000-0000-4000-8000-000000000001";
    const reply = {
      status: "completed" as const,
      runId,
      version: 4,
      generation: 1,
      truncated: false,
    };
    const room = MAX_PROVIDER_TOOL_RESULT_BYTES - JSON.stringify({ ...reply, text: "" }).length;
    const delegate: NativeHarnessDelegatePort = {
      capabilities: async () => {
        throw new Error("unexpected capabilities read");
      },
      start: async () => {
        throw new Error("must not start a new child");
      },
      status: async () => [],
      collect: async () => ({ ...reply, text: "x".repeat(room - 8) }),
      wait: async () => ({ finished: true, children: [] }),
    };
    const notes = ["Skip the docs."];
    const steered = await fixture({}, { delegate, steering: () => notes.splice(0) });
    const collected = await call(steered.tools, "delegate", { operation: "collect", runId });
    expect(collected.result).not.toHaveProperty("note_from_person");
    expect(Buffer.byteLength(boundedToolResultJson(collected.result))).toBeLessThanOrEqual(
      MAX_PROVIDER_TOOL_RESULT_BYTES,
    );
    expect(JSON.parse(boundedToolResultJson(collected.result))).not.toHaveProperty("error");
    expect(notes).toEqual(["Skip the docs."]);
    expect((await call(steered.tools, "read", { path: "a.ts" })).result).toMatchObject({
      note_from_person: ["Skip the docs."],
    });
  });

  describe("goals", () => {
    const threadId = "00000000-0000-4000-8000-000000000301";
    async function goalFixture(input: {
      readonly criteria?: ReadonlyArray<{ readonly text: string; readonly check?: string }>;
      readonly exitCodes: Record<string, number>;
      readonly facts?: Partial<ToolCallLiveFacts>;
      readonly approvals?: NativeHarnessToolPorts["approvals"];
      /** Runs while the check command runs, as a concurrent change would. */
      readonly duringRun?: (goals: GoalService) => Promise<void>;
    }) {
      const goals = new GoalService({ store: new InMemoryGoalStore() });
      await goals.execute({
        kind: "create-thread-goal",
        threadId,
        expectedVersion: 0,
        goalId: "00000000-0000-4000-8000-000000000302",
        revisionId: "00000000-0000-4000-8000-000000000303",
        objective: "Make the parser accept trailing commas",
        budget: { turnBudget: 20 },
        ...(input.criteria === undefined ? {} : { criteria: input.criteria }),
      });
      const commands: string[] = [];
      const { tools } = await fixture(input.facts ?? {}, {
        goal: createNativeHarnessGoalPort({ goals, threadId, uuid }),
        shell: {
          run: async ({ command }) => {
            commands.push(command);
            await input.duringRun?.(goals);
            return {
              status: "ran",
              exitCode: input.exitCodes[command] ?? 1,
              output: "ok",
              truncated: false,
            };
          },
        },
        ...(input.approvals === undefined ? {} : { approvals: input.approvals }),
      });
      return { goals, tools, commands };
    }

    it("completes the goal when the last criterion's own check passes, and not before", async () => {
      const { goals, tools, commands } = await goalFixture({
        criteria: [
          { text: "Parser tests pass", check: "bun run test parser" },
          { text: "Lint is clean", check: "bun run lint" },
        ],
        exitCodes: { "bun run test parser": 0, "bun run lint": 0 },
      });
      const first = await call(tools, "goal-check", { criterionId: "c1" });
      expect(first.result).toMatchObject({
        outcome: "met",
        goal: { status: "active", allCriteriaMet: false },
      });
      const second = await call(tools, "goal-check", { criterionId: "c2" });
      expect(second.result).toMatchObject({ outcome: "met", goal: { status: "complete" } });
      expect(commands).toEqual(["bun run test parser", "bun run lint"]);
      expect(goals.read(threadId).goal?.evidence.map((entry) => entry.kind)).toEqual([
        "test",
        "test",
      ]);
    });

    it("records a failing check as unmet evidence and leaves the goal open", async () => {
      const { goals, tools } = await goalFixture({
        criteria: [{ text: "Parser tests pass", check: "bun run test parser" }],
        exitCodes: { "bun run test parser": 3 },
      });
      const checked = await call(tools, "goal-check", { criterionId: "c1" });
      expect(checked.result).toMatchObject({ outcome: "unmet", exitCode: 3 });
      const goal = goals.read(threadId).goal;
      expect(goal?.status).toBe("active");
      expect(goal?.criteria?.[0]?.evidence?.summary).toBe("bun run test parser exited 3");
    });

    it("refuses to self-check a criterion a person must confirm", async () => {
      const { tools, commands } = await goalFixture({
        criteria: [{ text: "The release notes read well" }],
        exitCodes: {},
      });
      expect((await call(tools, "goal-check", { criterionId: "c1" })).result).toMatchObject({
        error: "needs-person",
      });
      expect(commands).toEqual([]);
    });

    it("lets the lead write criteria once and refuses to replace them", async () => {
      const { tools } = await goalFixture({ exitCodes: {} });
      const written = await call(tools, "goal", {
        operation: "set-criteria",
        criteria: [{ text: "Parser tests pass", check: "bun run test parser" }],
      });
      expect(written.result).toMatchObject({
        criteria: [{ id: "c1", check: "bun run test parser", status: "unmet" }],
      });
      const replaced = await call(tools, "goal", {
        operation: "set-criteria",
        criteria: [{ text: "Anything", check: "true" }],
      });
      expect(replaced.result).toMatchObject({ error: "criteria-already-set" });
    });

    it("runs nothing when the check was changed while it waited for approval", async () => {
      let goals: GoalService | undefined;
      const {
        tools,
        commands,
        goals: created,
      } = await goalFixture({
        criteria: [{ text: "Parser tests pass", check: "bun run test parser" }],
        exitCodes: { "bun run test parser": 0, true: 0 },
        facts: { executionPolicy: "approval-gated", approvalSatisfied: false },
        approvals: async () => {
          // Someone swaps the criterion's command while the approval is open.
          const goal = goals?.read(threadId).goal;
          if (goal !== null && goal !== undefined) {
            await goals?.execute({
              kind: "revise-thread-goal",
              threadId,
              expectedVersion: goal.version,
              goalId: goal.id,
              revisionId: "00000000-0000-4000-8000-000000000399",
              objective: goal.objective,
              criteria: [{ text: "Parser tests pass", check: "true" }],
            });
          }
          return "approved";
        },
      });
      goals = created;
      expect((await call(tools, "goal-check", { criterionId: "c1" })).result).toMatchObject({
        error: "criterion-changed",
      });
      expect(commands).toEqual([]);
    });

    it("records nothing when the criterion was reworded while its check ran", async () => {
      const { goals, tools } = await goalFixture({
        criteria: [{ text: "Parser tests pass", check: "bun run test parser" }],
        exitCodes: { "bun run test parser": 0 },
        duringRun: async (live) => {
          const goal = live.read(threadId).goal;
          if (goal === null) return;
          await live.execute({
            kind: "revise-thread-goal",
            threadId,
            expectedVersion: goal.version,
            goalId: goal.id,
            revisionId: "00000000-0000-4000-8000-000000000398",
            objective: goal.objective,
            criteria: [{ text: "Parser and lexer tests pass", check: "bun run test parser" }],
          });
        },
      });
      expect((await call(tools, "goal-check", { criterionId: "c1" })).result).toMatchObject({
        error: "criterion-changed",
      });
      const goal = goals.read(threadId).goal;
      expect(goal?.status).toBe("active");
      expect(goal?.criteria?.[0]).toMatchObject({ status: "unmet" });
      expect(goal?.evidence).toEqual([]);
    });

    it("completes the goal on a second try when the first completion lost a race", async () => {
      const { goals, tools } = await goalFixture({
        criteria: [{ text: "Parser tests pass", check: "bun run test parser" }],
        exitCodes: { "bun run test parser": 0 },
      });
      const execute = goals.execute.bind(goals);
      let refusedOnce = false;
      goals.execute = async (input) => {
        if ((input as { kind?: string }).kind === "complete-thread-goal" && !refusedOnce) {
          refusedOnce = true;
          throw new Error("Goal version conflict; reload and retry.");
        }
        return execute(input);
      };
      const checked = await call(tools, "goal-check", { criterionId: "c1" });
      expect(checked.result).toMatchObject({ outcome: "met", goal: { status: "complete" } });
    });

    it("asks before a check exactly as before a shell command, naming the command it will run", async () => {
      const asked: string[] = [];
      const { tools, commands } = await goalFixture({
        criteria: [{ text: "Parser tests pass", check: "bun run test parser" }],
        exitCodes: { "bun run test parser": 0 },
        facts: { executionPolicy: "approval-gated", approvalSatisfied: false },
        approvals: async (input) => {
          asked.push(`${input.approvalClass}|${input.summary}`);
          return "denied";
        },
      });
      expect((await call(tools, "goal-check", { criterionId: "c1" })).result).toMatchObject({
        error: "approval-denied",
      });
      expect(asked).toEqual(["shell-commands|goal-check: bun run test parser"]);
      expect(commands).toEqual([]);
    });
  });
});
