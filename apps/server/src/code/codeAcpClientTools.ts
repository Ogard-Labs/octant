import { unlink, writeFile } from "node:fs/promises";
import { accessSync, constants, statSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { basename, delimiter, join, posix } from "node:path";
import { tmpdir } from "node:os";
import { TextDecoder } from "node:util";
import { Schema } from "effect";
import {
  ACP_CLIENT_TERMINAL_TOOL_NAMES,
  ACP_CLIENT_TOOL_NAMES,
  AcpClientReadTextFileInput,
  AcpClientTerminalCreateInput,
  AcpClientTerminalKillInput,
  AcpClientTerminalOutputInput,
  AcpClientTerminalReleaseInput,
  AcpClientTerminalWaitForExitInput,
  AcpClientWriteTextFileInput,
} from "@octant/provider-sdk";
import type { CodeThread, WindowId } from "@octant/contracts";
import { SSH_EXECUTOR_MAX_COMMAND_BYTES } from "@octant/contracts/ssh-executor-protocol";
import { classifyPathContainment } from "@octant/domain";
import type { NativeHarnessFileSystemPort } from "../harness/nativeHarnessFileSystem";
import type { NativeHarnessShellPort, NativeHarnessShellRun } from "../harness/nativeHarnessTools";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import {
  isAbsolutePosixPath,
  joinCodePath,
  parentCodePath,
  resolveContainedPath,
} from "./codePathConfinement";
import type { CodeTestSourcePort } from "./codeDirectoryPort";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TERMINALS = 8;
const MAX_TERMINAL_LIFETIME_MS = 10 * 60 * 1000;
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 64;
const MAX_ENVIRONMENT_VALUE_BYTES = 4096;
const ACP_WRITE_SCRIPT = 'cp -- "$1" "$2" && chmod -- "$3" "$2" && mv -f -- "$2" "$4"';

const readDefinition = {
  name: ACP_CLIENT_TOOL_NAMES.readTextFile,
  description: "Read a bounded UTF-8 text file inside the Code checkout.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, line: { type: "integer" }, limit: { type: "integer" } },
    required: ["path"],
  },
} as const;
const writeDefinition = {
  name: ACP_CLIENT_TOOL_NAMES.writeTextFile,
  description: "Write a bounded UTF-8 text file atomically inside the Code checkout.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
} as const;
const terminalDefinitions = [
  {
    name: ACP_CLIENT_TOOL_NAMES.terminalCreate,
    description: "Create a confined process from direct argv or a shell command line.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        env: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, value: { type: "string" } },
            required: ["name", "value"],
          },
        },
        cwd: { type: "string" },
        outputByteLimit: { type: "integer" },
      },
      required: ["command"],
    },
  },
  {
    name: ACP_CLIENT_TOOL_NAMES.terminalOutput,
    description: "Read bounded output from a confined child process.",
    inputSchema: {
      type: "object",
      properties: { terminalId: { type: "string" } },
      required: ["terminalId"],
    },
  },
  {
    name: ACP_CLIENT_TOOL_NAMES.terminalWaitForExit,
    description: "Wait for a confined child process to exit.",
    inputSchema: {
      type: "object",
      properties: { terminalId: { type: "string" } },
      required: ["terminalId"],
    },
  },
  {
    name: ACP_CLIENT_TOOL_NAMES.terminalKill,
    description: "Terminate a confined child process.",
    inputSchema: {
      type: "object",
      properties: { terminalId: { type: "string" } },
      required: ["terminalId"],
    },
  },
  {
    name: ACP_CLIENT_TOOL_NAMES.terminalRelease,
    description: "Terminate and forget a confined child process.",
    inputSchema: {
      type: "object",
      properties: { terminalId: { type: "string" } },
      required: ["terminalId"],
    },
  },
] as const;

export interface CodeAcpTerminalConfinement {
  readonly environment: Readonly<Record<string, string>>;
  readonly prepare: (input: {
    readonly executable: string;
    readonly args: ReadonlyArray<string>;
    readonly boundRoot: string;
    readonly temporaryDirectory: string;
  }) => { readonly command: string; readonly args: ReadonlyArray<string> };
}

export interface CodeAcpClientToolsOptions {
  readonly windowId: WindowId;
  readonly thread: CodeThread;
  readonly readExecutionPolicy: () => CodeThread["executionPolicy"];
  readonly checkoutRoot: string;
  readonly uuid: () => string;
  readonly pathPort: CodeTestSourcePort;
  readonly terminalConfinement: CodeAcpTerminalConfinement;
  readonly wait: (milliseconds: number) => Promise<void>;
}

