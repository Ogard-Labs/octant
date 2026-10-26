import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Option, Schema } from "effect";
import type { CodeRelativePath } from "@octant/contracts/code";
import {
  SSH_REMOTE_MAX_DIFF_BYTES,
  SSH_REMOTE_MAX_FILE_BYTES,
  SSH_REMOTE_MAX_LISTING_ENTRIES,
  SSH_REMOTE_MAX_STATUS_ENTRIES,
  SshRemoteDirectoryEntry,
  SshRemoteGitHead,
  SshRemoteGitStatusEntry,
  type SshRemoteReadRefusalReason,
} from "@octant/contracts/ssh-remote-project";
import type {
  SshExecutorReadReply,
  SshExecutorReadRequest,
} from "@octant/contracts/ssh-executor-protocol";
import { SshRemotePath } from "@octant/contracts/ssh-target";
import { classifyPathContainment } from "@octant/domain";
import { liveCodeDirectoryPort, liveCodeTestSourcePort } from "../code/codeDirectoryPort";
import { readConfinedCodeFile } from "../code/codeConfinedFileRead";
import {
  joinCodePath,
  readContainedDirectoryNames,
  resolveContainedPath,
} from "../code/codePathConfinement";
import { createGitCommandEnvironment } from "../gitEnvironmentPort";
import { prepareGitSeatbeltLaunch, resolveGitExecutable } from "../process/gitSeatbeltLaunch";
import {
  makeProcessConfinementLive,
  type ProcessConfinementPort,
} from "../process/seatbeltProfile";
import { postureGrants } from "./executorAttestation";

/**
 * The executor's reads of a bound remote root: resolve a folder to bind, list
 * one directory, read one file, and Git status and diff. Canonical:
 * docs/design/remote-ssh-environments.md § Remote-bound Projects and reads.
 *
 * The host sends the root it bound with every request. The executor refuses a
 * root that now resolves elsewhere, and resolves every path inside it with the
 * same containment sequence local Code reads use: a symbolic link whose target
 * leaves the root is refused here, on the target, where the files are. File
 * reads come from a handle that must be the object containment resolved.
 *
 * Git runs as one of Octant's own launches with Plan's grants, the read-only
 * posture whose canaries this connection attested: no write to the root, no
 * process started after Git itself, and no network. External diff drivers,
 * text conversion, the file-system monitor, and submodule recursion are all
 * off, because each would start another program. A checkout's clean filter
 * cannot be turned off by name, since the checkout names it; it is the
 * no-process grant that keeps one from running.
 */

const SKIPPED_NAMES: ReadonlySet<string> = new Set([".git"]);
const decodeDirectoryEntry = Schema.decodeUnknownOption(SshRemoteDirectoryEntry);
const isRemotePath = Schema.is(SshRemotePath);
/** A listing stops adding paths past this many bytes, so its frame stays bounded. */
const MAX_LISTING_PATH_BYTES = 512 * 1_024;
/** Raw `git status` output read before the rest is reported as truncated. */
const MAX_STATUS_OUTPUT_BYTES = 512 * 1_024;
const MAX_GIT_STDERR_BYTES = 4_096;
const GIT_TIMEOUT_MS = 30_000;

/**
 * Options every Git launch carries. Configuration in the checkout can name
 * programs to run; these keep Git from starting any.
 */
const GIT_FIXED_OPTIONS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "diff.external=",
  "--no-pager",
  "--no-optional-locks",
  // A path is a literal name, never pathspec magic such as `:(glob)`.
  "--literal-pathspecs",
] as const;

export interface ExecutorReadEnvironment {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  /** This session's owner-only directory, for Git's scratch. */
  readonly sessionDirectory: string | undefined;
  /** The per-user parent of every session directory; never inside a bound root. */
  readonly sessionParent: string | undefined;
  readonly confinement?: ProcessConfinementPort;
  readonly bwrapPath?: string;
  readonly gitExecutable?: string;
}

const refused = (reason: SshRemoteReadRefusalReason): SshExecutorReadReply => ({
  kind: "refused",
  reason,
});

