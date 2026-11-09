import {
  MAX_NATIVE_HARNESS_COMMAND_TIMEOUT_MS,
  type NativeHarnessDiagnosticsArguments,
} from "@octant/contracts";
import type { NativeHarnessFileSystemPort } from "./nativeHarnessFileSystem";
import { admitNativeHarnessTool } from "./nativeHarnessToolAdmission";
import type { CreateNativeHarnessToolsOptions } from "./nativeHarnessTools";

/** A typecheck can take as long as a test suite; it gets the longest a command may run. */
const DIAGNOSTICS_TIMEOUT_MS = MAX_NATIVE_HARNESS_COMMAND_TIMEOUT_MS;
export const MAX_DIAGNOSTICS_PROBLEMS = 100;
const MAX_PROBLEM_MESSAGE_LENGTH = 1_000;
const MAX_OUTPUT_TAIL_BYTES = 4 * 1024;

export type DiagnosticsCheck = "typecheck" | "lint" | "check" | "both";

export interface NativeHarnessDiagnostic {
  /** The workspace package a runner said the problem came from; `file` is relative to it. */
  readonly package?: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly code?: string;
}

interface DiagnosticsCommand {
  readonly check: DiagnosticsCheck;
  readonly command: string;
}

type Discovery =
  | {
      readonly status: "found";
      readonly commands: ReadonlyArray<DiagnosticsCommand>;
      readonly notFound: ReadonlyArray<"typecheck" | "lint">;
    }
  | { readonly status: "none" };

/**
 * The lockfiles that name a package manager, in the order they win when a
 * checkout holds more than one. No lockfile runs the scripts with npm.
 */
const RUNNERS: ReadonlyArray<readonly [lockfile: string, runner: string]> = [
  ["bun.lock", "bun run"],
  ["bun.lockb", "bun run"],
  ["pnpm-lock.yaml", "pnpm run"],
  ["yarn.lock", "yarn run"],
  ["package-lock.json", "npm run"],
];

/**
 * The checkout's own typecheck and lint commands, read from the `scripts` of
 * the package.json at the checkout's root: `typecheck` and `lint` by name, and
 * `check` only when neither requested script exists. Nothing else is guessed,
 * so a checkout without them gets a refusal that asks for the command.
 */
export async function discoverDiagnosticsCommands(
  filesystem: Pick<NativeHarnessFileSystemPort, "read">,
  which: "typecheck" | "lint" | "both",
): Promise<Discovery> {
  // Discovery's own look is not the model's read: it must not let an edit
  // change package.json the model never read.
  const manifest = await filesystem.read({ path: "package.json", marksRead: false });
  if (manifest.kind !== "file" || manifest.bounds.truncated) return { status: "none" };
  let scripts: Readonly<Record<string, unknown>>;
  try {
    const parsed: unknown = JSON.parse(manifest.lines.join("\n"));
    const candidate =
      typeof parsed === "object" && parsed !== null && "scripts" in parsed
        ? parsed.scripts
        : undefined;
    if (typeof candidate !== "object" || candidate === null) return { status: "none" };
    scripts = candidate as Readonly<Record<string, unknown>>;
  } catch {
    return { status: "none" };
  }
  const has = (name: string) => {
    const script = Object.hasOwn(scripts, name) ? scripts[name] : undefined;
    return typeof script === "string" && script.trim().length > 0;
  };
  const listing = await filesystem.read({ path: "." });
  const names = new Set(
    listing.kind === "directory" ? listing.entries.map((entry) => entry.name) : [],
  );
  const runner = RUNNERS.find(([lockfile]) => names.has(lockfile))?.[1] ?? "npm run";
  const requested: ReadonlyArray<"typecheck" | "lint"> =
    which === "both" ? ["typecheck", "lint"] : [which];
  const present = requested.filter(has);
  if (present.length > 0) {
    return {
      status: "found",
      commands: present.map((check) => ({ check, command: `${runner} ${check}` })),
      notFound: requested.filter((check) => !has(check)),
    };
  }
  if (has("check")) {
    return {
      status: "found",
      commands: [{ check: "check", command: `${runner} check` }],
      notFound: [],
    };
  }
  return { status: "none" };
}

