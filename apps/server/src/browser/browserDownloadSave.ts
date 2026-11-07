import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
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

export type BrowserDownloadSaveOutcome =
  | {
      readonly status: "saved";
      /** Relative to the workspace root, with `/` separators. */
      readonly path: string;
      readonly sizeBytes: number;
      readonly mediaType: string;
      readonly sha256: string;
    }
  | {
      readonly status: "refused";
      /** The tool error the agent reads. */
      readonly error: string;
      /** The reason journaled; absent when there is nothing worth recording. */
      readonly reason: BrowserDownloadRefusalReason | undefined;
      /** Whatever was known of the file when it was refused. */
      readonly facts: BrowserDownloadFacts | undefined;
    };

function refused(
  error: string,
  reason: BrowserDownloadRefusalReason | undefined,
  facts?: BrowserDownloadFacts,
): BrowserDownloadSaveOutcome {
  return { status: "refused", error, reason, facts };
}

/**
 * Save a held download into the thread's workspace, if the person says yes.
 *
 * Every check the agent could try to get around is made here, on the server:
 * the held file must be a plain file the runtime's private folder really
 * contains, of an allowed size and type by its own bytes; `downloads/` must be
 * a real folder, not a link; and the new file is created exclusively, without
 * following a link, under a name no existing file has. The person is asked after
 * the checks that need no answer and before anything is written.
 */