export async function answerExecutorRead(
  environment: ExecutorReadEnvironment,
  request: SshExecutorReadRequest,
): Promise<SshExecutorReadReply> {
  if (request.kind === "resolve-root") {
    const resolved = await resolveRoot(environment, request.root);
    return resolved.status === "refused"
      ? refused(resolved.reason)
      : { kind: "root-resolved", root: resolved.canonical };
  }
  const root = await resolveRoot(environment, request.root);
  if (root.status === "refused") return refused(root.reason);
  // The host bound the canonical path; one that resolves elsewhere now was
  // moved or replaced by a link, and is not the folder the person bound.
  if (root.canonical !== request.root) return refused("root-moved");
  switch (request.kind) {
    case "list-directory":
      return listDirectory(root.canonical, request.directory).catch(() => refused("read-failed"));
    case "read-file":
      return readFile(root.canonical, request.path).catch(() => refused("read-failed"));
    case "git-status":
      return gitStatus(environment, root.canonical);
    case "git-diff":
      return gitDiff(environment, root.canonical, request.path);
  }
}

type ResolvedRoot =
  | { readonly status: "resolved"; readonly canonical: string }
  | { readonly status: "refused"; readonly reason: SshRemoteReadRefusalReason };

/**
 * A root is a directory that is not `/`, and neither holds nor sits inside
 * the remote user's `~/.ssh` or the executor's own runtime folder. Reads of a root are not confined by the sandbox, only by
 * containment, so a root that held the SSH keys would let Files read them.
 */
async function resolveRoot(
  environment: ExecutorReadEnvironment,
  root: string,
): Promise<ResolvedRoot> {
  let canonical: string;
  try {
    canonical = await liveCodeDirectoryPort.realpath(root);
    const stat = await liveCodeDirectoryPort.stat(canonical);
    if (!stat.isDirectory) return { status: "refused", reason: "root-unavailable" };
  } catch {
    return { status: "refused", reason: "root-unavailable" };
  }
  // The reply carries the canonical path, and a reply the host's schema
  // refuses ends the whole session: a link to a folder whose name holds a
  // control character is not a root this host can name.
  if (!isRemotePath(canonical)) return { status: "refused", reason: "root-unavailable" };
  if (classifyPathContainment(canonical, canonical) === "escapes-root") {
    return { status: "refused", reason: "root-not-confinable" };
  }
  const protectedPaths = [
    canonicalOrSelf(join(environment.homeDirectory, ".ssh")),
    ...(environment.sessionParent === undefined
      ? []
      : [canonicalOrSelf(environment.sessionParent)]),
  ];
  for (const path of protectedPaths) {
    if (
      classifyPathContainment(canonical, path) === "contained" ||
      classifyPathContainment(path, canonical) === "contained"
    ) {
      return { status: "refused", reason: "root-not-confinable" };
    }
  }
  return { status: "resolved", canonical };
}

function canonicalOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

async function listDirectory(
  root: string,
  directory: CodeRelativePath | undefined,
): Promise<SshExecutorReadReply> {
  const port = liveCodeDirectoryPort;
  let start: Awaited<ReturnType<typeof resolveContainedPath>>;
  if (directory === undefined) {
    start = { canonical: root, stat: await port.stat(root) };
  } else {
    const absolute = joinCodePath(root, directory);
    if (!(await exists(absolute))) return refused("not-found");
    start = await resolveContainedPath(port, root, absolute);
    if (start === undefined) return refused("outside-root");
    if (!start.stat.isDirectory) return refused("not-a-directory");
  }
  const names = await readContainedDirectoryNames(
    port,
    start.canonical,
    start.stat,
    SSH_REMOTE_MAX_LISTING_ENTRIES + 1,
  );
  if (names === undefined) return refused("read-failed");
  const entries: SshRemoteDirectoryEntry[] = [];
  let truncated = names.length > SSH_REMOTE_MAX_LISTING_ENTRIES;
  let pathBytes = 0;
  for (const name of names) {
    if (entries.length >= SSH_REMOTE_MAX_LISTING_ENTRIES) {
      truncated = true;
      break;
    }
    if (name === "." || name === ".." || SKIPPED_NAMES.has(name)) continue;
    const path = directory === undefined ? name : `${directory}/${name}`;
    // An entry whose link leaves the root is left out, as local listings do.
    const resolved = await resolveContainedPath(port, root, joinCodePath(start.canonical, name));
    if (resolved === undefined) continue;
    if (!resolved.stat.isDirectory && !resolved.stat.isFile) continue;
    // A name the relative-path schema refuses (not NFC, a backslash) is left
    // out rather than sent as a frame the host would reject.
    const entry = decodeDirectoryEntry(
      resolved.stat.isDirectory
        ? { kind: "directory", path }
        : { kind: "file", path, byteLength: Math.max(0, Math.trunc(resolved.stat.size)) },
    );
    if (Option.isNone(entry)) continue;
    pathBytes += Buffer.byteLength(path);
    if (pathBytes > MAX_LISTING_PATH_BYTES) {
      truncated = true;
      break;
    }
    entries.push(entry.value);
  }
  return { kind: "directory-listed", listing: { entries, truncated } };
}

