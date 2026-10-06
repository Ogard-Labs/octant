import { readdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { OctantMode } from "@octant/contracts";
import type { SqliteConnection } from "./sqlitePort";
import { listThreadFileAnchors } from "./threadPurge";

/**
 * File and side-store half of a confirmed thread purge.
 *
 * Journal erasure is `erasePurgedThread`. This runs first, while receipts
 * still name the files, and is the same function the host wires.
 */
export interface ThreadArtifactPurgeInput {
  readonly connection: SqliteConnection;
  readonly dataDirectory: string;
  readonly mode: OctantMode;
  readonly threadId: string;
  /**
   * The directory the managed-worktree service keeps one repository's
   * managed worktrees under. A receipt that names a path outside it is not
   * a worktree this sweep may delete.
   */
  readonly managedWorktreeRootPath: (repositoryRoot: string, repositoryId: string) => string;
  readonly purgeChatAttachments: (threadId: string) => Promise<void>;
  readonly purgeWorkAttachments: (threadId: string) => Promise<void>;
  readonly purgeCodeAttachments: (threadId: string) => Promise<void>;
  readonly purgeGeneratedImages: (threadId: string) => Promise<void>;
  readonly purgeAgentMessages: (threadId: string) => Promise<void>;
}

export async function purgeThreadArtifacts(input: ThreadArtifactPurgeInput): Promise<void> {
  const anchors = listThreadFileAnchors(input.connection, input.mode, input.threadId);
  await removeMirrorFiles(input.connection, anchors.canvasIds);
  await input.purgeChatAttachments(input.threadId);
  await input.purgeWorkAttachments(input.threadId);
  await input.purgeCodeAttachments(input.threadId);
  await input.purgeGeneratedImages(input.threadId);
  await input.purgeAgentMessages(input.threadId);
  await removeMatchingReceipts(
    join(input.dataDirectory, "agent-run-workspace-receipts"),
    (parsed) => parsed.parentThreadId === input.threadId,
  );
  for (const runId of anchors.runIds) {
    await removeDirectory(
      join(input.dataDirectory, "agent-run-scratch", runId),
      input.dataDirectory,
    );
  }
  await removeOwnedWorktrees(input);
}

/** Deletes the files each Canvas mirrored, as its journaled receipts name them. */
export async function removeMirrorFiles(
  connection: SqliteConnection,
  canvasIds: ReadonlyArray<string>,
): Promise<void> {
  for (const canvasId of canvasIds) {
    const rows = connection
      .prepare(
        `SELECT payload_json FROM event_journal
         WHERE aggregate_type = 'artifact-mirror'
           AND (aggregate_id = ?
             OR json_extract(payload_json, '$.canvasId') = ?
             OR json_extract(payload_json, '$.receipt.canvasId') = ?)`,
      )
      .all(canvasId, canvasId, canvasId) as ReadonlyArray<{ readonly payload_json: string }>;
    for (const row of rows) {
      const payload = parseRecord(row.payload_json);
      if (payload === undefined) continue;
      if (typeof payload.path === "string") await removeFile(payload.path);
      const receipt = isRecord(payload.receipt) ? payload.receipt : payload;
      await removeReceiptFiles(connection, receipt);
    }
  }
}

async function removeReceiptFiles(
  connection: SqliteConnection,
  receipt: Record<string, unknown>,
): Promise<void> {
  const paths = stringList(receipt.paths);
  const destination = isRecord(receipt.destination) ? receipt.destination : undefined;
  if (destination === undefined) return;
  if (destination.kind === "global-folder" && typeof destination.canonicalRoot === "string") {
    for (const path of paths) await removeContained(destination.canonicalRoot, path);
  }
  if (
    destination.kind === "project-repository" &&
    typeof destination.relativeDirectory === "string"
  ) {
    const root = projectCheckoutRoot(connection, receipt.projectId);
    if (root === undefined) return;
    for (const path of paths) {
      await removeContained(join(root, destination.relativeDirectory), path);
    }
  }
}

function projectCheckoutRoot(connection: SqliteConnection, projectId: unknown): string | undefined {
  if (typeof projectId !== "string" || projectId.length === 0) return undefined;
  const row = connection
    .prepare(`SELECT project_json FROM project_projection WHERE project_id = ?`)
    .get(projectId) as { readonly project_json: string } | undefined;
  if (row === undefined) return undefined;
  const project = parseRecord(row.project_json);
  const binding = project !== undefined && isRecord(project.binding) ? project.binding : undefined;
  return binding !== undefined && typeof binding.canonicalRoot === "string"
    ? binding.canonicalRoot
    : undefined;
}

interface StoredWorktreeReceipt {
  readonly file: string;
  readonly threadId?: string;
  readonly path?: string;
  /** A receipt the sweep cannot trust to name a managed worktree blocks it. */
  readonly deletable: boolean;
}

async function removeOwnedWorktrees(input: ThreadArtifactPurgeInput): Promise<void> {
  const directory = join(input.dataDirectory, "managed-worktree-receipts");
  const receipts: Array<StoredWorktreeReceipt> = [];
  for (const name of await readNames(directory)) {
    if (!name.endsWith(".json")) continue;
    const file = join(directory, name);
    const parsed = parseRecord(await readFile(file, "utf8").catch(() => ""));
    receipts.push({ file, ...worktreeReceiptEvidence(parsed, input) });
  }
  const owned: string[] = [];
  const kept = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.path === undefined) continue;
    if (receipt.threadId === input.threadId) owned.push(receipt.path);
    else kept.add(receipt.path);
  }
  const blocked = receipts.some((receipt) => !receipt.deletable);
  for (const receipt of receipts) {
    if (receipt.threadId === input.threadId && receipt.deletable)
      await rm(receipt.file, { force: true });
  }
  if (blocked) return;
  for (const path of owned) {
    if (!kept.has(path)) await removeDirectory(path, input.dataDirectory);
  }
}