// Color codes a tool prints even without a terminal would hide every location.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
// A workspace runner names the package a line came from before the line
// itself: turbo as `package:task: `, pnpm's recursive runs as `dir script: `.
// The task must start with a letter, so `file:3:7: message` is never a prefix.
const TURBO_PREFIX = /^([^\s:]+):([A-Za-z][\w:-]*):(?: (.*))?$/;
const PNPM_PREFIX = /^([^\s:]+) ([A-Za-z][\w:-]*): (.*)$/;
// Paths are matched from the start of the line, so one that holds spaces
// stays whole.
const TSC = /^\s*(.+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.+)$/;
const TSC_PRETTY = /^\s*(.+?):(\d+):(\d+) - (error|warning|message)(?: (TS\d+))?: (.+)$/;
const UNIX = /^\s*(.+?):(\d+):(\d+): (.+)$/;
const UNIX_SEVERITY = /^(error|warning|warn|info|note)\b:?\s*(.+)$/i;
const UNIX_TRAILER = /\s*\[(?:(error|warning|info)\/)?([^\]\s]+)\]$/i;
const BIOME_HEADER = /^\s*(.+?):(\d+):(\d+) ([a-z]+\/\S+)/;
const BIOME_MESSAGE = /^\s*([✖×!⚠ℹ])\s+(.+)$/;
const STYLISH_FILE = /^(\/.*\.[A-Za-z0-9]+|[^\s:]+\.[A-Za-z0-9]+)$/;
const STYLISH_ROW = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?$/;

/**
 * Problems read from a typecheck or lint command's output. It recognizes
 * tsc's two formats, the `file:line:col: message` lines the unix and gnu
 * reporters print (ESLint, oxlint), Biome's diagnostic headers, and ESLint's
 * default per-file listing, each with or without a workspace runner's
 * package prefix. A line it does not recognize is skipped, never guessed at;
 * the caller keeps the raw output for that case.
 */
export function parseDiagnostics(
  output: string,
  root: string,
): ReadonlyArray<NativeHarnessDiagnostic> {
  const problems: NativeHarnessDiagnostic[] = [];
  const seen = new Set<string>();
  // Two packages can report the same package-relative file and line; each
  // is its own problem.
  const add = (problem: NativeHarnessDiagnostic) => {
    const key = JSON.stringify([
      problem.package ?? "",
      problem.file,
      problem.line,
      problem.column,
      problem.message,
    ]);
    if (seen.has(key)) return;
    seen.add(key);
    problems.push(problem);
  };
  const at = (pkg: string | undefined, file: string, line: string, column: string) => ({
    ...(pkg === undefined ? {} : { package: pkg }),
    file: relativeTo(root, file),
    line: Number(line),
    column: Number(column),
  });
  let stylish: { readonly pkg: string | undefined; readonly file: string } | undefined;
  let biome:
    | {
        readonly pkg: string | undefined;
        readonly file: string;
        readonly line: string;
        readonly column: string;
        readonly code: string;
      }
    | undefined;
  const flushBiome = () => {
    if (biome === undefined) return;
    add({
      ...at(biome.pkg, biome.file, biome.line, biome.column),
      severity: "error",
      message: biome.code,
      code: biome.code,
    });
    biome = undefined;
  };
  for (const raw of output.replace(ANSI, "").split(/\r?\n/)) {
    const { pkg, line } = withoutRunnerPrefix(raw.trimEnd());
    if (biome !== undefined) {
      const message = BIOME_MESSAGE.exec(line);
      if (message !== null) {
        const [, mark = "", text = ""] = message;
        add({
          ...at(biome.pkg, biome.file, biome.line, biome.column),
          severity: mark === "ℹ" ? "info" : mark === "!" || mark === "⚠" ? "warning" : "error",
          message: clip(text),
          code: biome.code,
        });
        biome = undefined;
        continue;
      }
    }
    const tsc = TSC.exec(line) ?? TSC_PRETTY.exec(line);
    if (tsc !== null && isPath(tsc[1])) {
      flushBiome();
      const [, file = "", row = "", column = "", severity = "", code, message = ""] = tsc;
      add({
        ...at(pkg, file, row, column),
        severity: severity === "message" ? "info" : severity === "warning" ? "warning" : "error",
        message: clip(message),
        ...(code === undefined ? {} : { code }),
      });
      continue;
    }
    const unix = UNIX.exec(line);
    if (unix !== null && isPath(unix[1])) {
      flushBiome();
      const [, file = "", row = "", column = "", rest = ""] = unix;
      let message = rest;
      let severity: NativeHarnessDiagnostic["severity"] = "error";
      let code: string | undefined;
      const trailer = UNIX_TRAILER.exec(message);
      if (trailer !== null) {
        message = message.slice(0, trailer.index);
        code = trailer[2];
        if (trailer[1] !== undefined) severity = severityOf(trailer[1]);
      }
      const leading = UNIX_SEVERITY.exec(message);
      if (leading !== null) {
        severity = severityOf(leading[1] ?? "");
        message = leading[2] ?? message;
      }
      add({
        ...at(pkg, file, row, column),
        severity,
        message: clip(message),
        ...(code === undefined ? {} : { code }),
      });
      continue;
    }
    const header = BIOME_HEADER.exec(line);
    if (header !== null && isPath(header[1])) {
      flushBiome();
      const [, file = "", row = "", column = "", code = ""] = header;
      biome = { pkg, file, line: row, column, code };
      continue;
    }
    const row = STYLISH_ROW.exec(line);
    if (row !== null && stylish !== undefined) {
      const [, lineNumber = "", column = "", severity = "", message = "", code] = row;
      add({
        ...at(stylish.pkg, stylish.file, lineNumber, column),
        severity: severity === "warning" ? "warning" : "error",
        message: clip(message),
        ...(code === undefined ? {} : { code }),
      });
      continue;
    }
    const file = STYLISH_FILE.exec(line);
    if (file !== null && isPath(file[1])) stylish = { pkg, file: file[1] };
  }
  flushBiome();
  return problems;
}

