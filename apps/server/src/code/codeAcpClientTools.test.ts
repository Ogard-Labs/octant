import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CodeThread, WindowId } from "@octant/contracts";
import { makeProcessConfinementLive } from "../process/seatbeltProfile";
import { liveCodeTestSourcePort, type CodeTestSourcePort } from "./codeDirectoryPort";
import { ACP_CLIENT_TOOL_NAMES } from "@octant/provider-sdk";
import type { NativeHarnessShellRun } from "../harness/nativeHarnessTools";
import {
  createCodeAcpClientTools,
  createRemoteCodeAcpClientTools,
  type CodeAcpTerminalConfinement,
  type RemoteCodeAcpClientToolsOptions,
} from "./codeAcpClientTools";

const windowId = "10000000-0000-4000-8000-000000000001" as WindowId;

function thread(executionPolicy: CodeThread["executionPolicy"]): CodeThread {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    checkoutId: "30000000-0000-4000-8000-000000000001",
    projectId: "40000000-0000-4000-8000-000000000001",
    repositoryId: "50000000-0000-4000-8000-000000000001",
    providerInstanceId: "60000000-0000-4000-8000-000000000001",
    modelId: "test-model",
    bindingRevisionId: "70000000-0000-4000-8000-000000000001",
    lifecycle: "active",
    executionPolicy,
    permissionPersistence: "current-session",
    title: "ACP tools",
    workingDirectory: ".",
    deliveryTarget: {
      branchIntent: "feature/acp-tools",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "main",
    },
    version: 1,
    createdAt: "2026-08-06T08:00:00.000Z",
    updatedAt: "2026-08-06T08:00:00.000Z",
  } as unknown as CodeThread;
}

function tools(
  root: string,
  executionPolicy: CodeThread["executionPolicy"],
  terminalConfinement: CodeAcpTerminalConfinement = {
    environment: { PATH: "/usr/bin:/bin", TMPDIR: "/tmp" },
    prepare: ({ executable, args }) => ({ command: executable, args }),
  },
) {
  return createCodeAcpClientTools({
    windowId,
    thread: thread(executionPolicy),
    readExecutionPolicy: () => executionPolicy,
    checkoutRoot: root,
    uuid: () => "fixed-id",
    pathPort: liveCodeTestSourcePort,
    terminalConfinement,
    wait: async (milliseconds) => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    },
  });
}

