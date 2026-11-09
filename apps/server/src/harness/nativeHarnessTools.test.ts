import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_NATIVE_HARNESS_SKILL_CHARACTERS,
  decodeNativeHarnessContextRemaining,
  type ProviderExecutionPolicy,
  type ToolActionAuthority,
} from "@octant/contracts";
import { ToolCallAuthorityService, type ToolCallLiveFacts } from "../toolCallAuthorityService";
import { GoalService } from "../goal/goalService";
import { InMemoryGoalStore } from "../goal/goalService.test-support";
import { buildPdfFixture } from "../preview/previewTestFixtures";
import { NativeHarnessFileSystem } from "./nativeHarnessFileSystem";
import { createNativeHarnessGoalPort } from "./nativeHarnessGoal";
import { createNativeHarnessTools, type NativeHarnessToolPorts } from "./nativeHarnessTools";

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
  turnExecutionPolicy?: () => ProviderExecutionPolicy | undefined,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "octant-harness-tools-")));
  await writeFile(join(root, "a.ts"), "hello\n");
  const filesystem = new NativeHarnessFileSystem({ root });
  const tools = createNativeHarnessTools({
    threadId: "thread-1",
    mode,
    ...(turnExecutionPolicy === undefined
      ? {}
      : { resolveTurnExecutionPolicy: turnExecutionPolicy }),
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
      "diagnostics",
    ]);
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

  describe("reading images and PDFs", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

    it("hands an image to a model that takes images, beside a result that holds no pixels", async () => {
      const { root, tools } = await fixture({}, { readsImages: () => true });
      await writeFile(join(root, "shot.png"), png);
      expect(await call(tools, "read", { path: "shot.png" })).toEqual({
        result: { kind: "image", path: "shot.png", mimeType: "image/png", bytes: png.length },
        isError: false,
        images: [{ mimeType: "image/png", data: png.toString("base64") }],
      });
    });

    it("refuses an image when the model cannot take images", async () => {
      for (const ports of [{ readsImages: () => false }, {}]) {
        const { root, tools } = await fixture({}, ports);
        await writeFile(join(root, "shot.png"), png);
        const outcome = await call(tools, "read", { path: "shot.png" });
        expect(outcome).toMatchObject({
          result: { error: "image-input-unsupported" },
          isError: true,
        });
        expect(outcome).not.toHaveProperty("images");
      }
    });

    it("returns a PDF's page text, without marking the read as outside content", async () => {
      const { root, tools } = await fixture();
      await writeFile(join(root, "paper.pdf"), buildPdfFixture([["Abstract"]]));
      const outcome = await call(tools, "read", { path: "paper.pdf" });
      expect(outcome).toMatchObject({
        result: { kind: "file", extractedFrom: "pdf" },
        isError: false,
      });
      expect(outcome).not.toHaveProperty("outsideContent");
    });
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
      ["edit", { edits: [{ path: "a.ts", oldText: "hello", newText: "bye" }] }],
      ["bash", { command: "echo hi" }],
    ] as const) {
      const outcome = await call(tools, name, input);
      expect(outcome.isError).toBe(true);
      expect((outcome.result as { error: string }).error).toBe("plan-mode-denied");
    }
    expect((await call(tools, "read", { path: "a.ts" })).isError).toBe(false);
  });

  describe("a turn narrower than its thread", () => {
    const shell = {
      run: async () => ({ status: "ran" as const, exitCode: 0, output: "", truncated: false }),
    };
    const writes = [
      ["write", { path: "b.ts", content: "x" }],
      ["edit", { path: "a.ts", oldText: "hello", newText: "bye" }],
      ["bash", { command: "echo hi" }],
    ] as const;

    it.each([
      ["approval-gated", false],
      ["auto-accept-edits", false],
      ["full-access", true],
    ] as const)(
      "refuses edits, writes, and the shell to a turn narrowed to Plan on a %s thread",
      async (executionPolicy, approvalSatisfied) => {
        const { tools } = await fixture(
          { executionPolicy, approvalSatisfied },
          { shell },
          "code",
          () => "plan",
        );
        for (const [name, input] of writes) {
          const outcome = await call(tools, name, input);
          expect(outcome.isError).toBe(true);
          expect((outcome.result as { error: string }).error).toBe("plan-mode-denied");
        }
        expect((await call(tools, "read", { path: "a.ts" })).isError).toBe(false);
      },
    );

    it("refuses a write composed before the turn narrowed to Plan", async () => {
      let turn: ProviderExecutionPolicy | undefined;
      const { tools } = await fixture({}, { shell }, "code", () => turn);
      expect(tools.definitions.map((definition) => definition.name)).toContain("write");
      expect((await call(tools, "write", { path: "b.ts", content: "x" })).isError).toBe(false);
      turn = "plan";
      const refused = await call(tools, "write", { path: "c.ts", content: "x" });
      expect(refused.isError).toBe(true);
      expect((refused.result as { error: string }).error).toBe("plan-mode-denied");
    });

    it("never lets a turn's wider posture lift the thread's own", async () => {
      const { tools } = await fixture(
        { executionPolicy: "approval-gated", approvalSatisfied: false },
        {},
        "code",
        () => "full-access",
      );
      const write = await call(tools, "write", { path: "b.ts", content: "x" });
      expect((write.result as { error: string }).error).toBe("approval-required");
    });

    it("asks before a write when a turn narrows a full-access thread to approval-gated", async () => {
      const { tools } = await fixture(
        { executionPolicy: "full-access", approvalSatisfied: true },
        {},
        "code",
        () => "approval-gated",
      );
      const write = await call(tools, "write", { path: "b.ts", content: "x" });
      expect((write.result as { error: string }).error).toBe("approval-required");
    });

    it("keeps the thread's own posture for a turn that holds no narrower one", async () => {
      const { tools } = await fixture(
        { executionPolicy: "approval-gated", approvalSatisfied: false },
        {},
        "code",
        () => undefined,
      );
      const write = await call(tools, "write", { path: "b.ts", content: "x" });
      expect((write.result as { error: string }).error).toBe("approval-required");
    });
  });

  it("asks for a fresh confirmation before a write on a tainted thread, even with a standing approval", async () => {
    const { tools } = await fixture({
      executionPolicy: "auto-accept-edits",
      externalContentIngested: true,
    });
    const write = await call(tools, "write", { path: "b.ts", content: "x" });
    expect((write.result as { error: string }).error).toBe("approval-required");
    expect((write.result as { message: string }).message).toContain("project-file-writes");
    expect((await call(tools, "read", { path: "a.ts" })).isError).toBe(false);
  });

  it("writes on a tainted thread at Full access without asking", async () => {
    const { tools } = await fixture({ externalContentIngested: true });
    expect((await call(tools, "write", { path: "b.ts", content: "x" })).isError).toBe(false);
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
      result: { error: "tool-authority-stale", message: expect.stringContaining("Do not retry") },
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

  it("asks once for an edit of several files, naming each, and applies them all", async () => {
    const summaries: string[] = [];
    const { root, tools } = await fixture(
      { executionPolicy: "approval-gated", approvalSatisfied: false },
      {
        approvals: async (input) => {
          summaries.push(`${input.approvalClass} ${input.summary}`);
          return "approved";
        },
      },
    );
    await writeFile(join(root, "b.ts"), "world\n");
    await call(tools, "read", { path: "a.ts" });
    await call(tools, "read", { path: "b.ts" });
    const edited = await call(tools, "edit", {
      edits: [
        { path: "a.ts", oldText: "hello", newText: "hi" },
        { path: "b.ts", oldText: "world", newText: "there" },
      ],
    });
    expect(edited).toMatchObject({ isError: false, result: { kind: "edited" } });
    expect(summaries).toEqual(["project-file-writes edit (2 files): a.ts, b.ts"]);
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("hi\n");
    expect(await readFile(join(root, "b.ts"), "utf8")).toBe("there\n");
  });

  it("tells the model which replacement stopped an edit and that no file changed", async () => {
    const { root, tools } = await fixture();
    await call(tools, "read", { path: "a.ts" });
    const refusedEdit = await call(tools, "edit", {
      edits: [
        { path: "a.ts", oldText: "hello", newText: "hi" },
        { path: "a.ts", oldText: "missing", newText: "x" },
      ],
    });
    expect(refusedEdit).toEqual({
      isError: true,
      result: {
        error: "old-text-not-found",
        edit: 1,
        message: "edits[1] (a.ts) was refused: old-text-not-found. No file was changed.",
      },
    });
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("hello\n");
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

  describe("goals", () => {
    const threadId = "00000000-0000-4000-8000-000000000301";
    async function goalFixture(input: {
      readonly criteria?: ReadonlyArray<{ readonly text: string; readonly check?: string }>;
      readonly exitCodes: Record<string, number>;
      readonly facts?: Partial<ToolCallLiveFacts>;
      readonly turnExecutionPolicy?: () => ProviderExecutionPolicy | undefined;
      readonly approvals?: NativeHarnessToolPorts["approvals"];
      readonly callEnded?: NativeHarnessToolPorts["callEnded"];
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
      const { tools } = await fixture(
        input.facts ?? {},
        {
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
          ...(input.callEnded === undefined ? {} : { callEnded: input.callEnded }),
        },
        "code",
        input.turnExecutionPolicy,
      );
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

    it("refuses a check to a turn narrowed to Plan and runs no command", async () => {
      const { tools, commands } = await goalFixture({
        criteria: [{ text: "Parser tests pass", check: "bun run test parser" }],
        exitCodes: { "bun run test parser": 0 },
        turnExecutionPolicy: () => "plan",
      });
      const checked = await call(tools, "goal-check", { criterionId: "c1" });
      expect(checked.isError).toBe(true);
      expect(checked.result).toMatchObject({ error: "plan-mode-denied" });
      expect(commands).toEqual([]);
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

    it("runs nothing when the check was changed while it waited for approval, and ends the approved call", async () => {
      let goals: GoalService | undefined;
      const approvedCalls: string[] = [];
      const endedCalls: string[] = [];
      const {
        tools,
        commands,
        goals: created,
      } = await goalFixture({
        criteria: [{ text: "Parser tests pass", check: "bun run test parser" }],
        exitCodes: { "bun run test parser": 0, true: 0 },
        facts: { executionPolicy: "approval-gated", approvalSatisfied: false },
        callEnded: (callId) => endedCalls.push(callId),
        approvals: async ({ callId }) => {
          approvedCalls.push(callId);
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
      // What the approval left for its command is let go though none ran.
      expect(endedCalls).toEqual(approvedCalls);
      expect(endedCalls).toHaveLength(1);
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

  describe("skills", () => {
    const longInstructions = "x".repeat(MAX_NATIVE_HARNESS_SKILL_CHARACTERS + 10);
    const skills: NonNullable<NativeHarnessToolPorts["skills"]> = {
      list: async () => ({ status: "listed", skills: [{ name: "review", description: "Review" }] }),
      load: async (name) =>
        name === "long"
          ? { status: "loaded", name, instructions: longInstructions }
          : name === "review"
            ? { status: "loaded", name, instructions: "Use the checklist." }
            : { status: "refused", reason: "skill-not-effective", message: `${name} is off.` },
    };

    it("offers skill in Chat and in a Plan turn, because it only reads", async () => {
      const chat = await fixture({}, { skills }, "chat");
      expect(chat.tools.definitions.map((definition) => definition.name)).toEqual(["skill"]);
      const plan = await fixture({ executionPolicy: "plan", approvalSatisfied: false }, { skills });
      expect(await call(plan.tools, "skill", { operation: "list" })).toEqual({
        result: { skills: [{ name: "review", description: "Review" }] },
        isError: false,
      });
    });

    it("returns a skill's instructions and passes a refusal through with its reason", async () => {
      const { tools } = await fixture({}, { skills });
      expect(await call(tools, "skill", { operation: "load", name: "review" })).toEqual({
        result: { name: "review", instructions: "Use the checklist.", truncated: false },
        isError: false,
      });
      expect(await call(tools, "skill", { operation: "load", name: "deploy" })).toEqual({
        result: { error: "skill-not-effective", message: "deploy is off." },
        isError: true,
      });
    });

    it("cuts long instructions, says how much was left out, and continues from the offset it names", async () => {
      const { tools } = await fixture({}, { skills });
      const first = await call(tools, "skill", { operation: "load", name: "long" });
      expect(first.result).toMatchObject({
        truncated: true,
        omittedCharacters: 10,
        nextOffset: MAX_NATIVE_HARNESS_SKILL_CHARACTERS,
        note: expect.stringContaining(`offset ${MAX_NATIVE_HARNESS_SKILL_CHARACTERS}`),
      });
      const rest = await call(tools, "skill", {
        operation: "load",
        name: "long",
        offset: MAX_NATIVE_HARNESS_SKILL_CHARACTERS,
      });
      expect(rest.result).toEqual({ name: "long", instructions: "x".repeat(10), truncated: false });
    });
  });
});