function withoutRunnerPrefix(line: string): {
  readonly pkg: string | undefined;
  readonly line: string;
} {
  const prefixed = TURBO_PREFIX.exec(line) ?? PNPM_PREFIX.exec(line);
  return prefixed === null
    ? { pkg: undefined, line }
    : { pkg: prefixed[1], line: prefixed[3] ?? "" };
}

/** Whether a problem's file is one of the files the call asked about, or inside a folder it named. */
export function matchesDiagnosticsFile(file: string, filters: ReadonlyArray<string>): boolean {
  const problem = normalized(file);
  return filters.some((filter) => {
    const wanted = normalized(filter);
    return (
      problem === wanted ||
      problem.endsWith(`/${wanted}`) ||
      wanted.endsWith(`/${problem}`) ||
      problem.startsWith(`${wanted}/`)
    );
  });
}

interface DiagnosticsRun {
  readonly check: DiagnosticsCheck;
  readonly command: string;
  readonly status: "ran" | "timed-out" | "refused";
  readonly exitCode?: number;
  readonly problemsFound?: number;
  readonly outputTail?: string;
  /** The shell kept only part of what the command printed, so problems may be missing. */
  readonly outputTruncated?: true;
  readonly error?: string;
  readonly message?: string;
}

type ToolOutcome = {
  readonly result: unknown;
  readonly isError?: boolean;
  readonly refused?: boolean;
};

/**
 * Runs each typecheck or lint command as the `bash` call it is: authorized
 * under the shell's own catalog entry and approval, and run on the same shell
 * port with the same confinement and egress. A refused command reports why;
 * the commands that did run still report what they found.
 */