interface TerminalRecord {
  readonly process: ChildProcess;
  readonly outputLimit: number;
  readonly output: Buffer[];
  outputBytes: number;
  truncated: boolean;
  readonly exited: Promise<{ readonly exitCode?: number; readonly signal?: string }>;
  resolveExit: (value: { readonly exitCode?: number; readonly signal?: string }) => void;
  hardKill: ReturnType<typeof setTimeout>;
  exitedState: boolean;
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function errorResult(error: string) {
  return { result: { error }, isError: true as const };
}

function decodeInput<A>(schema: Schema.Schema<A>) {
  return (value: string): A | undefined => {
    try {
      return Schema.decodeUnknownSync(schema)(JSON.parse(value));
    } catch {
      return undefined;
    }
  };
}

function appendOutput(record: TerminalRecord, chunk: Buffer, limit: number): void {
  if (chunk.length > limit) {
    record.output.length = 0;
    record.output.push(chunk.subarray(chunk.length - limit));
    record.outputBytes = limit;
    record.truncated = true;
    return;
  }
  record.output.push(chunk);
  record.outputBytes += chunk.length;
  while (record.outputBytes > limit) {
    const first = record.output[0];
    if (first === undefined) break;
    const remove = Math.min(first.length, record.outputBytes - limit);
    if (remove === first.length) record.output.shift();
    else record.output[0] = first.subarray(remove);
    record.outputBytes -= remove;
    record.truncated = true;
  }
}

function utf8Boundary(value: Buffer): Buffer {
  let start = 0;
  let leading = 0;
  while (start < value.length && leading < 3 && (value[start] ?? 0) & 0xc0) {
    if (((value[start] ?? 0) & 0xc0) !== 0x80) break;
    start += 1;
    leading += 1;
  }
  let end = value.length;
  for (let offset = 1; offset <= 3 && end - offset >= start; offset += 1) {
    const byte = value[end - offset] ?? 0;
    if ((byte & 0xc0) === 0x80) continue;
    const length =
      (byte & 0x80) === 0
        ? 1
        : (byte & 0xe0) === 0xc0
          ? 2
          : (byte & 0xf0) === 0xe0
            ? 3
            : (byte & 0xf8) === 0xf0
              ? 4
              : 1;
    if (length > offset) end -= offset;
    break;
  }
  return value.subarray(start, end);
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EPERM") child.kill(signal);
    else throw error;
  }
}

function signalName(signal: NodeJS.Signals | null): string | undefined {
  return signal === null ? undefined : signal;
}

function resolveExecutable(command: string, pathValue: string | undefined): string | undefined {
  if (command.startsWith("/")) return command;
  for (const directory of (pathValue ?? "").split(delimiter)) {
    if (!directory.startsWith("/")) continue;
    const candidate = join(directory, command);
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Continue searching the confined base PATH.
    }
  }
  return undefined;
}

