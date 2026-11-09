import {
  MAX_NATIVE_HARNESS_COMMAND_TIMEOUT_MS,
  type NativeHarnessDiagnosticsArguments,
} from "@octant/contracts";
import { posix } from "node:path";
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
  /** The workspace package a runner said the problem came from. */
  readonly package?: string;
  /**
   * Set when `file` is still relative to `package` because Octant could not
   * find that package's folder in the checkout; a `files` filter then
   * matches it only exactly.
   */
  readonly packageRelative?: true;
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
    ...reportedPath(file, pkg, root),
    line: Number(line),
    column: Number(column),
  });
  interface PendingBiome {
    readonly file: string;
    readonly line: string;
    readonly column: string;
    readonly code: string;
  }
  // A runner interleaves its packages' lines, so the file an ESLint listing
  // is under and a Biome header waiting for its message belong to the
  // package whose prefix printed them.
  const stylishFiles = new Map<string, string>();
  const pendingBiome = new Map<string, PendingBiome>();
  const keyOf = (pkg: string | undefined) => (pkg === undefined ? "" : `@${pkg}`);
  const pkgOf = (key: string) => (key === "" ? undefined : key.slice(1));
  const flushBiome = (key: string) => {
    const biome = pendingBiome.get(key);
    if (biome === undefined) return;
    pendingBiome.delete(key);
    add({
      ...at(pkgOf(key), biome.file, biome.line, biome.column),
      severity: "error",
      message: biome.code,
      code: biome.code,
    });
  };
  for (const raw of output.replace(ANSI, "").split(/\r?\n/)) {
    const { pkg, line } = withoutRunnerPrefix(raw.trimEnd());
    const key = keyOf(pkg);
    const biome = pendingBiome.get(key);
    if (biome !== undefined) {
      const message = BIOME_MESSAGE.exec(line);
      if (message !== null) {
        const [, mark = "", text = ""] = message;
        pendingBiome.delete(key);
        add({
          ...at(pkg, biome.file, biome.line, biome.column),
          severity: mark === "ℹ" ? "info" : mark === "!" || mark === "⚠" ? "warning" : "error",
          message: clip(text),
          code: biome.code,
        });
        continue;
      }
    }
    const tsc = TSC.exec(line) ?? TSC_PRETTY.exec(line);
    if (tsc !== null && isPath(tsc[1])) {
      flushBiome(key);
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
      flushBiome(key);
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
      flushBiome(key);
      const [, file = "", row = "", column = "", code = ""] = header;
      pendingBiome.set(key, { file, line: row, column, code });
      continue;
    }
    const row = STYLISH_ROW.exec(line);
    const stylishFile = stylishFiles.get(key);
    if (row !== null && stylishFile !== undefined) {
      const [, lineNumber = "", column = "", severity = "", message = "", code] = row;
      add({
        ...at(pkg, stylishFile, lineNumber, column),
        severity: severity === "warning" ? "warning" : "error",
        message: clip(message),
        ...(code === undefined ? {} : { code }),
      });
      continue;
    }
    const file = STYLISH_FILE.exec(line);
    if (file !== null && isPath(file[1])) stylishFiles.set(key, file[1]);
  }
  for (const key of pendingBiome.keys()) flushBiome(key);
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

/**
 * Whether a problem's file is one of the files the call asked about, or inside
 * a folder it named; `.` or the checkout's own path names the whole checkout.
 * Paths and filters are compared in one spelling (`./a//b/` is `a/b`, an
 * absolute path inside the checkout is made relative). A path outside the
 * checkout matches only a filter written exactly the same. A path still
 * relative to a package Octant could not place matches only a filter that
 * names it exactly, or the whole checkout, since a suffix would match the same
 * path in every package.
 */
export function matchesDiagnosticsFile(
  problem: Pick<NativeHarnessDiagnostic, "file" | "packageRelative">,
  filters: ReadonlyArray<string>,
  root: string,
): boolean {
  const file: CheckoutPath =
    problem.packageRelative === true
      ? problem.file === ".." || problem.file.startsWith("../")
        ? { kind: "outside" }
        : { kind: "inside", path: problem.file }
      : checkoutPath(problem.file, root);
  return filters.some((filter) => {
    const wanted = checkoutPath(filter, root);
    if (wanted.kind === "outside" || file.kind === "outside") return problem.file === filter;
    if (wanted.path === "") return true;
    if (problem.packageRelative === true) return file.path === wanted.path;
    return (
      file.path === wanted.path ||
      file.path.endsWith(`/${wanted.path}`) ||
      file.path.startsWith(`${wanted.path}/`)
    );
  });
}

type CheckoutPath =
  /** `path` is relative to the checkout in one spelling; `""` is the checkout itself. */
  { readonly kind: "inside"; readonly path: string } | { readonly kind: "outside" };

/**
 * Where a path is in the checkout. A relative path is taken from the
 * checkout root; an absolute one is inside only under `root`. Anything that
 * normalizes above the checkout, or an absolute path elsewhere, is outside.
 */