export async function saveBrowserDownload(input: {
  readonly workspaceRoot: string | undefined;
  /** The page's suggested name, as the runtime reported it. */
  readonly name: string;
  readonly claim: () => Promise<string | undefined>;
  readonly ask: (
    facts: BrowserDownloadFacts,
  ) => Promise<"approved" | "denied" | "cancelled" | "expired">;
  /** Whether the file is inside the host's private download folder. */
  readonly isHeldPath?: (path: string) => Promise<boolean>;
}): Promise<BrowserDownloadSaveOutcome> {
  if (input.workspaceRoot === undefined) return refused("download-unavailable", "unavailable");
  let root: string;
  try {
    root = await realpath(input.workspaceRoot);
  } catch {
    return refused("download-unavailable", "unavailable");
  }
  const name = safeBrowserDownloadName(input.name);
  if (browserDownloadNameIsExecutable(name)) {
    return refused("download-executable", "executable", { name, sizeBytes: 0, mediaType: "" });
  }
  const folder = await downloadsFolder(root, false);
  if (folder === "symlink") return refused("download-symlink", "symlink");
  if (folder === "unavailable") return refused("download-unavailable", "unavailable");

  const heldPath = await input.claim();
  if (heldPath === undefined) return refused("download-not-found", undefined);
  if (!(await (input.isHeldPath ?? isInsideBrowserDownloadHold)(heldPath))) {
    return refused("download-unavailable", "unavailable");
  }
  let handle;
  try {
    handle = await open(heldPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return refused("download-not-found", undefined);
  }
  try {
    const stats = await handle.stat();
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
    const mediaType = sniffBrowserDownload(head).mediaType;
    const facts: BrowserDownloadFacts = { name, sizeBytes: stats.size, mediaType };
    if (refuseBrowserDownloadType(name, head) !== undefined) {
      return refused("download-executable", "executable", facts);
    }

    const outcome = await input.ask(facts);
    if (outcome !== "approved")
      return refused(
        `browser-download-${outcome}`,
        outcome === "denied" ? "denied" : outcome,
        facts,
      );

    const bytes = new Uint8Array(stats.size);
    const read = stats.size === 0 ? { bytesRead: 0 } : await handle.read(bytes, 0, stats.size, 0);
    const after = await handle.stat();
    if (read.bytesRead !== stats.size || after.size !== stats.size || after.ino !== stats.ino) {
      return refused("download-changed", "changed", facts);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const target = await downloadsFolder(root, true);
    if (target === "symlink") return refused("download-symlink", "symlink", facts);
    if (target === "unavailable") return refused("download-unavailable", "unavailable", facts);
    const written = await createExclusively(target, name, bytes);
    if (written === undefined) return refused("download-unavailable", "unavailable", facts);
    return {
      status: "saved",
      path: `${BROWSER_DOWNLOAD_FOLDER}/${written}`,
      sizeBytes: stats.size,
      mediaType,
      sha256,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The workspace's `downloads/` folder, made if asked. A link there, or any
 * link on the path to it, is refused: the canonical path must be the one named.
 */
async function downloadsFolder(
  root: string,
  create: boolean,
): Promise<string | "symlink" | "unavailable"> {
  const folder = join(root, BROWSER_DOWNLOAD_FOLDER);
  let stats = await lstat(folder).catch(() => undefined);
  if (stats === undefined) {
    if (!create) return folder;
    try {
      await mkdir(folder, { mode: 0o755 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return "unavailable";
    }
    stats = await lstat(folder).catch(() => undefined);
    if (stats === undefined) return "unavailable";
  }
  if (stats.isSymbolicLink()) return "symlink";
  if (!stats.isDirectory()) return "unavailable";
  const canonical = await realpath(folder).catch(() => undefined);
  return canonical !== undefined && samePath(canonical, folder) ? canonical : "symlink";
}

/**
 * Whether two paths name the same place apart from letter case. A volume that
 * ignores case reports an existing `Downloads` folder under that name when
 * `downloads` is asked for, which is the same folder and not a link; the folder
 * is already known not to be a link when this is asked.
 */
function samePath(left: string, right: string): boolean {
  return left === right || left.toLowerCase() === right.toLowerCase();
}

// Node has no portable openat. This fixed child holds the destination as its
// working directory, proves its physical location before creating anything,
// and creates only a relative basename. A concurrent ancestor/link swap cannot
// redirect the write or its cleanup into a different directory.
const CREATE_DOWNLOAD = `
const fs = require("node:fs");
const folder = process.argv.at(-1);
process.chdir(folder);
if (fs.realpathSync(".") !== folder) process.exit(3);
const input = fs.readFileSync(0);
const length = input.readUInt32BE(0);
if (length > 1048576 || input.length > 27262980) process.exit(4);
const names = JSON.parse(input.subarray(4, 4 + length).toString("utf8"));
const bytes = input.subarray(4 + length);
for (const name of names) {
  if (typeof name !== "string" || name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\0")) process.exit(4);
  let descriptor;
  try { descriptor = fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644); }
  catch (error) { if (error.code === "EEXIST") continue; process.exit(5); }
  try {
    fs.writeFileSync(descriptor, bytes);
    if (fs.realpathSync(".") !== folder) { fs.unlinkSync(name); process.exit(3); }
    fs.closeSync(descriptor);
    process.stdout.write(name);
    process.exit(0);
  } catch { try { fs.closeSync(descriptor); fs.unlinkSync(name); } catch {} process.exit(5); }
}
process.exit(5);
`;

async function createExclusively(
  folder: string,
  name: string,
  bytes: Uint8Array,
): Promise<string | undefined> {
  if (process.platform !== "darwin" && process.platform !== "linux") return undefined;
  const names = Array.from({ length: 1_000 }, (_, index) =>
    numberedBrowserDownloadName(name, index + 1),
  );
  const header = Buffer.from(JSON.stringify(names), "utf8");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(header.length);
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [
        ...(process.versions.bun === undefined
          ? []
          : ["--config=/dev/null", "--no-env-file", "--no-install", "--no-macros"]),
        "-e",
        CREATE_DOWNLOAD,
        folder,
      ],
      {
        // Start outside the Project so runtime startup cannot read its config.
        cwd: dirname(process.execPath),
        env: process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" },
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 512,
      },
      (error, stdout) => resolve(error === null && names.includes(stdout) ? stdout : undefined),
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(Buffer.concat([size, header, bytes]));
  });
}
