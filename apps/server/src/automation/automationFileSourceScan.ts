import { createHash } from "node:crypto";
import {
  MAX_AUTOMATION_SOURCE_DIRECTORY_ENTRIES,
  MAX_AUTOMATION_SOURCE_FILES,
  MAX_AUTOMATION_SOURCE_FILE_BYTES,
  MAX_AUTOMATION_SOURCE_SCAN_BYTES,
  decodeAutomationSourceSnapshot,
  isAutomationSourceRelativePath,
  type AutomationFileArrivalTrigger,
  type AutomationSourceSnapshot,
} from "@octant/contracts";
import { readConfinedWorkFile } from "../work/workConfinedRead";
import { currentProtectedFilesChoice, secretGuardRefusal } from "../process/secretGuard";
import type { WorkFileIdentity, WorkFilesystemPort } from "../work/workFilesystemPort";
import {
  joinWorkPath,
  readContainedWorkDirectoryNames,
  resolveContainedWorkPath,
} from "../work/workPathConfinement";

import { automationSourceSnapshotDigest } from "./automationFileSourceState";

/** Host-internal facts captured from the current, local main Work binding. */
export interface AutomationFileSourceRoot {
  readonly canonicalRoot: string;
  readonly rootIdentity: WorkFileIdentity;
  readonly canonicalDirectory: string;
  readonly directoryIdentity: WorkFileIdentity;
  readonly sourceIdentity: string;
}