export function createCodeAcpClientTools(options: CodeAcpClientToolsOptions): AppManagedToolSet {
  const definitions =
    options.thread.executionPolicy === "plan"
      ? [readDefinition]
      : [readDefinition, writeDefinition, ...terminalDefinitions];
  const terminals = new Map<string, TerminalRecord>();

  const resolveFile = async (path: string) => {
    if (!isAbsolutePosixPath(path)) return undefined;
    const root = await options.pathPort.realpath(options.checkoutRoot).catch(() => undefined);
    if (root === undefined) return undefined;
    return resolveContainedPath(options.pathPort, root, path);
  };

  const read = async (input: AcpClientReadTextFileInput) => {
    if (
      (input.line !== undefined && input.line < 1) ||
      (input.limit !== undefined && input.limit < 1)
    )
      return errorResult("invalid-input");
    const resolved = await resolveFile(input.path);
    if (resolved === undefined) return errorResult("path-outside-checkout");
    if (!resolved.stat.isFile || resolved.stat.size > MAX_FILE_BYTES)
      return errorResult(
        resolved.stat.size > MAX_FILE_BYTES ? "file-oversized" : "file-unreadable",
      );
    const handle = await options.pathPort.openFile(resolved.canonical).catch(() => undefined);
    if (handle === undefined) return errorResult("file-unreadable");
    try {
      const info = await handle.stat();
      if (
        !info.isFile ||
        info.device !== resolved.stat.device ||
        info.inode !== resolved.stat.inode
      )
        return errorResult("file-unreadable");
      if (info.size > MAX_FILE_BYTES) return errorResult("file-oversized");
      const raw = await handle.read(MAX_FILE_BYTES + 1);
      if (raw.length > MAX_FILE_BYTES) return errorResult("file-oversized");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      } catch {
        return errorResult("file-unreadable");
      }
      if (input.line === undefined && input.limit === undefined)
        return { result: { content: text } };
      const start = Math.max(1, input.line ?? 1) - 1;
      const lines = text.split(/\r?\n/);
      return {
        result: {
          content: lines
            .slice(start, input.limit === undefined ? undefined : start + input.limit)
            .join("\n"),
        },
      };
    } catch {
      return errorResult("file-unreadable");
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  const write = async (input: AcpClientWriteTextFileInput) => {
    if (options.readExecutionPolicy() === "plan") return errorResult("read-only-posture");
    if (!isAbsolutePosixPath(input.path)) return errorResult("path-outside-checkout");
    if (bytes(input.content) > MAX_FILE_BYTES) return errorResult("content-oversized");
    const lastSegment = input.path.slice(input.path.lastIndexOf("/") + 1);
    if (lastSegment === "" || lastSegment === "." || lastSegment === "..")
      return errorResult("path-outside-checkout");
    const root = await options.pathPort.realpath(options.checkoutRoot).catch(() => undefined);
    if (root === undefined) return errorResult("path-outside-checkout");
    const parent = await resolveContainedPath(options.pathPort, root, parentCodePath(input.path));
    if (parent === undefined || !parent.stat.isDirectory)
      return errorResult("path-outside-checkout");
    const target = joinCodePath(parent.canonical, basename(input.path));
    const current = await resolveContainedPath(options.pathPort, root, target);
    if (current !== undefined && !current.stat.isFile) return errorResult("path-not-a-file");
    const mode =
      current === undefined
        ? 0o666 & ~process.umask()
        : (await options.pathPort.lstat(current.canonical).catch(() => undefined))?.mode;
    if (mode === undefined) return errorResult("file-unreadable");
    const baseTmpDir = options.terminalConfinement.environment.TMPDIR ?? tmpdir();
    const staging = join(baseTmpDir, `octant-acp-${options.uuid()}.txt`);
    const temporaryInParent = join(parent.canonical, `.octant-${options.uuid()}.tmp`);
    const runConfined = async (
      executable: string,
      args: ReadonlyArray<string>,
    ): Promise<boolean> => {
      try {
        const launch = options.terminalConfinement.prepare({
          executable,
          args,
          boundRoot: root,
          temporaryDirectory: baseTmpDir,
        });
        const child = spawn(launch.command, [...launch.args], {
          stdio: "ignore",
        });
        return await new Promise((resolve) => {
          let settled = false;
          const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            resolve(value);
          };
          child.once("error", () => finish(false));
          child.once("exit", (code) => finish(code === 0));
        });
      } catch {
        return false;
      }
    };
    try {
      await writeFile(staging, input.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      const succeeded = await runConfined("/bin/sh", [
        "-c",
        ACP_WRITE_SCRIPT,
        "octant-acp-write",
        staging,
        temporaryInParent,
        (mode & 0o7777).toString(8),
        target,
      ]);
      if (succeeded) return { result: {} };
      await runConfined("/bin/rm", ["-f", "--", temporaryInParent]);
      return errorResult("file-unreadable");
    } catch {
      await runConfined("/bin/rm", ["-f", "--", temporaryInParent]);
      return errorResult("file-unreadable");
    } finally {
      await unlink(staging).catch(() => undefined);
    }
  };

  const kill = async (terminalId: string, release: boolean) => {
    const record = terminals.get(terminalId);
    if (record === undefined) return errorResult("terminal-unknown");
    if (record.process.exitCode === null && record.process.signalCode === null) {
      signalProcessGroup(record.process, "SIGTERM");
      await options.wait(2_000);
    }
    // The leader may already have exited while a backgrounded grandchild keeps
    // the group alive; ESRCH on an empty group is absorbed by the fallback.
    signalProcessGroup(record.process, "SIGKILL");
    if (release) terminals.delete(terminalId);
    return { result: {} };
  };

  const terminal = async (name: string, inputJson: string, signal?: AbortSignal) => {
    if (name === ACP_CLIENT_TOOL_NAMES.terminalCreate) {
      if (options.readExecutionPolicy() === "plan") return errorResult("read-only-posture");
      const input = decodeInput(AcpClientTerminalCreateInput)(inputJson);
      if (input === undefined) return errorResult("invalid-input");
      if (terminals.size >= MAX_TERMINALS) return errorResult("terminal-limit");
      if (input.cwd !== undefined && !isAbsolutePosixPath(input.cwd))
        return errorResult("cwd-outside-checkout");
      const cwd = input.cwd ?? options.checkoutRoot;
      const root = await options.pathPort.realpath(options.checkoutRoot).catch(() => undefined);
      if (root === undefined) return errorResult("cwd-outside-checkout");
      const resolved = await resolveContainedPath(options.pathPort, root, cwd);
      if (resolved === undefined || !resolved.stat.isDirectory)
        return errorResult("cwd-outside-checkout");
      const env = { ...options.terminalConfinement.environment };
      if (input.env !== undefined) {
        if (input.env.length > MAX_ENVIRONMENT_ENTRIES) return errorResult("invalid-environment");
        for (const entry of input.env) {
          if (
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name) ||
            bytes(entry.value) > MAX_ENVIRONMENT_VALUE_BYTES ||
            entry.name === "TMPDIR" ||
            entry.name === "PATH" ||
            entry.name === "HOME"
          )
            return errorResult("invalid-environment");
          env[entry.name] = entry.value;
        }
      }
      const usesShell = input.args === undefined;
      // ACP agents send the model's shell line as `command` without `args`.
      const executable = usesShell ? "/bin/sh" : resolveExecutable(input.command, env.PATH);
      if (executable === undefined) return errorResult("command-unavailable");
      const outputLimit = Math.min(
        input.outputByteLimit ?? DEFAULT_OUTPUT_BYTES,
        DEFAULT_OUTPUT_BYTES,
      );
      if (outputLimit < 1) return errorResult("invalid-input");
      let child: ChildProcess;
      try {
        const launch = options.terminalConfinement.prepare({
          executable,
          args: usesShell ? ["-c", input.command] : input.args,
          boundRoot: root,
          temporaryDirectory: options.terminalConfinement.environment.TMPDIR ?? "/tmp",
        });
        child = spawn(launch.command, [...launch.args], {
          cwd: resolved.canonical,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
      } catch {
        return errorResult("terminal-unavailable");
      }
      let resolveExit = (_value: { readonly exitCode?: number; readonly signal?: string }) => {};
      const exited = new Promise<{ readonly exitCode?: number; readonly signal?: string }>(
        (resolve) => (resolveExit = resolve),
      );
      const record: TerminalRecord = {
        process: child,
        outputLimit,
        output: [],
        outputBytes: 0,
        truncated: false,
        exited,
        resolveExit,
        hardKill: setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null)
            signalProcessGroup(child, "SIGKILL");
        }, MAX_TERMINAL_LIFETIME_MS),
        exitedState: false,
      };
      child.stdout?.on("data", (chunk: Buffer) => appendOutput(record, chunk, outputLimit));
      child.stderr?.on("data", (chunk: Buffer) => appendOutput(record, chunk, outputLimit));
      const id = options.uuid();
      child.once("error", () => {
        clearTimeout(record.hardKill);
        record.exitedState = true;
        record.resolveExit({});
        terminals.delete(id);
      });
      child.once("exit", (code, signalNameValue) => {
        clearTimeout(record.hardKill);
        record.exitedState = true;
        if (code !== null) {
          record.resolveExit({ exitCode: code });
          return;
        }
        const terminatedBy = signalName(signalNameValue);
        record.resolveExit(terminatedBy === undefined ? {} : { signal: terminatedBy });
      });
      terminals.set(id, record);
      await new Promise((resolve) => setImmediate(resolve));
      if (!terminals.has(id)) return errorResult("terminal-unavailable");
      return { result: { terminalId: id } };
    }
    const schema =
      name === ACP_CLIENT_TOOL_NAMES.terminalOutput
        ? AcpClientTerminalOutputInput
        : name === ACP_CLIENT_TOOL_NAMES.terminalWaitForExit
          ? AcpClientTerminalWaitForExitInput
          : name === ACP_CLIENT_TOOL_NAMES.terminalKill
            ? AcpClientTerminalKillInput
            : AcpClientTerminalReleaseInput;
    const input = decodeInput(schema)(inputJson);
    if (input === undefined) return errorResult("invalid-input");
    const record = terminals.get(input.terminalId);
    if (record === undefined) return errorResult("terminal-unknown");
    if (name === ACP_CLIENT_TOOL_NAMES.terminalOutput) {
      const output = utf8Boundary(Buffer.concat(record.output));
      return {
        result: {
          output: new TextDecoder().decode(output),
          truncated: record.truncated,
          ...(record.exitedState ? { exitStatus: await record.exited } : {}),
        },
      };
    }
    if (name === ACP_CLIENT_TOOL_NAMES.terminalWaitForExit) {
      if (signal?.aborted) {
        await kill(input.terminalId, false);
        return errorResult("tool-interrupted");
      }
      const abort = new Promise<"interrupted">((resolve) =>
        signal?.addEventListener("abort", () => resolve("interrupted"), { once: true }),
      );
      const result = await Promise.race([record.exited, abort]);
      if (result === "interrupted") {
        await kill(input.terminalId, false);
        return errorResult("tool-interrupted");
      }
      return { result };
    }
    return kill(input.terminalId, name === ACP_CLIENT_TOOL_NAMES.terminalRelease);
  };

  return {
    definitions,
    close: async () => {
      await Promise.all([...terminals.keys()].map((id) => kill(id, true)));
      terminals.clear();
    },
    execute: async ({ name, inputJson, signal }) => {
      if (name === ACP_CLIENT_TOOL_NAMES.readTextFile) {
        const input = decodeInput(AcpClientReadTextFileInput)(inputJson);
        return input === undefined ? errorResult("invalid-input") : read(input);
      }
      if (name === ACP_CLIENT_TOOL_NAMES.writeTextFile) {
        const input = decodeInput(AcpClientWriteTextFileInput)(inputJson);
        return input === undefined ? errorResult("invalid-input") : write(input);
      }
      if (ACP_CLIENT_TERMINAL_TOOL_NAMES.includes(name)) return terminal(name, inputJson, signal);
      return errorResult("tool-unavailable");
    },
  };
}

