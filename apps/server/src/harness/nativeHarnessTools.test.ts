import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeNativeHarnessContextRemaining, type ToolActionAuthority } from "@octant/contracts";
import { ToolCallAuthorityService, type ToolCallLiveFacts } from "../toolCallAuthorityService";
import { NativeHarnessFileSystem } from "./nativeHarnessFileSystem";
import { createNativeHarnessTools, type NativeHarnessToolPorts } from "./nativeHarnessTools";

const uuid = (() => {
  let counter = 0;
  return () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
})();

const authority: ToolActionAuthority = {
  hostId: "00000000-0000-4000-8000-0000000000aa",
  mode: "code",
  projectId: "00000000-0000-4000-8000-0000000000bb",
  rootId: "00000000-0000-4000-8000-0000000000cc",
  worktreeId: "00000000-0000-4000-8000-0000000000dd",
  providerInstanceId: "00000000-0000-4000-8000-0000000000ee",
  extension: { kind: "core" },
} as ToolActionAuthority;

function service(facts: Partial<ToolCallLiveFacts>, authorized = true): ToolCallAuthorityService {
  return new ToolCallAuthorityService({
    resolveGrantedAuthority: () => (authorized ? authority : undefined),
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
    resolveAuthority: () => ({ ...authority, mode }),
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
      resolveAuthority: () => authority,
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
});
