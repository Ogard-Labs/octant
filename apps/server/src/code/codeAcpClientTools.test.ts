import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CodeThread, WindowId } from "@octant/contracts";
import { liveCodeTestSourcePort, type CodeTestSourcePort } from "./codeDirectoryPort";
import { createCodeAcpClientTools } from "./codeAcpClientTools";

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

function tools(root: string, executionPolicy: CodeThread["executionPolicy"]) {
  return createCodeAcpClientTools({
    windowId,
    thread: thread(executionPolicy),
    readExecutionPolicy: () => executionPolicy,
    checkoutRoot: root,
    uuid: () => "fixed-id",
    pathPort: liveCodeTestSourcePort,
    terminalConfinement: {
      environment: { PATH: "/usr/bin:/bin", TMPDIR: "/tmp" },
      prepare: ({ executable, args }) => ({ command: executable, args }),
    },
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
});
