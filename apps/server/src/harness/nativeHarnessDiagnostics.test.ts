import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderExecutionPolicy, ToolActionAuthority } from "@octant/contracts";
import { ToolCallAuthorityService, type ToolCallLiveFacts } from "../toolCallAuthorityService";
import { parseDiagnostics } from "./nativeHarnessDiagnostics";
import { NativeHarnessFileSystem } from "./nativeHarnessFileSystem";
import {
  createNativeHarnessTools,
  type NativeHarnessShellRun,
  type NativeHarnessToolPorts,
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

interface Ran {
  readonly command: string;
  readonly cwd: string;
}

async function fixture(input: {
  readonly files?: Readonly<Record<string, string>>;
  readonly facts?: Partial<ToolCallLiveFacts>;
  readonly output?: (command: string) => Partial<NativeHarnessShellRun>;
  readonly ports?: Partial<NativeHarnessToolPorts>;
  readonly mode?: "work" | "code";
  readonly turn?: () => ProviderExecutionPolicy | undefined;
}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "octant-harness-diagnostics-")));
  for (const [name, content] of Object.entries(input.files ?? {})) {
    await writeFile(join(root, name), content);
  }
  const ran: Ran[] = [];
  const mode = input.mode ?? "code";
  const tools = createNativeHarnessTools({
    threadId: "thread-1",
    mode,
    ...(input.turn === undefined ? {} : { resolveTurnExecutionPolicy: input.turn }),
    authority: new ToolCallAuthorityService({
      resolveGrantedAuthority: () => ({ ...authority, mode }) as unknown as ToolActionAuthority,
      resolveLiveFacts: () => ({
        providerAppManagedTools: "supported",
        host: { computerUseEnabled: false },
        executionPolicy: "full-access",
        approvalSatisfied: true,
        externalContentIngested: false,
        ...input.facts,
      }),
    }),
    resolveAuthority: () => ({ ...authority, mode }) as unknown as ToolActionAuthority,
    ports: {
      filesystem: new NativeHarnessFileSystem({ root }),
      shell: {
        run: async ({ command, cwd }) => {
          ran.push({ command, cwd });
          return {
            status: "ran",
            exitCode: 0,
            output: "",
            truncated: false,
            ...input.output?.(command),
          };
        },
      },
      ...input.ports,
    },
    uuid,
  });
  const call = (args: unknown) =>
    tools.execute({ name: "diagnostics", inputJson: JSON.stringify(args) });
  return { root, ran, tools, call };
}

const scripts = (entries: Readonly<Record<string, string>>) =>
  JSON.stringify({ name: "fixture", scripts: entries });