async function readFile(root: string, path: CodeRelativePath): Promise<SshExecutorReadReply> {
  const absolute = joinCodePath(root, path);
  if (!(await exists(absolute))) return refused("not-found");
  const read = await readConfinedCodeFile({
    port: liveCodeTestSourcePort,
    canonicalRoot: root,
    relativePath: path,
    maximumBytes: SSH_REMOTE_MAX_FILE_BYTES,
  });
  if (read.status === "refused") {
    return refused(read.reason === "unreadable" ? "read-failed" : read.reason);
  }
  return {
    kind: "file-read",
    file: {
      path,
      byteLength: read.bytes.byteLength,
      contentBase64: Buffer.from(read.bytes).toString("base64"),
    },
  };
}

async function exists(absolute: string): Promise<boolean> {
  try {
    await liveCodeDirectoryPort.lstat(absolute);
    return true;
  } catch {
    return false;
  }
}

async function gitStatus(
  environment: ExecutorReadEnvironment,
  root: string,
): Promise<SshExecutorReadReply> {
  const ran = await runGit(
    environment,
    root,
    [
      "status",
      "--porcelain=v2",
      "-z",
      "--branch",
      "--untracked-files=normal",
      "--ignore-submodules=all",
    ],
    MAX_STATUS_OUTPUT_BYTES,
  );
  if (ran.status === "refused") return refused(ran.reason);
  if (!ran.truncated && ran.exitCode !== 0) return refused(gitFailure(ran));
  const parsed = parsePorcelainV2(ran.stdout, ran.truncated);
  if (parsed === undefined) return refused("read-failed");
  return { kind: "git-status", status: parsed };
}

async function gitDiff(
  environment: ExecutorReadEnvironment,
  root: string,
  path: CodeRelativePath | undefined,
): Promise<SshExecutorReadReply> {
  // A branch with no commits has no HEAD to diff against; the empty tree
  // stands in, as for a local checkout.
  const head = await runGit(environment, root, ["rev-parse", "--verify", "--quiet", "HEAD"], 256);
  if (head.status === "refused") return refused(head.reason);
  let baseline = "HEAD";
  if (head.exitCode !== 0) {
    if (head.exitCode !== 1) return refused(gitFailure(head));
    const empty = await runGit(environment, root, ["hash-object", "-t", "tree", "/dev/null"], 256);
    if (empty.status === "refused") return refused(empty.reason);
    const emptyTree = empty.stdout.toString("utf8").trim();
    if (empty.exitCode !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(emptyTree)) {
      return refused("read-failed");
    }
    baseline = emptyTree;
  }
  const ran = await runGit(
    environment,
    root,
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--ignore-submodules=all",
      baseline,
      "--",
      ...(path === undefined ? [] : [path]),
    ],
    SSH_REMOTE_MAX_DIFF_BYTES,
  );
  if (ran.status === "refused") return refused(ran.reason);
  if (!ran.truncated && ran.exitCode !== 0) return refused(gitFailure(ran));
  let text = wholeUtf8(ran.stdout);
  let truncated = ran.truncated;
  // Bytes that are not UTF-8 decode to three-byte replacement characters, so
  // text from output within the bound can still outgrow it; the host refuses
  // such a reply and ends the session, so the text is cut here instead.
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength > SSH_REMOTE_MAX_DIFF_BYTES) {
    text = wholeUtf8(encoded.subarray(0, SSH_REMOTE_MAX_DIFF_BYTES));
    truncated = true;
  }
  return { kind: "git-diff", diff: { text, byteLength: Buffer.byteLength(text), truncated } };
}

