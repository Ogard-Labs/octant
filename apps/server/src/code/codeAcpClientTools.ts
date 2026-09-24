import { rename, unlink, writeFile } from "node:fs/promises";
import { accessSync, constants, statSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { delimiter, join } from "node:path";
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
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { isAbsolutePosixPath, parentCodePath, resolveContainedPath } from "./codePathConfinement";
import type { CodeTestSourcePort } from "./codeDirectoryPort";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TERMINALS = 8;
const MAX_TERMINAL_LIFETIME_MS = 10 * 60 * 1000;
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 64;
const MAX_ENVIRONMENT_VALUE_BYTES = 4096;

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
    description: "Create a confined direct child process.",
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
    readonly environment: Readonly<Record<string, string>>;
  }) => { readonly command: string; readonly args: ReadonlyArray<string> };
}

export interface CodeAcpClientToolsOptions {
  readonly windowId: WindowId;
  readonly thread: CodeThread;
  readonly checkoutRoot: string;
  readonly uuid: () => string;
  readonly pathPort: CodeTestSourcePort;
  readonly terminalConfinement: CodeAcpTerminalConfinement;
  readonly clock: () => string;
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
  if (chunk.length >= limit) {
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
  let end = value.length;
  while (start < end) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(value.subarray(start, end));
      break;
    } catch {
      start += 1;
    }
  }
  while (end > start) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(value.subarray(start, end));
      break;
    } catch {
      end -= 1;
    }
  }
  return value.subarray(start, end);
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
    const source = options.pathPort as CodeTestSourcePort;
    const handle = await source.openFile(resolved.canonical).catch(() => undefined);
    if (handle === undefined) return errorResult("file-unreadable");
    try {
      const info = await handle.stat();
      if (!info.isFile || info.size > MAX_FILE_BYTES) return errorResult("file-oversized");
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
    if (options.thread.executionPolicy === "plan") return errorResult("read-only-posture");
    if (!isAbsolutePosixPath(input.path)) return errorResult("path-outside-checkout");
    if (bytes(input.content) > MAX_FILE_BYTES) return errorResult("content-oversized");
    const root = await options.pathPort.realpath(options.checkoutRoot).catch(() => undefined);
    if (root === undefined) return errorResult("path-outside-checkout");
    const current = await resolveContainedPath(options.pathPort, root, input.path);
    const parent = await resolveContainedPath(options.pathPort, root, parentCodePath(input.path));
    if (parent === undefined || !parent.stat.isDirectory)
      return errorResult("path-outside-checkout");
    if (current !== undefined && !current.stat.isFile) return errorResult("file-unreadable");
    const temporary = `${input.path}.octant-${options.uuid()}.tmp`;
    try {
      await writeFile(temporary, input.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, input.path);
      return { result: {} };
    } catch {
      await unlink(temporary).catch(() => undefined);
      return errorResult("file-unreadable");
    }
  };

  const kill = async (terminalId: string, release: boolean) => {
    const record = terminals.get(terminalId);
    if (record === undefined) return errorResult("terminal-unknown");
    if (record.process.exitCode === null && record.process.signalCode === null) {
      record.process.kill("SIGTERM");
      await options.wait(2_000);
      if (record.process.exitCode === null && record.process.signalCode === null)
        record.process.kill("SIGKILL");
    }
    if (release) terminals.delete(terminalId);
    return { result: {} };
  };

  const terminal = async (name: string, inputJson: string, signal?: AbortSignal) => {
    if (name === ACP_CLIENT_TOOL_NAMES.terminalCreate) {
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
            bytes(entry.value) > MAX_ENVIRONMENT_VALUE_BYTES
          )
            return errorResult("invalid-environment");
          env[entry.name] = entry.value;
        }
      }
      const executable = resolveExecutable(input.command, env.PATH);
      if (executable === undefined) return errorResult("command-unavailable");
      let child: ChildProcess;
      try {
        const launch = options.terminalConfinement.prepare({
          executable,
          args: input.args ?? [],
          boundRoot: root,
          temporaryDirectory: env.TMPDIR ?? "/tmp",
          environment: env,
        });
        child = spawn(launch.command, [...launch.args], {
          cwd: resolved.canonical,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        return errorResult("terminal-unavailable");
      }
      const outputLimit = Math.min(
        input.outputByteLimit ?? DEFAULT_OUTPUT_BYTES,
        DEFAULT_OUTPUT_BYTES,
      );
      if (outputLimit < 1) return errorResult("invalid-input");
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
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, MAX_TERMINAL_LIFETIME_MS),
      };
      child.stdout?.on("data", (chunk: Buffer) => appendOutput(record, chunk, outputLimit));
      child.stderr?.on("data", (chunk: Buffer) => appendOutput(record, chunk, outputLimit));
      child.once("close", (code, signalNameValue) => {
        clearTimeout(record.hardKill);
        if (code !== null) {
          record.resolveExit({ exitCode: code });
          return;
        }
        const terminatedBy = signalName(signalNameValue);
        record.resolveExit(terminatedBy === undefined ? {} : { signal: terminatedBy });
      });
      const id = options.uuid();
      terminals.set(id, record);
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
          output: output.toString("utf8"),
          truncated: record.truncated,
          ...(record.process.exitCode !== null || record.process.signalCode !== null
            ? { exitStatus: await record.exited }
            : {}),
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