describe("native harness diagnostics", () => {
  it("reads problems from tsc, unix-style linters, Biome, and ESLint's default listing", () => {
    const root = "/repo";
    const output = [
      "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "@octant/server:typecheck: src/b.ts:10:2 - error TS2304: Cannot find name 'x'.",
      "/repo/src/c.ts:4:1: Missing semicolon. [Error/semi]",
      "src/d.ts:8:3: Variable 'y' is unused. [Warning/eslint(no-unused-vars)]",
      "src/e.ts:1:7 lint/style/useConst  FIXABLE  ━━━━━━━━",
      "",
      "  ✖ This let declares a variable that is only assigned once.",
      "/repo/src/f.ts",
      "  2:5  warning  'z' is defined but never used  no-unused-vars",
      "12:30:45: build started",
    ].join("\n");
    expect(parseDiagnostics(output, root)).toEqual([
      {
        file: "src/a.ts",
        line: 3,
        column: 7,
        severity: "error",
        message: "Type 'string' is not assignable to type 'number'.",
        code: "TS2322",
      },
      {
        package: "@octant/server",
        file: "src/b.ts",
        line: 10,
        column: 2,
        severity: "error",
        message: "Cannot find name 'x'.",
        code: "TS2304",
      },
      {
        file: "src/c.ts",
        line: 4,
        column: 1,
        severity: "error",
        message: "Missing semicolon.",
        code: "semi",
      },
      {
        file: "src/d.ts",
        line: 8,
        column: 3,
        severity: "warning",
        message: "Variable 'y' is unused.",
        code: "eslint(no-unused-vars)",
      },
      {
        file: "src/e.ts",
        line: 1,
        column: 7,
        severity: "error",
        message: "This let declares a variable that is only assigned once.",
        code: "lint/style/useConst",
      },
      {
        file: "src/f.ts",
        line: 2,
        column: 5,
        severity: "warning",
        message: "'z' is defined but never used",
        code: "no-unused-vars",
      },
    ]);
  });

  it("runs the checkout's own typecheck and lint scripts with the package manager its lockfile names", async () => {
    const { ran, root, call } = await fixture({
      files: {
        "package.json": scripts({ typecheck: "tsc --noEmit", lint: "eslint ." }),
        "bun.lock": "",
      },
      output: (command) =>
        command.endsWith("typecheck")
          ? { exitCode: 2, output: "src/a.ts(1,1): error TS1005: ';' expected." }
          : { exitCode: 0, output: "" },
    });
    const outcome = await call({});
    expect(ran).toEqual([
      { command: "bun run typecheck", cwd: root },
      { command: "bun run lint", cwd: root },
    ]);
    expect(outcome.isError).toBe(true);
    expect(outcome.result).toMatchObject({
      clean: false,
      totalProblems: 1,
      problems: [{ file: "src/a.ts", line: 1, column: 1, code: "TS1005" }],
      runs: [
        { check: "typecheck", command: "bun run typecheck", exitCode: 2, problemsFound: 1 },
        { check: "lint", command: "bun run lint", exitCode: 0, problemsFound: 0 },
      ],
    });
  });

  it("falls back to the check script and says which requested script was missing", async () => {
    const npm = await fixture({ files: { "package.json": scripts({ check: "biome check ." }) } });
    expect((await npm.call({ which: "lint" })).result).toMatchObject({ clean: true });
    expect(npm.ran.map((run) => run.command)).toEqual(["npm run check"]);

    const pnpm = await fixture({
      files: { "package.json": scripts({ typecheck: "tsc" }), "pnpm-lock.yaml": "" },
    });
    expect((await pnpm.call({ which: "both" })).result).toMatchObject({
      notes: ["No lint script was found, so no lint ran."],
    });
    expect(pnpm.ran.map((run) => run.command)).toEqual(["pnpm run typecheck"]);
  });

  it("refuses without running anything when no command is found, and says how to name one", async () => {
    const { ran, call } = await fixture({ files: { "package.json": scripts({ build: "tsc" }) } });
    const outcome = await call({ which: "typecheck" });
    expect(outcome.isError).toBe(true);
    expect(outcome.result).toMatchObject({ error: "no-diagnostics-command" });
    expect((outcome.result as { message: string }).message).toContain("Pass the command");
    expect(ran).toEqual([]);
  });

  it("does not count its own look at package.json as the model's read before an edit", async () => {
    const { tools, call } = await fixture({
      files: { "package.json": scripts({ lint: "eslint ." }) },
    });
    await call({ which: "lint" });
    const edit = await tools.execute({
      name: "edit",
      inputJson: JSON.stringify({ path: "package.json", oldText: "eslint .", newText: "x" }),
    });
    expect(edit.result).toMatchObject({ error: "not-read-first" });
  });

  it("keeps a whole path that contains spaces, after a runner prefix too", () => {
    const root = "/repo/my project";
    const output = [
      "/repo/my project/src/a.ts(3,7): error TS2322: Bad type.",
      "web:typecheck: src/my file.ts:4:2 - error TS2304: Cannot find name 'x'.",
      "src/other dir/b.ts:5:1: Missing semicolon. [Error/semi]",
      "src/other dir/c.ts:1:7 lint/style/useConst  FIXABLE  ━━━━",
      "  ✖ Use const.",
    ].join("\n");
    expect(
      parseDiagnostics(output, root).map(({ file, line, package: name }) => ({
        file,
        line,
        package: name,
      })),
    ).toEqual([
      { file: "src/a.ts", line: 3, package: undefined },
      { file: "src/my file.ts", line: 4, package: "web" },
      { file: "src/other dir/b.ts", line: 5, package: undefined },
      { file: "src/other dir/c.ts", line: 1, package: undefined },
    ]);
  });

  it("keeps the same problem from two packages apart and still filters them by file", async () => {
    const line = "src/index.ts(3,7): error TS2322: Bad type.";
    const output = [
      `@octant/contracts:typecheck: ${line}`,
      `@octant/domain:typecheck: ${line}`,
      `@octant/domain:typecheck: ${line}`,
    ].join("\n");
    expect(parseDiagnostics(output, "/repo")).toEqual([
      expect.objectContaining({ file: "src/index.ts", package: "@octant/contracts" }),
      expect.objectContaining({ file: "src/index.ts", package: "@octant/domain" }),
    ]);
    const { call } = await fixture({ output: () => ({ exitCode: 2, output }) });
    expect(
      (await call({ command: "turbo run typecheck", files: ["src/index.ts"] })).result,
    ).toMatchObject({ totalProblems: 2 });
  });

  it("runs an explicit command instead of looking for scripts", async () => {
    const { ran, call } = await fixture({});
    await call({ which: "lint", command: "oxlint -f unix" });
    expect(ran.map((run) => run.command)).toEqual(["oxlint -f unix"]);
  });

  it("does not call a failing command with nothing it could read clean, and keeps its output", async () => {
    const { call } = await fixture({
      output: () => ({ exitCode: 1, output: "Something went badly wrong" }),
    });
    const outcome = await call({ command: "make lint" });
    expect(outcome.isError).toBe(true);
    expect(outcome.result).toMatchObject({
      clean: false,
      totalProblems: 0,
      runs: [{ exitCode: 1, problemsFound: 0, outputTail: "Something went badly wrong" }],
    });
    expect((outcome.result as { notes: ReadonlyArray<string> }).notes[0]).toContain(
      "not a clean result",
    );
  });

  it("never calls a run clean when the shell cut its output, and says so", async () => {
    const { call } = await fixture({
      output: () => ({ exitCode: 0, output: "lots of log lines", truncated: true }),
    });
    const outcome = await call({ command: "bun run lint" });
    expect(outcome.result).toMatchObject({
      clean: false,
      runs: [{ exitCode: 0, outputTruncated: true }],
    });
    expect((outcome.result as { notes: ReadonlyArray<string> }).notes[0]).toContain(
      "output was cut",
    );
  });

  it("narrows problems to the files asked about and caps the list with a note", async () => {
    const lines = Array.from({ length: 150 }, (_, index) => `src/many.ts:${index + 1}:1: problem`);
    const { call } = await fixture({
      output: () => ({ exitCode: 1, output: [...lines, "src/other.ts:1:1: elsewhere"].join("\n") }),
    });
    const all = (await call({ command: "lint" })).result as {
      problems: ReadonlyArray<unknown>;
      totalProblems: number;
      truncated: string;
    };
    expect(all.problems).toHaveLength(100);
    expect(all.totalProblems).toBe(151);
    expect(all.truncated).toContain("51 were left out");
    expect((await call({ command: "lint", files: ["./src/other.ts"] })).result).toMatchObject({
      problems: [{ file: "src/other.ts", message: "elsewhere" }],
      totalProblems: 1,
      outsideFiles: 150,
    });
  });

  it("asks for each command exactly as bash would and runs nothing the person refused", async () => {
    const asked: Array<{ toolName: string; approvalClass: string; command: unknown }> = [];
    const { ran, call } = await fixture({
      files: { "package.json": scripts({ typecheck: "tsc", lint: "eslint ." }) },
      facts: { executionPolicy: "approval-gated", approvalSatisfied: false },
      ports: {
        approvals: async (input) => {
          asked.push({
            toolName: input.toolName,
            approvalClass: input.approvalClass,
            command: (input.arguments as { command?: unknown }).command,
          });
          return asked.length === 1 ? "approved" : "denied";
        },
      },
    });
    const outcome = await call({});
    expect(asked).toEqual([
      { toolName: "bash", approvalClass: "shell-commands", command: "npm run typecheck" },
      { toolName: "bash", approvalClass: "shell-commands", command: "npm run lint" },
    ]);
    expect(ran.map((run) => run.command)).toEqual(["npm run typecheck"]);
    expect(outcome.result).toMatchObject({
      clean: false,
      runs: [
        { command: "npm run typecheck", status: "ran" },
        { command: "npm run lint", status: "refused", error: "approval-denied" },
      ],
    });
  });

  it("is offered only in Code outside Plan, and refuses a turn narrowed to Plan", async () => {
    const work = await fixture({ mode: "work" });
    expect(work.tools.definitions.map((definition) => definition.name)).not.toContain(
      "diagnostics",
    );
    const narrowed = await fixture({
      files: { "package.json": scripts({ lint: "eslint ." }) },
      turn: () => "plan",
    });
    expect(narrowed.tools.definitions.map((definition) => definition.name)).toContain(
      "diagnostics",
    );
    const outcome = await narrowed.call({});
    expect(outcome.result).toMatchObject({ error: "plan-mode-denied" });
    expect(narrowed.ran).toEqual([]);
  });
});