/**
 * The turn's hands on an SSH target, as the remote native harness binds them:
 * each call is admitted in the turn's posture at that call and travels only
 * on the session the turn started on.
 */
export interface RemoteCodeAcpClientToolsOptions {
  /** The bound root (or a managed worktree of it) as the target names it. */
  readonly root: string;
  readonly thread: Pick<CodeThread, "executionPolicy">;
  readonly readExecutionPolicy: () => CodeThread["executionPolicy"];
  readonly filesystem: Pick<NativeHarnessFileSystemPort, "read" | "write">;
  readonly shell: NativeHarnessShellPort;
  readonly uuid: () => string;
}

interface RemoteTerminal {
  readonly stop: AbortController;
  readonly outputLimit: number;
  readonly finished: Promise<NativeHarnessShellRun>;
  ended: NativeHarnessShellRun | undefined;
}

/** A word the target's `/bin/sh` reads back exactly as it was given. */
function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The last `limit` bytes of `text`, cut on a character boundary. */
function tailOf(text: string, limit: number): { readonly text: string; readonly cut: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return { text, cut: false };
  return {
    text: new TextDecoder().decode(utf8Boundary(bytes.subarray(bytes.length - limit))),
    cut: true,
  };
}

function exitStatusOf(run: NativeHarnessShellRun): {
  readonly exitCode?: number;
  readonly signal?: string;
} {
  switch (run.status) {
    case "ran":
      return run.exitCode === undefined ? {} : { exitCode: run.exitCode };
    // The executor kills a command at its bound, and stops a cancelled one.
    case "timed-out":
      return { signal: "SIGKILL" };
    case "cancelled":
      return { signal: "SIGTERM" };
    case "unavailable":
      return {};
  }
}

