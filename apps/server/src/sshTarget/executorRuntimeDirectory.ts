import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The executor's owner-only scratch on the target: one directory per session,
 * under one per-user parent, removed when the session ends and swept at the
 * next start if a session died without removing it. Canonical:
 * docs/design/remote-ssh-environments.md § Executor delivery and identity.
 *
 * The parent usually sits in a shared temporary directory, where another user
 * could create the name first. A parent this user does not own, that is a
 * link, or that others can enter is refused rather than used.
 */

const SESSION_PREFIX = "session-";

export interface ExecutorRuntimeDirectoryInput {
  readonly base: string;
  readonly uid: number;
  readonly pid: number;
  /** Whether a process id still runs; stale session directories are swept. */
  readonly processAlive?: (pid: number) => boolean;
}

export type ExecutorRuntimeDirectory =
  | {
      readonly status: "opened";
      /** This session's directory. */
      readonly path: string;
      /** The per-user parent that holds every session's directory. */
      readonly parent: string;
      readonly remove: () => void;
    }
  | { readonly status: "refused"; readonly reason: "parent-not-private" | "unwritable" };

export function openExecutorRuntimeDirectory(
  input: ExecutorRuntimeDirectoryInput,
): ExecutorRuntimeDirectory {
  const parent = join(input.base, `octant-executor-${String(input.uid)}`);
  try {
    mkdirSync(parent, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      return { status: "refused", reason: "unwritable" };
    }
  }
  try {
    const stats = lstatSync(parent);
    if (!stats.isDirectory() || stats.uid !== input.uid || (stats.mode & 0o077) !== 0) {
      return { status: "refused", reason: "parent-not-private" };
    }
  } catch {
    return { status: "refused", reason: "unwritable" };
  }
  sweepStaleSessions(parent, input.processAlive ?? processAlive);
  const path = join(
    parent,
    `${SESSION_PREFIX}${String(input.pid)}-${randomBytes(8).toString("hex")}`,
  );
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch {
    return { status: "refused", reason: "unwritable" };
  }
  return {
    status: "opened",
    path,
    parent,
    remove: () => rmSync(path, { recursive: true, force: true }),
  };
}

/** A sibling session directory, as another session of this user would hold one. */
export function siblingSessionDirectoryName(pid: number): string {
  return `${SESSION_PREFIX}${String(pid)}-${randomBytes(8).toString("hex")}`;
}

function sweepStaleSessions(parent: string, alive: (pid: number) => boolean): void {
  let names: ReadonlyArray<string>;
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^session-(\d+)-[0-9a-f]+$/u.exec(name);
    const pid = match?.[1] === undefined ? undefined : Number(match[1]);
    if (pid === undefined || !Number.isSafeInteger(pid) || alive(pid)) continue;
    rmSync(join(parent, name), { recursive: true, force: true });
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists under another user, which a same-user
    // session never is; it is left alone all the same.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