describe("ACP Code client tools", () => {
  it("reads and atomically writes only files inside the checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-acp-"));
    try {
      await writeFile(join(root, "note.txt"), "one\ntwo\nthree", "utf8");
      const appTools = tools(root, "full-access");
      await expect(
        appTools.execute({
          name: "octant_acp_fs_read_text_file",
          inputJson: JSON.stringify({ path: join(root, "note.txt"), line: 2, limit: 1 }),
        }),
      ).resolves.toEqual({ result: { content: "two" } });
      await expect(
        appTools.execute({
          name: "octant_acp_fs_write_text_file",
          inputJson: JSON.stringify({ path: join(root, "written.txt"), content: "saved" }),
        }),
      ).resolves.toEqual({ result: {} });
      await expect(readFile(join(root, "written.txt"), "utf8")).resolves.toBe("saved");
      await expect(
        appTools.execute({
          name: "octant_acp_fs_read_text_file",
          inputJson: JSON.stringify({ path: join(root, "..", "outside.txt") }),
        }),
      ).resolves.toMatchObject({ result: { error: "path-outside-checkout" }, isError: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("advertises only read access and refuses writes in Plan mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-acp-"));
    try {
      const appTools = tools(root, "plan");
      expect(appTools.definitions.map((definition) => definition.name)).toEqual([
        "octant_acp_fs_read_text_file",
      ]);
      await expect(
        appTools.execute({
          name: "octant_acp_fs_write_text_file",
          inputJson: JSON.stringify({ path: join(root, "note.txt"), content: "blocked" }),
        }),
      ).resolves.toMatchObject({ result: { error: "read-only-posture" }, isError: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rechecks the live posture before writes and terminal creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-acp-"));
    try {
      let executionPolicy: CodeThread["executionPolicy"] = "full-access";
      const appTools = createCodeAcpClientTools({
        windowId,
        thread: thread("full-access"),
        readExecutionPolicy: () => executionPolicy,
        checkoutRoot: root,
        uuid: () => "live-posture",
        pathPort: liveCodeTestSourcePort,
        terminalConfinement: {
          environment: { PATH: "/usr/bin:/bin", TMPDIR: "/tmp" },
          prepare: ({ executable, args }) => ({ command: executable, args }),
        },
        wait: async () => undefined,
      });
      executionPolicy = "plan";
      await expect(
        appTools.execute({
          name: "octant_acp_fs_write_text_file",
          inputJson: JSON.stringify({ path: join(root, "blocked.txt"), content: "blocked" }),
        }),
      ).resolves.toMatchObject({ result: { error: "read-only-posture" }, isError: true });
      await expect(
        appTools.execute({
          name: "octant_acp_terminal_create",
          inputJson: JSON.stringify({ command: "/bin/true" }),
        }),
      ).resolves.toMatchObject({ result: { error: "read-only-posture" }, isError: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns replacement characters promptly for a megabyte of invalid output", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-acp-"));
    try {
      const appTools = tools(root, "full-access");
      const created = await appTools.execute({
        name: "octant_acp_terminal_create",
        inputJson: JSON.stringify({
          command: "/usr/bin/perl",
          args: ["-e", "print chr(255) x (1024 * 1024)"],
        }),
      });
      const terminalId = (created.result as { terminalId: string }).terminalId;
      await appTools.execute({
        name: "octant_acp_terminal_wait_for_exit",
        inputJson: JSON.stringify({ terminalId }),
      });
      const output = await appTools.execute({
        name: "octant_acp_terminal_output",
        inputJson: JSON.stringify({ terminalId }),
      });
      expect(output).toMatchObject({ result: { truncated: false } });
      expect((output.result as { output: string }).output).toContain("\ufffd");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects reserved terminal environment overlays and missing executables without crashing", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-acp-"));
    try {
      const appTools = tools(root, "full-access");
      await expect(
        appTools.execute({
          name: "octant_acp_terminal_create",
          inputJson: JSON.stringify({
            command: "/bin/true",
            env: [{ name: "PATH", value: "/tmp" }],
          }),
        }),
      ).resolves.toMatchObject({ result: { error: "invalid-environment" }, isError: true });
      await expect(
        appTools.execute({
          name: "octant_acp_terminal_create",
          inputJson: JSON.stringify({
            command: "/definitely/missing/octant-command",
            args: [],
          }),
        }),
      ).resolves.toMatchObject({ result: { error: "terminal-unavailable" }, isError: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an existing mode and derives a new file mode from umask", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-acp-"));
    try {
      const existing = join(root, "existing.txt");
      await writeFile(existing, "before", "utf8");
      await chmod(existing, 0o755);
      const appTools = tools(root, "full-access");
      await appTools.execute({
        name: "octant_acp_fs_write_text_file",
        inputJson: JSON.stringify({ path: existing, content: "after" }),
      });
      expect((await stat(existing)).mode & 0o777).toBe(0o755);
      const created = join(root, "created.txt");
      await appTools.execute({
        name: "octant_acp_fs_write_text_file",
        inputJson: JSON.stringify({ path: created, content: "new" }),
      });
      expect((await stat(created)).mode & 0o777).toBe(0o666 & ~process.umask());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a read when the opened handle identity differs from the resolved path", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-acp-"));
    try {
      const path = join(root, "identity.txt");
      await writeFile(path, "contents", "utf8");
      const mismatchedPort: CodeTestSourcePort = {
        ...liveCodeTestSourcePort,
        openFile: async (openedPath) => {
          const handle = await liveCodeTestSourcePort.openFile(openedPath);
          return {
            ...handle,
            stat: async () => {
              const info = await handle.stat();
              return { ...info, inode: `${info.inode}-changed` };
            },
          };
        },
      };
      const appTools = createCodeAcpClientTools({
        windowId,
        thread: thread("full-access"),
        readExecutionPolicy: () => "full-access",
        checkoutRoot: root,
        uuid: () => "identity",
        pathPort: mismatchedPort,
        terminalConfinement: {
          environment: { PATH: "/usr/bin:/bin", TMPDIR: "/tmp" },
          prepare: ({ executable, args }) => ({ command: executable, args }),
        },
        wait: async () => undefined,
      });
      await expect(
        appTools.execute({
          name: "octant_acp_fs_read_text_file",
          inputJson: JSON.stringify({ path }),
        }),
      ).resolves.toMatchObject({ result: { error: "file-unreadable" }, isError: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs direct terminal argv and preserves UTF-8 output boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-acp-"));
    try {
      const appTools = tools(root, "full-access");
      const created = await appTools.execute({
        name: "octant_acp_terminal_create",
        inputJson: JSON.stringify({
          command: "/usr/bin/printf",
          args: ["éé"],
          outputByteLimit: 3,
        }),
      });
      const terminalId = (created.result as { terminalId: string }).terminalId;
      await expect(
        appTools.execute({
          name: "octant_acp_terminal_wait_for_exit",
          inputJson: JSON.stringify({ terminalId }),
        }),
      ).resolves.toMatchObject({ result: { exitCode: 0 } });
      await expect(
        appTools.execute({
          name: "octant_acp_terminal_output",
          inputJson: JSON.stringify({ terminalId }),
        }),
      ).resolves.toMatchObject({ result: { output: "é", truncated: true } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs an ACP shell command through the confined shell when args are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-acp-"));
    try {
      const appTools = tools(root, "full-access");
      const created = await appTools.execute({
        name: "octant_acp_terminal_create",
        inputJson: JSON.stringify({ command: "printf a && printf b" }),
      });
      const terminalId = (created.result as { terminalId: string }).terminalId;
      await expect(
        appTools.execute({
          name: "octant_acp_terminal_wait_for_exit",
          inputJson: JSON.stringify({ terminalId }),
        }),
      ).resolves.toMatchObject({ result: { exitCode: 0 } });
      await expect(
        appTools.execute({
          name: "octant_acp_terminal_output",
          inputJson: JSON.stringify({ terminalId }),
        }),
      ).resolves.toMatchObject({ result: { output: "ab" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an explicit empty args array on the direct executable path", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-acp-"));
    try {
      const appTools = tools(root, "full-access");
      const created = await appTools.execute({
        name: "octant_acp_terminal_create",
        inputJson: JSON.stringify({ command: "/usr/bin/true", args: [] }),
      });
      const terminalId = (created.result as { terminalId: string }).terminalId;
      await expect(
        appTools.execute({
          name: "octant_acp_terminal_wait_for_exit",
          inputJson: JSON.stringify({ terminalId }),
        }),
      ).resolves.toMatchObject({ result: { exitCode: 0 } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps shell commands inside the confined working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-acp-"));
    try {
      const appTools = tools(root, "full-access");
      const created = await appTools.execute({
        name: "octant_acp_terminal_create",
        inputJson: JSON.stringify({ command: "cd .. && pwd" }),
      });
      const terminalId = (created.result as { terminalId: string }).terminalId;
      await expect(
        appTools.execute({
          name: "octant_acp_terminal_wait_for_exit",
          inputJson: JSON.stringify({ terminalId }),
        }),
      ).resolves.toMatchObject({ result: { exitCode: 0 } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "darwin")(
    "refuses shell writes outside the checkout with the production confinement",
    async () => {
      const root = await mkdtemp(join(process.cwd(), ".octant-acp-"));
      const outside = join(root, "..", `${basename(root)}-outside.txt`);
      const environment = {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: process.env.HOME ?? "/tmp",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
      };
      const confinement = makeProcessConfinementLive({ platform: "darwin" });
      try {
        const appTools = tools(root, "full-access", {
          environment,
          prepare: (input) =>
            confinement.prepare({
              ...input,
              networkEgress: "allow",
              allowProcessExec: true,
              allowProcessFork: true,
              allowFileReadStar: true,
              writeBoundRoot: true,
              readRoots: [input.boundRoot, input.temporaryDirectory, "/bin"],
            }),
        });
        const created = await appTools.execute({
          name: "octant_acp_terminal_create",
          inputJson: JSON.stringify({
            command: `printf escaped > ../${basename(outside)}`,
          }),
        });
        const terminalId = (created.result as { terminalId: string }).terminalId;
        const exit = await appTools.execute({
          name: "octant_acp_terminal_wait_for_exit",
          inputJson: JSON.stringify({ terminalId }),
        });
        expect((exit.result as { exitCode?: number }).exitCode).not.toBe(0);
        expect(existsSync(outside)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { force: true });
      }
    },
  );
});

describe("ACP Code client tools on an SSH target", () => {
  const remoteRoot = "/home/build/app";

  /** The target's file tool and shell as a turn's remote harness binds them, recording each call. */
  function remote(
    executionPolicy: CodeThread["executionPolicy"],
    files: Record<string, string> = {},
  ) {
    const calls: string[] = [];
    const commands: Array<{ readonly command: string; readonly signal?: AbortSignal }> = [];
    let finishCommand: (run: NativeHarnessShellRun) => void = () => undefined;
    const filesystem: RemoteCodeAcpClientToolsOptions["filesystem"] = {
      read: async ({ path, offset, limit }) => {
        calls.push(`read ${path}@${String(offset ?? 0)}`);
        const content = files[path];
        if (content === undefined) return { kind: "refused", reason: "path-not-found" };
        const all = content.split("\n");
        const start = offset ?? 0;
        // Two lines a run, so a whole file takes several.
        const lines = all.slice(start, start + Math.min(limit ?? 2, 2));
        const next = start + lines.length;
        return {
          kind: "file",
          path,
          startLine: start,
          lines,
          totalLines: all.length,
          ...(next < all.length ? { nextLine: next } : {}),
          bounds: { truncated: next < all.length, returnedBytes: 0 },
        };
      },
      write: async ({ path, content }) => {
        calls.push(`write ${path}`);
        files[path] = content;
        return { kind: "written", path, bytes: content.length, created: true };
      },
    };
    const tools = createRemoteCodeAcpClientTools({
      root: remoteRoot,
      thread: thread(executionPolicy),
      readExecutionPolicy: () => executionPolicy,
      filesystem,
      shell: {
        run: (input) => {
          calls.push("command");
          commands.push({
            command: input.command,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
          return new Promise((resolve) => {
            finishCommand = resolve;
            input.signal?.addEventListener("abort", () =>
              resolve({ status: "cancelled", output: "stopped", truncated: false }),
            );
          });
        },
      },
      uuid: () => "terminal-1",
    });
    const call = async (name: string, input: unknown, signal?: AbortSignal) =>
      tools.execute({
        name,
        inputJson: JSON.stringify(input),
        ...(signal === undefined ? {} : { signal }),
      });
    return {
      tools,
      calls,
      commands,
      call,
      finish: (run: NativeHarnessShellRun) => finishCommand(run),
    };
  }

  it("refuses a client file write or a terminal in Plan before anything is asked of the target", async () => {
    const target = remote("plan");
    expect(target.tools.definitions.map((definition) => definition.name)).toEqual([
      ACP_CLIENT_TOOL_NAMES.readTextFile,
    ]);
    expect(
      await target.call(ACP_CLIENT_TOOL_NAMES.writeTextFile, {
        path: `${remoteRoot}/notes.md`,
        content: "planned",
      }),
    ).toEqual({ result: { error: "read-only-posture" }, isError: true });
    expect(
      await target.call(ACP_CLIENT_TOOL_NAMES.terminalCreate, { command: "touch planned" }),
    ).toEqual({ result: { error: "read-only-posture" }, isError: true });
    expect(target.calls).toEqual([]);
  });

  it("reads a whole file run after run through the target's file tool, and a span of it once", async () => {
    const target = remote("approval-gated", {
      [`${remoteRoot}/README.md`]: "one\ntwo\nthree\nfour\nfive",
    });
    expect(
      await target.call(ACP_CLIENT_TOOL_NAMES.readTextFile, { path: `${remoteRoot}/README.md` }),
    ).toEqual({ result: { content: "one\ntwo\nthree\nfour\nfive" } });
    expect(
      await target.call(ACP_CLIENT_TOOL_NAMES.readTextFile, {
        path: `${remoteRoot}/README.md`,
        line: 2,
        limit: 2,
      }),
    ).toEqual({ result: { content: "two\nthree" } });
    expect(await target.call(ACP_CLIENT_TOOL_NAMES.readTextFile, { path: "README.md" })).toEqual({
      result: { error: "path-outside-checkout" },
      isError: true,
    });
    expect(target.calls).toEqual([
      `read ${remoteRoot}/README.md@0`,
      `read ${remoteRoot}/README.md@2`,
      `read ${remoteRoot}/README.md@4`,
      `read ${remoteRoot}/README.md@1`,
    ]);
  });

  it("writes a file on the target in a writing posture", async () => {
    const files: Record<string, string> = {};
    const target = remote("auto-accept-edits", files);
    expect(
      await target.call(ACP_CLIENT_TOOL_NAMES.writeTextFile, {
        path: `${remoteRoot}/notes.md`,
        content: "written on the target",
      }),
    ).toEqual({ result: {} });
    expect(files[`${remoteRoot}/notes.md`]).toBe("written on the target");
  });

  it("runs a terminal as one command on the target, with its output and exit once it ended", async () => {
    const target = remote("approval-gated");
    expect(
      await target.call(ACP_CLIENT_TOOL_NAMES.terminalCreate, {
        command: "printf",
        args: ["%s\\n", "it's here"],
        env: [{ name: "GREETING", value: "a'b" }],
        cwd: `${remoteRoot}/src`,
        outputByteLimit: 4,
      }),
    ).toEqual({ result: { terminalId: "terminal-1" } });
    // Every word reaches the target's shell exactly as the agent gave it.
    expect(target.commands[0]?.command).toBe(
      [
        `cd -- '${remoteRoot}/src' || exit 126`,
        "export GREETING='a'\\''b'",
        "exec 'printf' '%s\\n' 'it'\\''s here'",
      ].join("\n"),
    );
    // The executor answers once the command ended; until then there is nothing to read.
    expect(
      await target.call(ACP_CLIENT_TOOL_NAMES.terminalOutput, { terminalId: "terminal-1" }),
    ).toEqual({ result: { output: "", truncated: false } });
    target.finish({ status: "ran", exitCode: 0, output: "it's here\n", truncated: false });
    expect(
      await target.call(ACP_CLIENT_TOOL_NAMES.terminalWaitForExit, { terminalId: "terminal-1" }),
    ).toEqual({ result: { exitCode: 0 } });
    expect(
      await target.call(ACP_CLIENT_TOOL_NAMES.terminalOutput, { terminalId: "terminal-1" }),
    ).toEqual({ result: { output: "ere\n", truncated: true, exitStatus: { exitCode: 0 } } });
    expect(
      await target.call(ACP_CLIENT_TOOL_NAMES.terminalRelease, { terminalId: "terminal-1" }),
    ).toEqual({ result: {} });
    expect(
      await target.call(ACP_CLIENT_TOOL_NAMES.terminalOutput, { terminalId: "terminal-1" }),
    ).toEqual({ result: { error: "terminal-unknown" }, isError: true });
  });

  it("stops a terminal's command on the target when it is killed", async () => {
    const target = remote("approval-gated");
    await target.call(ACP_CLIENT_TOOL_NAMES.terminalCreate, { command: "sleep 600" });
    expect(
      await target.call(ACP_CLIENT_TOOL_NAMES.terminalKill, { terminalId: "terminal-1" }),
    ).toEqual({ result: {} });
    expect(target.commands[0]?.signal?.aborted).toBe(true);
    expect(
      await target.call(ACP_CLIENT_TOOL_NAMES.terminalWaitForExit, { terminalId: "terminal-1" }),
    ).toEqual({ result: { signal: "SIGTERM" } });
  });

  it("refuses a working folder outside the bound root, and a variable that would redirect the command's proxy", async () => {
    const target = remote("approval-gated");
    for (const cwd of ["/home/build", `${remoteRoot}/../other`, "/etc"]) {
      expect(
        await target.call(ACP_CLIENT_TOOL_NAMES.terminalCreate, { command: "ls", cwd }),
      ).toEqual({ result: { error: "cwd-outside-checkout" }, isError: true });
    }
    for (const name of ["HTTPS_PROXY", "no_proxy", "PATH", "HOME"]) {
      expect(
        await target.call(ACP_CLIENT_TOOL_NAMES.terminalCreate, {
          command: "ls",
          env: [{ name, value: "http://elsewhere.example" }],
        }),
      ).toEqual({ result: { error: "invalid-environment" }, isError: true });
    }
    expect(target.calls).toEqual([]);
  });
});