/**
 * The ACP client file and terminal tools of a Code thread whose Project is
 * bound to a folder on an SSH target. Canonical:
 * docs/design/remote-ssh-environments.md § Runtime placement (R4).
 *
 * The agent runs on the target, and so do its client requests: a file read
 * or write is the remote harness's file tool on the bound root, and a
 * terminal is one harness command through the executor, under the egress the
 * command's posture gets. A write or a terminal in Plan is refused here,
 * before anything is asked of the target.
 *
 * The executor answers a command once it ended, so a terminal's output reads
 * empty, without an exit status, until then; the agent's wait for its exit
 * returns the output with it. A command holds the session's one request
 * while it runs, so the Project's other reads wait for it, as for any
 * harness command on the target.
 */
export function createRemoteCodeAcpClientTools(
  options: RemoteCodeAcpClientToolsOptions,
): AppManagedToolSet {
  const definitions =
    options.thread.executionPolicy === "plan"
      ? [readDefinition]
      : [readDefinition, writeDefinition, ...terminalDefinitions];
  const terminals = new Map<string, RemoteTerminal>();

  const fileRefusal = (reason: string) =>
    errorResult(
      reason === "path-escapes-root"
        ? "path-outside-checkout"
        : reason === "file-too-large"
          ? "file-oversized"
          : reason === "not-a-file"
            ? "path-not-a-file"
            : reason === "target-unavailable"
              ? "target-unavailable"
              : "file-unreadable",
    );

  const read = async (input: AcpClientReadTextFileInput) => {
    if (
      (input.line !== undefined && input.line < 1) ||
      (input.limit !== undefined && input.limit < 1)
    )
      return errorResult("invalid-input");
    if (!isAbsolutePosixPath(input.path)) return errorResult("path-outside-checkout");
    // The harness read returns a bounded run of lines; a whole file is read
    // run after run, up to the same bound a local read has.
    const lines: string[] = [];
    let bytesRead = 0;
    let offset = (input.line ?? 1) - 1;
    for (;;) {
      const wanted = input.limit === undefined ? undefined : input.limit - lines.length;
      const result = await options.filesystem.read({
        path: input.path,
        offset,
        ...(wanted === undefined ? {} : { limit: wanted }),
      });
      if (result.kind === "refused") return fileRefusal(result.reason);
      if (result.kind !== "file") return errorResult("file-unreadable");
      for (const line of result.lines) {
        bytesRead += bytes(line) + 1;
        if (bytesRead > MAX_FILE_BYTES + 1) return errorResult("file-oversized");
        lines.push(line);
      }
      const done =
        result.nextLine === undefined ||
        result.nextLine <= offset ||
        (input.limit !== undefined && lines.length >= input.limit);
      if (done) break;
      offset = result.nextLine;
    }
    return { result: { content: lines.join("\n") } };
  };

  const write = async (input: AcpClientWriteTextFileInput) => {
    if (options.readExecutionPolicy() === "plan") return errorResult("read-only-posture");
    if (!isAbsolutePosixPath(input.path)) return errorResult("path-outside-checkout");
    if (bytes(input.content) > MAX_FILE_BYTES) return errorResult("content-oversized");
    const result = await options.filesystem.write({ path: input.path, content: input.content });
    return result.kind === "written" ? { result: {} } : fileRefusal(result.reason);
  };

  const create = (input: AcpClientTerminalCreateInput) => {
    if (terminals.size >= MAX_TERMINALS) return errorResult("terminal-limit");
    const cwd = posix.normalize(input.cwd ?? options.root);
    if (!isAbsolutePosixPath(cwd) || classifyPathContainment(options.root, cwd) !== "contained")
      return errorResult("cwd-outside-checkout");
    const exports: string[] = [];
    if (input.env !== undefined) {
      if (input.env.length > MAX_ENVIRONMENT_ENTRIES) return errorResult("invalid-environment");
      for (const entry of input.env) {
        // A placed command's proxy variables carry its launch's egress
        // token, so the agent may not point them elsewhere.
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name) ||
          bytes(entry.value) > MAX_ENVIRONMENT_VALUE_BYTES ||
          entry.name === "TMPDIR" ||
          entry.name === "PATH" ||
          entry.name === "HOME" ||
          entry.name.toUpperCase().includes("PROXY")
        )
          return errorResult("invalid-environment");
        exports.push(`export ${entry.name}=${shellWord(entry.value)}`);
      }
    }
    const outputLimit = Math.min(
      input.outputByteLimit ?? DEFAULT_OUTPUT_BYTES,
      DEFAULT_OUTPUT_BYTES,
    );
    if (outputLimit < 1) return errorResult("invalid-input");
    // ACP agents send the model's shell line as `command` without `args`;
    // with `args` the words are passed exactly, as an argv is locally.
    const run =
      input.args === undefined
        ? input.command
        : `exec ${[input.command, ...input.args].map(shellWord).join(" ")}`;
    const script = [`cd -- ${shellWord(cwd)} || exit 126`, ...exports, run].join("\n");
    if (bytes(script) > SSH_EXECUTOR_MAX_COMMAND_BYTES) return errorResult("invalid-input");
    const stop = new AbortController();
    const terminal: RemoteTerminal = {
      stop,
      outputLimit,
      ended: undefined,
      finished: options.shell
        .run({
          command: script,
          cwd: options.root,
          timeoutMs: MAX_TERMINAL_LIFETIME_MS,
          signal: stop.signal,
        })
        .catch(
          (): NativeHarnessShellRun => ({ status: "unavailable", output: "", truncated: false }),
        )
        .then((ended) => {
          terminal.ended = ended;
          return ended;
        }),
    };
    const id = options.uuid();
    terminals.set(id, terminal);
    return { result: { terminalId: id } };
  };

  const ended = (terminal: RemoteTerminal, run: NativeHarnessShellRun) => {
    const output = tailOf(run.output, terminal.outputLimit);
    return {
      output: output.text,
      truncated: output.cut || run.truncated,
      exitStatus: exitStatusOf(run),
    };
  };

  const kill = async (terminalId: string, release: boolean) => {
    const terminal = terminals.get(terminalId);
    if (terminal === undefined) return errorResult("terminal-unknown");
    terminal.stop.abort();
    await terminal.finished;
    if (release) terminals.delete(terminalId);
    return { result: {} };
  };

  const terminal = async (name: string, inputJson: string, signal?: AbortSignal) => {
    if (name === ACP_CLIENT_TOOL_NAMES.terminalCreate) {
      if (options.readExecutionPolicy() === "plan") return errorResult("read-only-posture");
      const input = decodeInput(AcpClientTerminalCreateInput)(inputJson);
      return input === undefined ? errorResult("invalid-input") : create(input);
    }
    const schema =
      name === ACP_CLIENT_TOOL_NAMES.terminalOutput
        ? AcpClientTerminalOutputInput
        : name === ACP_CLIENT_TOOL_NAMES.terminalWaitForExit
          ? AcpClientTerminalWaitForExitInput
          : name === ACP_CLIENT_TOOL_NAMES.terminalKill
            ? AcpClientTerminalKillInput
            : AcpClientTerminalReleaseInput;
    const input = decodeInput(schema)(inputJson);
    if (input === undefined) return errorResult("invalid-input");
    const record = terminals.get(input.terminalId);
    if (record === undefined) return errorResult("terminal-unknown");
    if (name === ACP_CLIENT_TOOL_NAMES.terminalOutput) {
      return {
        result:
          record.ended === undefined
            ? { output: "", truncated: false }
            : ended(record, record.ended),
      };
    }
    if (name === ACP_CLIENT_TOOL_NAMES.terminalWaitForExit) {
      if (signal?.aborted) {
        await kill(input.terminalId, false);
        return errorResult("tool-interrupted");
      }
      const abort = new Promise<"interrupted">((resolve) =>
        signal?.addEventListener("abort", () => resolve("interrupted"), { once: true }),
      );
      const result = await Promise.race([record.finished, abort]);
      if (result === "interrupted") {
        await kill(input.terminalId, false);
        return errorResult("tool-interrupted");
      }
      return { result: exitStatusOf(result) };
    }
    return kill(input.terminalId, name === ACP_CLIENT_TOOL_NAMES.terminalRelease);
  };

  return {
    definitions,
    close: async () => {
      await Promise.all([...terminals.keys()].map((id) => kill(id, true)));
      terminals.clear();
    },
    execute: async ({ name, inputJson, signal }) => {
      if (name === ACP_CLIENT_TOOL_NAMES.readTextFile) {
        const input = decodeInput(AcpClientReadTextFileInput)(inputJson);
        return input === undefined ? errorResult("invalid-input") : read(input);
      }
      if (name === ACP_CLIENT_TOOL_NAMES.writeTextFile) {
        const input = decodeInput(AcpClientWriteTextFileInput)(inputJson);
        return input === undefined ? errorResult("invalid-input") : write(input);
      }
      if (ACP_CLIENT_TERMINAL_TOOL_NAMES.includes(name)) return terminal(name, inputJson, signal);
      return errorResult("tool-unavailable");
    },
  };
}
