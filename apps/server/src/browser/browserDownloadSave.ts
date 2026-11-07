import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import {
  ApprovedWorkingFolder,
  decodeThreadWorkingDirectory,
  type ProjectWorkingFolderId,
  type ThreadWorkingDirectory,
} from "@octant/contracts";
import {
  BROWSER_DOWNLOAD_SNIFF_BYTES,
  browserDownloadNameIsExecutable,
  numberedBrowserDownloadName,
  refuseBrowserDownloadType,
  safeBrowserDownloadName,
  sniffBrowserDownload,
} from "@octant/domain";
import {
  BROWSER_DOWNLOAD_FOLDER,
  MAX_BROWSER_DOWNLOAD_FILE_BYTES,
  type BrowserDownloadRefusalReason,
} from "@octant/contracts/browser-download";
import { isInsideBrowserDownloadHold } from "@octant/host-runtime";

/** What the person is asked about, as the server itself read it from the held file. */
export interface BrowserDownloadFacts {
  readonly name: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
}

export type BrowserDownloadSaveDecision = "approved" | "denied" | "cancelled" | "expired";
export interface BrowserDownloadDirectoryIdentity {
  readonly device: string;
  readonly inode: string;
}

/** Host-resolved authority only; never decoded from an agent's tool arguments. */
export interface BrowserDownloadDestination {
  readonly folder: ApprovedWorkingFolder;
  readonly canonicalRoot: string;
  readonly directory: ThreadWorkingDirectory;
  /** The exact directory the person reviewed, not merely its parent. */
  readonly reviewedDirectory: BrowserDownloadDirectoryIdentity;
  readonly current: () => boolean;
}

export type BrowserDownloadSaveOutcome =
  | {
      readonly status: "saved";
      /** Workspace-relative normally; selected-root-relative when destination is present. */
      readonly path: string;
      readonly destination?: {
        readonly approvedFolderId: ProjectWorkingFolderId;
        readonly label: string;
        readonly pathBase: "selected-root";
      };
      readonly sizeBytes: number;
      readonly mediaType: string;
      readonly sha256: string;
    }
  | {
      readonly status: "refused";
      readonly error: string;
      readonly reason: BrowserDownloadRefusalReason | undefined;
      readonly facts: BrowserDownloadFacts | undefined;
    };

type SaveInput = {
  readonly workspaceRoot: string | undefined;
  readonly destination?: BrowserDownloadDestination;
  readonly signal?: AbortSignal;
  readonly name: string;
  readonly claim: () => Promise<string | undefined>;
  readonly ask: (facts: BrowserDownloadFacts) => Promise<BrowserDownloadSaveDecision>;
  /** Synchronous final source/authority/quota admission; called once, immediately before dispatch. */
  readonly finalAdmission?: (facts: BrowserDownloadFacts) => BrowserDownloadSaveDecision;
  readonly isHeldPath?: (path: string) => Promise<boolean>;
};

function refused(
  error: string,
  reason: BrowserDownloadRefusalReason | undefined,
  facts?: BrowserDownloadFacts,
): BrowserDownloadSaveOutcome {
  return { status: "refused", error, reason, facts };
}

function decisionRefusal(
  decision: Exclude<BrowserDownloadSaveDecision, "approved">,
  facts?: BrowserDownloadFacts,
): BrowserDownloadSaveOutcome {
  return refused(`browser-download-${decision}`, decision, facts);
}

function current(input: SaveInput): boolean {
  try {
    return (
      !input.signal?.aborted && (input.destination === undefined || input.destination.current())
    );
  } catch {
    return false;
  }
}