function gitFailure(ran: { readonly exitCode: number | null; readonly stderr: string }) {
  return ran.exitCode === 128 && /not a git repository/iu.test(ran.stderr)
    ? ("not-a-repository" as const)
    : ("read-failed" as const);
}

type GitRun =
  | {
      readonly status: "ran";
      readonly exitCode: number | null;
      readonly stdout: Buffer;
      readonly stderr: string;
      readonly truncated: boolean;
    }
  | { readonly status: "refused"; readonly reason: SshRemoteReadRefusalReason };

/** One Git launch in the root with Plan's grants, its output cut at `maximumBytes`. */
async function runGit(
  environment: ExecutorReadEnvironment,
  root: string,
  args: ReadonlyArray<string>,
  maximumBytes: number,
): Promise<GitRun> {
  if (environment.sessionDirectory === undefined)
    return { status: "refused", reason: "read-failed" };
  let gitExecutable: string;
  try {
    gitExecutable = resolveGitExecutable(environment.gitExecutable, environment.platform);
    accessSync(gitExecutable, constants.X_OK);
    if (!statSync(gitExecutable).isFile()) throw new Error("not a file");
  } catch {
    return { status: "refused", reason: "git-unavailable" };
  }
  const scratch = join(environment.sessionDirectory, `git-${randomBytes(8).toString("hex")}`);
  try {
    mkdirSync(scratch, { mode: 0o700 });
    const base =
      environment.confinement ??
      makeProcessConfinementLive({
        platform: environment.platform,
        ...(environment.bwrapPath === undefined ? {} : { sandboxPath: environment.bwrapPath }),
      });
    // Whatever the Git launch asks for, it runs with Plan's grants: the
    // posture whose canaries speak for it.
    const plan: ProcessConfinementPort = {
      prepare: (input) => base.prepare({ ...input, ...postureGrants("plan") }),
    };
    let launch: ReturnType<ProcessConfinementPort["prepare"]>;
    try {
      launch = prepareGitSeatbeltLaunch({
        confinement: plan,
        platform: environment.platform,
        gitExecutable,
        checkoutRoot: root,
        args: [...GIT_FIXED_OPTIONS, ...args],
        temporaryDirectory: scratch,
        networkEgress: "none",
      });
    } catch {
      return { status: "refused", reason: "read-failed" };
    }
    return await collect(launch.command, launch.args, {
      cwd: root,
      env: {
        ...createGitCommandEnvironment({}),
        PATH: "/usr/bin:/bin",
        HOME: scratch,
        TMPDIR: scratch,
        LC_ALL: "C",
      },
      maximumBytes,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function collect(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly maximumBytes: number;
  },
): Promise<GitRun> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let collected = 0;
    let truncated = false;
    let stderr = "";
    let settled = false;
    let child: ChildProcess;
    const finish = (outcome: GitRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ status: "refused", reason: "read-failed" });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ status: "refused", reason: "read-failed" });
    }, GIT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const room = options.maximumBytes - collected;
      if (chunk.byteLength > room) {
        chunks.push(chunk.subarray(0, room));
        collected += room;
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
      collected += chunk.byteLength;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_GIT_STDERR_BYTES) stderr += chunk.toString("utf8");
    });
    child.once("error", () => finish({ status: "refused", reason: "read-failed" }));
    child.once("close", (code) =>
      finish({
        status: "ran",
        exitCode: code,
        stdout: Buffer.concat(chunks),
        stderr,
        truncated,
      }),
    );
  });
}