function checkoutPath(path: string, root: string): CheckoutPath {
  const base = posix.normalize(root).replace(/\/+$/, "");
  let clean = posix.normalize(path.trim());
  if (posix.isAbsolute(clean)) {
    if (clean.replace(/\/+$/, "") === base) return { kind: "inside", path: "" };
    if (!clean.startsWith(`${base}/`)) return { kind: "outside" };
    clean = clean.slice(base.length + 1);
  }
  clean = clean.replace(/\/+$/, "");
  if (clean === "." || clean === "") return { kind: "inside", path: "" };
  if (clean === ".." || clean.startsWith("../")) return { kind: "outside" };
  return { kind: "inside", path: clean };
}

/**
 * A reported path as a problem keeps it. Under a runner's package prefix only
 * a relative path is the package's own and waits to be placed; an absolute
 * path is never joined under a package folder. A path outside the checkout
 * keeps the form the tool printed.
 */
function reportedPath(
  file: string,
  pkg: string | undefined,
  root: string,
): { readonly file: string; readonly packageRelative?: true } {
  if (pkg !== undefined && !posix.isAbsolute(file)) {
    const clean = posix.normalize(file).replace(/\/+$/, "");
    return { file: clean, packageRelative: true };
  }
  const place = checkoutPath(file, root);
  return { file: place.kind === "inside" ? place.path : file };
}

/** At most this many workspace folders are read to place packages. */
const MAX_WORKSPACE_PACKAGES = 200;

/**
 * The checkout folder of each workspace package, by its package.json `name`
 * and by its folder. Folders come from the root package.json `workspaces`
 * (an array, or `{ packages }`) and from `pnpm-workspace.yaml`'s `packages`
 * list; a pattern may be a folder or end in `/*`, and anything else
 * (negations, deeper globs) is skipped. Reads never count as the model's.
 */
export async function workspacePackageFolders(
  filesystem: Pick<NativeHarnessFileSystemPort, "read" | "root">,
): Promise<ReadonlyMap<string, string>> {
  const patterns: string[] = [];
  const manifest = await readJson(filesystem, "package.json");
  const workspaces = recordField(manifest, "workspaces");
  const listed = Array.isArray(workspaces) ? workspaces : recordField(workspaces, "packages");
  if (Array.isArray(listed)) {
    for (const entry of listed) if (typeof entry === "string") patterns.push(entry);
  }
  const pnpm = await filesystem.read({ path: "pnpm-workspace.yaml", marksRead: false });
  if (pnpm.kind === "file") patterns.push(...pnpmWorkspacePatterns(pnpm.lines));
  const folders: string[] = [];
  for (const raw of patterns) {
    if (raw.trim().startsWith("!")) continue;
    const place = checkoutPath(raw.trim(), filesystem.root);
    if (place.kind === "outside" || place.path === "") continue;
    const pattern = place.path;
    if (pattern.endsWith("/*") && !pattern.slice(0, -2).includes("*")) {
      const parent = pattern.slice(0, -2);
      const listing = await filesystem.read({ path: parent, marksRead: false });
      if (listing.kind !== "directory") continue;
      for (const entry of listing.entries) {
        if (entry.kind === "directory") folders.push(`${parent}/${entry.name}`);
      }
    } else if (!pattern.includes("*")) {
      folders.push(pattern);
    }
  }
  const places = new Map<string, string>();
  for (const folder of [...new Set(folders)].slice(0, MAX_WORKSPACE_PACKAGES)) {
    places.set(folder, folder);
    const name = recordField(await readJson(filesystem, `${folder}/package.json`), "name");
    if (typeof name === "string" && name.length > 0) places.set(name, folder);
  }
  return places;
}

/** Problems with each package-relative path made checkout-relative where its package was placed. */
export function placeInCheckout(
  problems: ReadonlyArray<NativeHarnessDiagnostic>,
  folders: ReadonlyMap<string, string>,
  root: string,
): ReadonlyArray<NativeHarnessDiagnostic> {
  return problems.map((problem) => {
    if (problem.packageRelative !== true || problem.package === undefined) return problem;
    const folder = folders.get(problem.package);
    if (folder === undefined) return problem;
    const { packageRelative: _placed, ...rest } = problem;
    const joined = `${folder}/${problem.file}`;
    const place = checkoutPath(joined, root);
    return { ...rest, file: place.kind === "inside" ? place.path : joined };
  });
}

function pnpmWorkspacePatterns(lines: ReadonlyArray<string>): ReadonlyArray<string> {
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/.exec(line);
    if (item !== null) patterns.push(item[1] ?? "");
    else if (/^\S/.test(line)) inPackages = false;
  }
  return patterns;
}

async function readJson(
  filesystem: Pick<NativeHarnessFileSystemPort, "read">,
  path: string,
): Promise<unknown> {
  const read = await filesystem.read({ path, marksRead: false });
  if (read.kind !== "file" || read.bounds.truncated) return undefined;
  try {
    return JSON.parse(read.lines.join("\n"));
  } catch {
    return undefined;
  }
}

function recordField(value: unknown, field: string): unknown {
  return typeof value === "object" && value !== null && Object.hasOwn(value, field)
    ? (value as Readonly<Record<string, unknown>>)[field]
    : undefined;
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
  // Workspace folders are read only when a runner named a package.
  const placed = problems.some((problem) => problem.packageRelative === true)
    ? placeInCheckout(problems, await workspacePackageFolders(filesystem), filesystem.root)
    : problems;
  const wanted = args.files;
  const shown =
    wanted === undefined || wanted.length === 0
      ? placed
      : placed.filter((problem) => matchesDiagnosticsFile(problem, wanted, filesystem.root));
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