/**
 * Whether a receipt names a managed worktree this sweep may delete.
 *
 * A receipt that cannot be parsed, or whose recorded worktree is not inside
 * the directory the service keeps its repository's managed worktrees under,
 * is not evidence this sweep may act on. Its file stays, so a leftover
 * directory is visible instead of silently orphaned, and the sweep leaves
 * every owned worktree in place rather than deleting the ones it happens to
 * recognise.
 */
function worktreeReceiptEvidence(
  parsed: Record<string, unknown> | undefined,
  input: ThreadArtifactPurgeInput,
): { readonly threadId?: string; readonly path?: string; readonly deletable: boolean } {
  if (parsed === undefined) return { deletable: false };
  const threadId =
    typeof parsed.threadId === "string" && parsed.threadId.length > 0 ? parsed.threadId : undefined;
  const path =
    typeof parsed.canonicalWorktreePath === "string" && parsed.canonicalWorktreePath.length > 0
      ? parsed.canonicalWorktreePath
      : undefined;
  const repositoryRoot =
    typeof parsed.canonicalRepositoryPath === "string" && parsed.canonicalRepositoryPath.length > 0
      ? parsed.canonicalRepositoryPath
      : undefined;
  const repositoryId =
    typeof parsed.repositoryId === "string" && parsed.repositoryId.length > 0
      ? parsed.repositoryId
      : undefined;
  if (
    threadId === undefined ||
    path === undefined ||
    repositoryRoot === undefined ||
    repositoryId === undefined ||
    !isAbsolute(repositoryRoot) ||
    !isAbsolute(path)
  ) {
    return { ...(threadId === undefined ? {} : { threadId }), deletable: false };
  }
  const root = resolve(input.managedWorktreeRootPath(repositoryRoot, repositoryId));
  const target = resolve(path);
  const within = relative(root, target);
  if (
    within.length === 0 ||
    within.startsWith("..") ||
    isAbsolute(within) ||
    target === resolve(input.dataDirectory)
  ) {
    return { threadId, deletable: false };
  }
  return { threadId, path, deletable: true };
}

async function removeMatchingReceipts(
  directory: string,
  matches: (parsed: Record<string, unknown>) => boolean,
): Promise<void> {
  for (const name of await readNames(directory)) {
    if (!name.endsWith(".json")) continue;
    const file = join(directory, name);
    const parsed = parseRecord(await readFile(file, "utf8").catch(() => ""));
    if (parsed !== undefined && matches(parsed)) await rm(file, { force: true });
  }
}

async function removeContained(root: string, relativePath: string): Promise<void> {
  if (!isAbsolute(root) || relativePath.includes("\0")) return;
  const target = resolve(root, relativePath);
  const relation = relative(resolve(root), target);
  if (relation.startsWith("..") || isAbsolute(relation)) return;
  await rm(target, { force: true });
}

async function removeFile(path: string): Promise<void> {
  if (!isAbsolute(path)) return;
  await rm(path, { force: true });
}

async function removeDirectory(path: string, dataDirectory: string): Promise<void> {
  const resolved = resolve(path);
  if (!isAbsolute(path) || resolved === resolve(resolved, "..")) return;
  if (resolved === resolve(dataDirectory)) return;
  await rm(resolved, { recursive: true, force: true });
}

async function readNames(directory: string): Promise<ReadonlyArray<string>> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

function stringList(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  const paths: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") paths.push(entry);
  }
  return paths;
}

function parseRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