export async function runNativeHarnessDiagnostics(
  args: NativeHarnessDiagnosticsArguments,
  options: CreateNativeHarnessToolsOptions,
  signal: AbortSignal | undefined,
): Promise<ToolOutcome> {
  const { shell, filesystem } = options.ports;
  if (shell === undefined || filesystem === undefined) return refused("tool-unavailable");
  const which = args.which ?? "both";
  let commands: ReadonlyArray<DiagnosticsCommand>;
  let notFound: ReadonlyArray<"typecheck" | "lint"> = [];
  if (args.command !== undefined) {
    commands = [{ check: which, command: args.command }];
  } else {
    const discovered = await discoverDiagnosticsCommands(filesystem, which);
    if (discovered.status === "none") {
      return refused(
        "no-diagnostics-command",
        `No ${which === "both" ? "typecheck, lint, or check" : `${which} or check`} script was found in the checkout's package.json. Pass the command to run as command, for example the project's own typecheck or lint invocation.`,
      );
    }
    commands = discovered.commands;
    notFound = discovered.notFound;
  }
  const runs: DiagnosticsRun[] = [];
  const problems: NativeHarnessDiagnostic[] = [];
  for (const { check, command } of commands) {
    if (signal?.aborted) return refused("tool-interrupted");
    const admission = await admitNativeHarnessTool(options, {
      name: "bash",
      args: { command },
      intent: `bash: ${command}`.slice(0, 2_048),
      ...(signal === undefined ? {} : { signal }),
    });
    if (admission.status === "refused") {
      runs.push({ check, command, status: "refused", ...admission.outcome.result });
      continue;
    }
    const callId = String(admission.request.actionId);
    let run;
    try {
      run = await shell.run({
        command,
        cwd: filesystem.root,
        ...(filesystem.extraRoots === undefined || filesystem.extraRoots.length === 0
          ? {}
          : { extraRoots: filesystem.extraRoots }),
        timeoutMs: DIAGNOSTICS_TIMEOUT_MS,
        callId,
        ...(signal === undefined ? {} : { signal }),
      });
    } finally {
      options.ports.callEnded?.(callId);
    }
    if (run.status === "cancelled") return refused("tool-interrupted");
    if (run.status === "unavailable") {
      runs.push({
        check,
        command,
        status: "refused",
        error: run.refusal?.reason ?? "shell-unavailable",
        ...(run.refusal === undefined ? {} : { message: run.refusal.message }),
      });
      continue;
    }
    const found = parseDiagnostics(run.output, filesystem.root);
    problems.push(...found);
    runs.push({
      check,
      command,
      status: run.status,
      ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
      problemsFound: found.length,
      ...(run.truncated ? { outputTruncated: true } : {}),
      ...(found.length === 0 && run.output.trim().length > 0
        ? { outputTail: tail(run.output.replace(ANSI, ""), MAX_OUTPUT_TAIL_BYTES) }
        : {}),
    });
  }
  const first = runs[0];
  if (runs.every((run) => run.status === "refused") && first !== undefined) {
    return refused(first.error ?? "tool-unavailable", first.message);
  }
  const wanted = args.files;
  const shown =
    wanted === undefined || wanted.length === 0
      ? problems
      : problems.filter((problem) => matchesDiagnosticsFile(problem.file, wanted));
  // Clean means every command that ran exited zero and printed no problem it
  // could read in output the shell kept whole; a failing exit with nothing
  // parsed, or output the shell cut, is reported, never clean.
  const clean = runs.every(
    (run) =>
      run.status === "ran" &&
      run.exitCode === 0 &&
      run.problemsFound === 0 &&
      run.outputTruncated !== true,
  );
  const notes = [
    ...runs.flatMap((run) =>
      run.outputTruncated === true
        ? [
            `${run.command}'s output was cut at the shell's limit, so problems may be missing; this is not a complete or clean result. Narrow the command to fewer files.`,
          ]
        : [],
    ),
    ...runs.flatMap((run) =>
      run.status === "refused"
        ? [`${run.command} did not run: ${run.message ?? run.error ?? "refused"}.`]
        : run.status === "timed-out"
          ? [`${run.command} timed out, so its problems may be incomplete.`]
          : run.exitCode !== 0 && run.problemsFound === 0
            ? [
                `${run.command} exited ${run.exitCode ?? "without a code"} but no problem could be read from its output; this is not a clean result. Read its outputTail.`,
              ]
            : [],
    ),
    ...notFound.map((check) => `No ${check} script was found, so no ${check} ran.`),
  ];
  return {
    result: {
      clean,
      runs,
      problems: shown.slice(0, MAX_DIAGNOSTICS_PROBLEMS),
      totalProblems: shown.length,
      ...(wanted === undefined || wanted.length === 0
        ? {}
        : { outsideFiles: problems.length - shown.length }),
      ...(shown.length > MAX_DIAGNOSTICS_PROBLEMS
        ? {
            truncated: `Showing ${MAX_DIAGNOSTICS_PROBLEMS} of ${shown.length} problems; ${shown.length - MAX_DIAGNOSTICS_PROBLEMS} were left out. Fix these, or pass files to narrow the list.`,
          }
        : {}),
      ...(notes.length === 0 ? {} : { notes }),
    },
    isError: runs.some(
      (run) =>
        run.status === "timed-out" ||
        run.status === "refused" ||
        (run.exitCode !== undefined && run.exitCode !== 0),
    ),
  };
}

function isPath(candidate: string | undefined): candidate is string {
  return candidate !== undefined && /[./]/.test(candidate) && !/^\d+(\.\d+)*$/.test(candidate);
}

function relativeTo(root: string, file: string): string {
  const prefix = `${root.replace(/\/+$/, "")}/`;
  return normalized(file.startsWith(prefix) ? file.slice(prefix.length) : file);
}

function normalized(path: string): string {
  return path.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

function severityOf(word: string): NativeHarnessDiagnostic["severity"] {
  const lower = word.toLowerCase();
  return lower === "warning" || lower === "warn"
    ? "warning"
    : lower === "info" || lower === "note"
      ? "info"
      : "error";
}

function clip(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > MAX_PROBLEM_MESSAGE_LENGTH
    ? `${trimmed.slice(0, MAX_PROBLEM_MESSAGE_LENGTH - 1)}…`
    : trimmed;
}

function tail(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;
  return `…${buffer.subarray(buffer.byteLength - maxBytes).toString("utf8")}`;
}

function refused(error: string, message?: string): ToolOutcome {
  return {
    result: { error, ...(message === undefined ? {} : { message }) },
    isError: true,
    refused: true,
  };
}