/** Final native proof of the exact directories resolved earlier; absence is not authority. */
export function automationFileSourceCurrent(
  filesystem: WorkFilesystemPort,
  root: AutomationFileSourceRoot,
): boolean {
  try {
    for (const [path, expected] of [
      [root.canonicalRoot, root.rootIdentity],
      [root.canonicalDirectory, root.directoryIdentity],
    ] as const) {
      const actual = filesystem.currentDirectoryIdentity?.(path);
      if (actual === undefined || actual.canonicalPath !== path || !sameIdentity(actual, expected))
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

export class AutomationFileSourceScanError extends Error {
  override readonly name = "AutomationFileSourceScanError";
  constructor(
    readonly reason: "source-unavailable" | "source-changed" | "source-limit" | "authority-changed",
  ) {
    super(reason);
  }
}

function sameIdentity(left: WorkFileIdentity, right: WorkFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export async function prepareAutomationFileSource(input: {
  readonly filesystem: WorkFilesystemPort;
  readonly canonicalRoot: string;
  /** Exact host-owned Project/version/binding identity, never a renderer path grant. */
  readonly bindingIdentity: string;
  readonly trigger: AutomationFileArrivalTrigger;
  readonly current: () => boolean;
  readonly signal: AbortSignal;
}): Promise<AutomationFileSourceRoot> {
  const protectedChoice = currentProtectedFilesChoice();
  const check = () => {
    if (
      input.signal.aborted ||
      !input.current() ||
      currentProtectedFilesChoice() !== protectedChoice
    )
      throw new AutomationFileSourceScanError("authority-changed");
  };
  check();
  if (secretGuardRefusal(input.canonicalRoot) !== undefined)
    throw new AutomationFileSourceScanError("source-unavailable");
  const root = await resolveContainedWorkPath(
    input.filesystem,
    input.canonicalRoot,
    input.canonicalRoot,
  );
  check();
  if (!root?.stat.isDirectory || root.canonical !== input.canonicalRoot)
    throw new AutomationFileSourceScanError("source-unavailable");
  const requested =
    input.trigger.directory === "."
      ? input.canonicalRoot
      : joinWorkPath(input.canonicalRoot, input.trigger.directory);
  if (secretGuardRefusal(requested) !== undefined)
    throw new AutomationFileSourceScanError("source-unavailable");
  const directory = await resolveContainedWorkPath(
    input.filesystem,
    input.canonicalRoot,
    requested,
  );
  check();
  if (!directory?.stat.isDirectory || directory.canonical !== requested)
    throw new AutomationFileSourceScanError("source-unavailable");
  const prepared: AutomationFileSourceRoot = {
    canonicalRoot: root.canonical,
    rootIdentity: { device: root.stat.device, inode: root.stat.inode },
    canonicalDirectory: directory.canonical,
    directoryIdentity: { device: directory.stat.device, inode: directory.stat.inode },
    sourceIdentity: createHash("sha256")
      .update(
        JSON.stringify([
          input.bindingIdentity,
          root.canonical,
          root.stat.device,
          root.stat.inode,
          directory.canonical,
          directory.stat.device,
          directory.stat.inode,
        ]),
      )
      .digest("hex"),
  };
  await checkRoot(input.filesystem, prepared, check);
  check();
  return prepared;
}

async function checkRoot(
  filesystem: WorkFilesystemPort,
  root: AutomationFileSourceRoot,
  current: () => void,
): Promise<void> {
  for (const [path, expected] of [
    [root.canonicalRoot, root.rootIdentity],
    [root.canonicalDirectory, root.directoryIdentity],
  ] as const) {
    const resolved = await resolveContainedWorkPath(filesystem, root.canonicalRoot, path);
    current();
    if (
      !resolved?.stat.isDirectory ||
      resolved.canonical !== path ||
      !sameIdentity(resolved.stat, expected)
    ) {
      throw new AutomationFileSourceScanError("source-changed");
    }
  }
}

/** Complete bounded scan; watch hints and their filenames never authorize reads. */
export async function scanAutomationFileSource(input: {
  readonly filesystem: WorkFilesystemPort;
  readonly root: AutomationFileSourceRoot;
  readonly trigger: AutomationFileArrivalTrigger;
  readonly signal: AbortSignal;
  readonly current: () => boolean;
}): Promise<{ readonly snapshot: AutomationSourceSnapshot; readonly digest: string }> {
  const protectedChoice = currentProtectedFilesChoice();
  const check = () => {
    if (
      input.signal.aborted ||
      !input.current() ||
      currentProtectedFilesChoice() !== protectedChoice
    )
      throw new AutomationFileSourceScanError("authority-changed");
  };
  check();
  if (
    secretGuardRefusal(input.root.canonicalRoot) !== undefined ||
    secretGuardRefusal(input.root.canonicalDirectory) !== undefined
  )
    throw new AutomationFileSourceScanError("source-unavailable");
  await checkRoot(input.filesystem, input.root, check);
  const files: Array<AutomationSourceSnapshot[number]> = [];
  let entries = 0;
  let bytesRead = 0;
  const walk = async (path: string, relative: string): Promise<void> => {
    check();
    const directory = await resolveContainedWorkPath(
      input.filesystem,
      input.root.canonicalRoot,
      path,
    );
    check();
    if (!directory?.stat.isDirectory || directory.canonical !== path)
      throw new AutomationFileSourceScanError("source-changed");
    const names = await readContainedWorkDirectoryNames(
      input.filesystem,
      path,
      directory.stat,
      MAX_AUTOMATION_SOURCE_DIRECTORY_ENTRIES - entries + 1,
    );
    check();
    if (names === undefined) throw new AutomationFileSourceScanError("source-unavailable");
    entries += names.length;
    if (entries > MAX_AUTOMATION_SOURCE_DIRECTORY_ENTRIES)
      throw new AutomationFileSourceScanError("source-limit");
    for (const name of names) {
      const next = relative === "" ? name : `${relative}/${name}`;
      // Hidden entries and symbolic links are deliberately outside this trigger's input set.
      if (name.startsWith(".")) continue;
      if (!isAutomationSourceRelativePath(next))
        throw new AutomationFileSourceScanError("source-limit");
      const childPath = joinWorkPath(path, name);
      // Match the existing harness search rule: protected entries are neither read nor reported.
      if (secretGuardRefusal(childPath) !== undefined) continue;
      const named = await input.filesystem.lstat(childPath).catch(() => undefined);
      check();
      if (named === undefined) throw new AutomationFileSourceScanError("source-unavailable");
      if (named.isSymbolicLink) continue;
      const child = await resolveContainedWorkPath(
        input.filesystem,
        input.root.canonicalRoot,
        childPath,
      );
      check();
      if (child === undefined || child.canonical !== childPath || !sameIdentity(named, child.stat))
        throw new AutomationFileSourceScanError("source-changed");
      if (secretGuardRefusal(child.canonical) !== undefined) continue;
      if (child.stat.isDirectory) {
        if (
          !input.trigger.excludeDirectories.some(
            (excluded) => next === excluded || next.startsWith(`${excluded}/`),
          )
        )
          await walk(childPath, next);
        continue;
      }
      if (!child.stat.isFile) continue;
      const extension = name.includes(".")
        ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
        : "";
      if (
        input.trigger.includeExtensions.length !== 0 &&
        !input.trigger.includeExtensions.includes(extension)
      )
        continue;
      if (
        files.length >= MAX_AUTOMATION_SOURCE_FILES ||
        child.stat.size > MAX_AUTOMATION_SOURCE_FILE_BYTES ||
        bytesRead + child.stat.size > MAX_AUTOMATION_SOURCE_SCAN_BYTES
      )
        throw new AutomationFileSourceScanError("source-limit");
      const bytes = await readConfinedWorkFile({
        filesystem: input.filesystem,
        canonicalPath: child.canonical,
        expected: child.stat,
        maximumBytes: Math.min(
          MAX_AUTOMATION_SOURCE_FILE_BYTES,
          MAX_AUTOMATION_SOURCE_SCAN_BYTES - bytesRead,
        ),
      });
      check();
      if (bytes === undefined) throw new AutomationFileSourceScanError("source-unavailable");
      bytesRead += bytes.byteLength;
      files.push({
        path: next,
        digest: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      });
    }
    const after = await resolveContainedWorkPath(input.filesystem, input.root.canonicalRoot, path);
    check();
    if (
      !after?.stat.isDirectory ||
      after.canonical !== path ||
      !sameIdentity(after.stat, directory.stat)
    )
      throw new AutomationFileSourceScanError("source-changed");
  };
  await walk(input.root.canonicalDirectory, "");
  await checkRoot(input.filesystem, input.root, check);
  check();
  const snapshot = decodeAutomationSourceSnapshot(
    files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
  );
  return { snapshot, digest: automationSourceSnapshotDigest(snapshot) };
}
