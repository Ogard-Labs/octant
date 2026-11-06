import { createHash } from "node:crypto";
import {
  MAX_AUTOMATION_SOURCE_SCAN_BYTES,
  MAX_AUTOMATION_SOURCE_FILE_BYTES,
  type AutomationRun,
} from "@octant/contracts";
import { currentProtectedFilesChoice, secretGuardRefusal } from "../process/secretGuard";
import { readConfinedWorkFile } from "../work/workConfinedRead";
import { writeConfinedWorkFile } from "../work/workConfinedWrite";
import type { WorkFilesystemPort } from "../work/workFilesystemPort";
import { joinWorkPath, resolveContainedWorkPath } from "../work/workPathConfinement";
import {
  automationFileSourceCurrent,
  prepareAutomationFileSource,
} from "./automationFileSourceScan";
import type { AutomationFileSourceAuthority } from "./automationFileSources";
import { automationCodeInputDirectory, automationRunFileSource } from "./automationFileContext";

/** Copies the observed bytes, never a newer version, into the run's own checkout. */
export async function prepareAutomationCodeFileInput(input: {
  readonly run: AutomationRun;
  readonly filesystem: WorkFilesystemPort;
  readonly authority: AutomationFileSourceAuthority;
  readonly checkoutRoot: string;
  readonly current: () => boolean;
  readonly signal: AbortSignal;
}): Promise<(() => boolean) | undefined> {
  const { run, filesystem } = input;
  const receipt = automationRunFileSource(run);
  if (receipt === undefined || run.definitionSnapshot.trigger.kind !== "file-arrival")
    return undefined;
  const protectedChoice = currentProtectedFilesChoice();
  const current = () =>
    input.current() &&
    input.authority.current() &&
    currentProtectedFilesChoice() === protectedChoice;
  const preparing = () => !input.signal.aborted && current();
  const source = await prepareAutomationFileSource({
    filesystem,
    canonicalRoot: input.authority.canonicalRoot,
    bindingIdentity: input.authority.bindingIdentity,
    trigger: run.definitionSnapshot.trigger,
    current: preparing,
    signal: input.signal,
  });
  if (source.sourceIdentity !== receipt.checkpoint.sourceIdentity || !preparing()) return undefined;
  const destination = await resolveContainedWorkPath(
    filesystem,
    input.checkoutRoot,
    input.checkoutRoot,
  );
  if (
    !destination?.stat.isDirectory ||
    destination.canonical !== input.checkoutRoot ||
    !preparing()
  )
    return undefined;
  const captured: Array<{
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly digest: string;
  }> = [];
  let total = 0;
  for (const path of receipt.files) {
    const expected = receipt.checkpoint.baseline.find((file) => file.path === path);
    const requested = joinWorkPath(source.canonicalDirectory, path);
    if (expected === undefined || secretGuardRefusal(requested) !== undefined || !preparing())
      return undefined;
    const resolved = await resolveContainedWorkPath(
      filesystem,
      source.canonicalDirectory,
      requested,
    );
    if (!resolved?.stat.isFile || resolved.canonical !== requested || !preparing())
      return undefined;
    const bytes = await readConfinedWorkFile({
      filesystem,
      canonicalPath: resolved.canonical,
      expected: resolved.stat,
      maximumBytes: MAX_AUTOMATION_SOURCE_FILE_BYTES,
    });
    if (
      bytes === undefined ||
      bytes.byteLength !== expected.size ||
      createHash("sha256").update(bytes).digest("hex") !== expected.digest ||
      !preparing()
    )
      return undefined;
    total += bytes.byteLength;
    if (total > MAX_AUTOMATION_SOURCE_SCAN_BYTES) return undefined;
    captured.push({ path, bytes, digest: expected.digest });
  }
  const retained = () => {
    try {
      const actual = filesystem.currentDirectoryIdentity?.(destination.canonical);
      return (
        current() &&
        automationFileSourceCurrent(filesystem, source) &&
        actual?.canonicalPath === destination.canonical &&
        actual.device === destination.stat.device &&
        actual.inode === destination.stat.inode
      );
    } catch {
      return false;
    }
  };
  for (const file of captured) {
    if (!preparing() || !retained()) return undefined;
    const relative = `${automationCodeInputDirectory(run)}/${file.path}`;
    const path = joinWorkPath(destination.canonical, relative);
    const existing = await resolveContainedWorkPath(filesystem, destination.canonical, path);
    if (existing !== undefined) {
      if (existing.canonical !== path || !existing.stat.isFile) return undefined;
      const bytes = await readConfinedWorkFile({
        filesystem,
        canonicalPath: path,
        expected: existing.stat,
        maximumBytes: MAX_AUTOMATION_SOURCE_FILE_BYTES,
      });
      if (bytes === undefined || createHash("sha256").update(bytes).digest("hex") !== file.digest)
        return undefined;
    } else if (
      !(await writeConfinedWorkFile({
        filesystem,
        canonicalPath: path,
        parent: {
          absolutePath: destination.canonical,
          identity: destination.stat,
          remaining: relative.split("/"),
        },
        allowCreate: true,
        bytes: file.bytes,
      }))
    )
      return undefined;
  }
  return preparing() && retained() ? retained : undefined;
}