/** Save one inspected held file; the ordinary service uses only workspace/downloads. */
export async function saveBrowserDownload(input: SaveInput): Promise<BrowserDownloadSaveOutcome> {
  if (!current(input)) return decisionRefusal("cancelled");
  const selected = input.destination;
  let root: string;
  try {
    if (selected !== undefined) {
      Schema.decodeUnknownSync(ApprovedWorkingFolder)(selected.folder);
      decodeThreadWorkingDirectory(selected.directory);
      if (!validIdentity(selected.reviewedDirectory))
        return refused("download-unavailable", "unavailable");
      root = selected.canonicalRoot;
    } else {
      if (input.workspaceRoot === undefined) return refused("download-unavailable", "unavailable");
      root = await realpath(input.workspaceRoot);
    }
  } catch {
    return refused("download-unavailable", "unavailable");
  }
  if (!current(input)) return decisionRefusal("cancelled");
  const rootProof = await directoryProof(root);
  if (!current(input)) return decisionRefusal("cancelled");
  if (typeof rootProof === "string") return refused(`download-${rootProof}`, rootProof);
  const initialTarget = await destinationProof(root, selected);
  if (!current(input)) return decisionRefusal("cancelled");
  if (typeof initialTarget === "string") return refused(`download-${initialTarget}`, initialTarget);

  const name = safeBrowserDownloadName(input.name);
  if (browserDownloadNameIsExecutable(name)) {
    return refused("download-executable", "executable", { name, sizeBytes: 0, mediaType: "" });
  }
  const heldPath = await input.claim();
  if (!current(input)) return decisionRefusal("cancelled");
  if (heldPath === undefined) return refused("download-not-found", undefined);
  const held = await (input.isHeldPath ?? isInsideBrowserDownloadHold)(heldPath);
  if (!current(input)) return decisionRefusal("cancelled");
  if (!held) return refused("download-unavailable", "unavailable");
  let handle;
  try {
    handle = await open(heldPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return refused("download-not-found", undefined);
  }
  try {
    if (!current(input)) return decisionRefusal("cancelled");
    const stats = await handle.stat();
    if (!current(input)) return decisionRefusal("cancelled");
    if (!stats.isFile()) return refused("download-unavailable", "unavailable");
    if (stats.size > MAX_BROWSER_DOWNLOAD_FILE_BYTES) {
      return refused("download-too-large", "too-large", {
        name,
        sizeBytes: stats.size,
        mediaType: "",
      });
    }
    const head = new Uint8Array(Math.min(BROWSER_DOWNLOAD_SNIFF_BYTES, stats.size));
    await handle.read(head, 0, head.length, 0);
    if (!current(input)) return decisionRefusal("cancelled");
    const mediaType = sniffBrowserDownload(head).mediaType;
    const facts: BrowserDownloadFacts = { name, sizeBytes: stats.size, mediaType };
    if (refuseBrowserDownloadType(name, head) !== undefined) {
      return refused("download-executable", "executable", facts);
    }
    const answer = await input.ask(facts);
    if (answer !== "approved") return decisionRefusal(answer, facts);
    if (!current(input)) return decisionRefusal("cancelled", facts);

    const bytes = new Uint8Array(stats.size);
    const read = stats.size === 0 ? { bytesRead: 0 } : await handle.read(bytes, 0, stats.size, 0);
    if (!current(input)) return decisionRefusal("cancelled", facts);
    const after = await handle.stat();
    if (!current(input)) return decisionRefusal("cancelled", facts);
    if (read.bytesRead !== stats.size || after.size !== stats.size || after.ino !== stats.ino) {
      return refused("download-changed", "changed", facts);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const finalRoot = await directoryProof(root, rootProof.identity);
    if (!current(input)) return decisionRefusal("cancelled", facts);
    if (typeof finalRoot === "string") return refused(`download-${finalRoot}`, finalRoot, facts);
    const target = await destinationProof(root, selected, initialTarget.identity);
    if (!current(input)) return decisionRefusal("cancelled", facts);
    if (typeof target === "string") return refused(`download-${target}`, target, facts);
    const written = await createExclusively(root, rootProof.identity, target, name, bytes, () => {
      if (!current(input)) return "cancelled";
      const decision = input.finalAdmission?.(facts) ?? "approved";
      return current(input) ? decision : "cancelled";
    });
    if (written.status === "refused") {
      return written.decision === undefined
        ? refused("download-unavailable", "unavailable", facts)
        : decisionRefusal(written.decision, facts);
    }
    return {
      status: "saved",
      path:
        selected === undefined
          ? `${BROWSER_DOWNLOAD_FOLDER}/${written.name}`
          : selected.directory === "."
            ? written.name
            : `${selected.directory}/${written.name}`,
      ...(selected === undefined
        ? {}
        : {
            destination: {
              approvedFolderId: selected.folder.id,
              label: pathFreeLabel(selected.folder),
              pathBase: "selected-root" as const,
            },
          }),
      sizeBytes: stats.size,
      mediaType,
      sha256,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function pathFreeLabel(folder: ApprovedWorkingFolder): string {
  return /[\\/]/.test(folder.label) ||
    folder.label.includes("\0") ||
    /(?:file|https?):/i.test(folder.label)
    ? folder.kind === "main"
      ? "Main folder"
      : "Approved extra folder"
    : folder.label;
}

function validIdentity(identity: BrowserDownloadDirectoryIdentity): boolean {
  return /^[0-9]{1,32}$/.test(identity.device) && /^[0-9]{1,32}$/.test(identity.inode);
}
function sameIdentity(
  left: BrowserDownloadDirectoryIdentity,
  right: BrowserDownloadDirectoryIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

type ProofRefusal = "symlink" | "unavailable" | "changed";
interface DirectoryProof {
  readonly folder: string;
  readonly identity: BrowserDownloadDirectoryIdentity;
}
interface DestinationProof {
  readonly folder: string;
  /** Absent only for the ordinary, not-yet-created downloads folder. */
  readonly identity: BrowserDownloadDirectoryIdentity | undefined;
  readonly createDefault: boolean;
}

async function directoryProof(
  path: string,
  expected?: BrowserDownloadDirectoryIdentity,
  caseInsensitive = false,
): Promise<DirectoryProof | ProofRefusal> {
  const stats = await lstat(path, { bigint: true }).catch(() => undefined);
  if (stats === undefined || !stats.isDirectory())
    return stats?.isSymbolicLink() ? "symlink" : "unavailable";
  const canonical = await realpath(path).catch(() => undefined);
  if (
    canonical === undefined ||
    !(caseInsensitive ? samePath(canonical, path) : canonical === path)
  )
    return "symlink";
  const after = await lstat(path, { bigint: true }).catch(() => undefined);
  if (after === undefined || !after.isDirectory() || after.isSymbolicLink()) return "changed";
  const identity = { device: String(stats.dev), inode: String(stats.ino) };
  if (
    !sameIdentity(identity, { device: String(after.dev), inode: String(after.ino) }) ||
    (expected !== undefined && !sameIdentity(identity, expected))
  )
    return "changed";
  return { folder: canonical, identity };
}

async function destinationProof(
  root: string,
  selected: BrowserDownloadDestination | undefined,
  expected?: BrowserDownloadDirectoryIdentity,
): Promise<DestinationProof | ProofRefusal> {
  const folder =
    selected === undefined ? join(root, BROWSER_DOWNLOAD_FOLDER) : join(root, selected.directory);
  if (selected === undefined && expected === undefined) {
    try {
      await lstat(folder);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { folder, identity: undefined, createDefault: true }
        : "unavailable";
    }
  }
  const proof = await directoryProof(
    folder,
    selected?.reviewedDirectory ?? expected,
    selected === undefined,
  );
  return typeof proof === "string" ? proof : { ...proof, createDefault: false };
}

/** Existing case-insensitive Downloads keeps the ordinary receipt spelling. */
function samePath(left: string, right: string): boolean {
  return left === right || left.toLowerCase() === right.toLowerCase();
}

// Node has no portable openat. The fixed child pins the exact reviewed directory
// as cwd, checks its device/inode and physical position, and creates only a
// relative exclusive basename. The native realpath bypasses Node's cached cwd;
// otherwise a renamed held directory can produce a false saved-path receipt.
const CREATE_DOWNLOAD = `
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv.at(-2);
const folder = process.argv.at(-1);
const input = fs.readFileSync(0);
const length = input.readUInt32BE(0);
if (length > 1048576 || input.length > 27262980) process.exit(4);
const plan = JSON.parse(input.subarray(4, 4 + length).toString("utf8"));
const names = plan.names;
const bytes = input.subarray(4 + length);
const matches = (stats, identity) => stats.isDirectory() && !stats.isSymbolicLink() && String(stats.dev) === identity.device && String(stats.ino) === identity.inode;
const rootIsCurrent = () => matches(fs.lstatSync(root, { bigint: true }), plan.rootIdentity) && fs.realpathSync.native(root) === root;
process.chdir(root);
if (!rootIsCurrent() || !matches(fs.statSync(".", { bigint: true }), plan.rootIdentity)) process.exit(3);
let identity = plan.directoryIdentity;
if (plan.createDefault) {
  if (folder !== path.join(root, "downloads") || identity !== undefined) process.exit(4);
  try { fs.mkdirSync("downloads", { mode: 0o755 }); }
  catch (error) { if (error.code !== "EEXIST") process.exit(3); }
  const stats = fs.lstatSync("downloads", { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) process.exit(3);
  identity = { device: String(stats.dev), inode: String(stats.ino) };
}
if (identity === undefined) process.exit(3);
process.chdir(folder);
const directoryIsCurrent = () => rootIsCurrent() && fs.realpathSync.native(".") === folder && matches(fs.statSync(".", { bigint: true }), identity);
for (const name of names) {
  if (typeof name !== "string" || name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\0")) process.exit(4);
  if (!directoryIsCurrent()) process.exit(3);
  let descriptor;
  try { descriptor = fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644); }
  catch (error) { if (error.code === "EEXIST") continue; process.exit(5); }
  try {
    fs.writeFileSync(descriptor, bytes);
    if (!directoryIsCurrent()) { fs.unlinkSync(name); process.exit(3); }
    fs.closeSync(descriptor);
    process.stdout.write(name);
    process.exit(0);
  } catch { try { fs.closeSync(descriptor); fs.unlinkSync(name); } catch {} process.exit(5); }
}
process.exit(5);
`;

type ExclusiveCreation =
  | { readonly status: "created"; readonly name: string }
  | {
      readonly status: "refused";
      readonly decision: Exclude<BrowserDownloadSaveDecision, "approved"> | undefined;
    };

function createExclusively(
  root: string,
  rootIdentity: BrowserDownloadDirectoryIdentity,
  target: DestinationProof,
  name: string,
  bytes: Uint8Array,
  admit: () => BrowserDownloadSaveDecision,
): Promise<ExclusiveCreation> {
  const unavailable = { status: "refused" as const, decision: undefined };
  if (process.platform !== "darwin" && process.platform !== "linux")
    return Promise.resolve(unavailable);
  const names = Array.from({ length: 1_000 }, (_, index) =>
    numberedBrowserDownloadName(name, index + 1),
  );
  const header = Buffer.from(
    JSON.stringify({
      names,
      rootIdentity,
      directoryIdentity: target.identity,
      createDefault: target.createDefault,
    }),
    "utf8",
  );
  const size = Buffer.alloc(4);
  size.writeUInt32BE(header.length);
  const packet = Buffer.concat([size, header, bytes]);
  return new Promise((resolve) => {
    let decision: BrowserDownloadSaveDecision;
    try {
      decision = admit();
    } catch {
      resolve(unavailable);
      return;
    }
    if (decision !== "approved") {
      resolve({ status: "refused", decision });
      return;
    }
    // No asynchronous boundary follows admission before effect dispatch. Once
    // dispatched, a failed helper may have written: never refund or retry here.
    const child = execFile(
      process.execPath,
      [
        ...(process.versions.bun === undefined
          ? []
          : ["--config=/dev/null", "--no-env-file", "--no-install", "--no-macros"]),
        "-e",
        CREATE_DOWNLOAD,
        root,
        target.folder,
      ],
      {
        cwd: dirname(process.execPath),
        env: process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" },
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 512,
      },
      (error, stdout) =>
        resolve(
          error === null && names.includes(stdout)
            ? { status: "created", name: stdout }
            : unavailable,
        ),
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(packet);
  });
}