/** Text cut back to the last whole UTF-8 character, when a bound split one. */
function wholeUtf8(bytes: Buffer): string {
  for (let back = 1; back <= Math.min(4, bytes.byteLength); back += 1) {
    const byte = bytes[bytes.byteLength - back] ?? 0;
    // A continuation byte: keep looking for the character's first byte.
    if ((byte & 0xc0) === 0x80) continue;
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    const end = width > back ? bytes.byteLength - back : bytes.byteLength;
    return bytes.subarray(0, end).toString("utf8");
  }
  return bytes.toString("utf8");
}

const isGitHead = Schema.is(SshRemoteGitHead);
const isGitStatusEntry = Schema.is(SshRemoteGitStatusEntry);

/**
 * Reads `git status --porcelain=v2 -z --branch`. Output cut at its bound
 * drops the record the cut fell in. An entry the status schema refuses is
 * left out and the status reported as truncated, rather than sending a frame
 * the host would reject.
 */
export function parsePorcelainV2(
  output: Buffer,
  cut: boolean,
): { head: SshRemoteGitHead; entries: SshRemoteGitStatusEntry[]; truncated: boolean } | undefined {
  const fields = output.toString("utf8").split("\u0000");
  // The last field follows the final terminator, or is the record a cut split.
  fields.pop();
  let oid: string | undefined;
  let branch: string | undefined;
  const entries: SshRemoteGitStatusEntry[] = [];
  let truncated = cut;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    if (field.startsWith("# branch.oid ")) {
      oid = field.slice("# branch.oid ".length);
      continue;
    }
    if (field.startsWith("# branch.head ")) {
      branch = field.slice("# branch.head ".length);
      continue;
    }
    if (field.startsWith("# ")) continue;
    let entry: SshRemoteGitStatusEntry | undefined;
    if (field.startsWith("? ")) {
      entry = { path: field.slice(2), index: "?", worktree: "?" };
    } else if (field.startsWith("1 ") || field.startsWith("u ")) {
      const parts = splitFields(field, field.startsWith("1 ") ? 8 : 10);
      if (parts === undefined) return undefined;
      entry = statusEntry(parts.head[1], parts.rest);
    } else if (field.startsWith("2 ")) {
      const parts = splitFields(field, 9);
      if (parts === undefined) return undefined;
      const originalPath = fields[index + 1];
      index += 1;
      if (originalPath === undefined) {
        truncated = true;
        break;
      }
      const renamed = statusEntry(parts.head[1], parts.rest);
      entry = renamed === undefined ? undefined : { ...renamed, originalPath };
    } else if (field.startsWith("! ")) {
      continue;
    } else {
      return undefined;
    }
    if (entry === undefined || !isGitStatusEntry(entry)) {
      truncated = true;
      continue;
    }
    if (entries.length >= SSH_REMOTE_MAX_STATUS_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push(entry);
  }
  if (oid === undefined || branch === undefined) return undefined;
  const head: SshRemoteGitHead =
    branch === "(detached)"
      ? { kind: "detached", oid }
      : oid === "(initial)"
        ? { kind: "unborn", name: branch }
        : { kind: "branch", name: branch, oid };
  if (!isGitHead(head)) return undefined;
  return { head, entries, truncated };
}

function splitFields(
  field: string,
  count: number,
): { readonly head: ReadonlyArray<string>; readonly rest: string } | undefined {
  const head: string[] = [];
  let position = 0;
  for (let taken = 0; taken < count; taken += 1) {
    const next = field.indexOf(" ", position);
    if (next === -1) return undefined;
    head.push(field.slice(position, next));
    position = next + 1;
  }
  return { head, rest: field.slice(position) };
}

function statusEntry(codes: string | undefined, path: string): SshRemoteGitStatusEntry | undefined {
  if (codes?.length !== 2) return undefined;
  const column = (code: string) => (code === "." ? " " : code);
  return { path, index: column(codes.charAt(0)), worktree: column(codes.charAt(1)) };
}
