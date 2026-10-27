import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import type {
  SshExecutorCreateWorktreeRequest,
  SshExecutorReadReply,
  SshExecutorRemoveWorktreeRequest,
  SshExecutorWorktreeCreatedReply,
  SshExecutorWorktreeRemovedReply,
} from "@octant/contracts/ssh-executor-protocol";
import type { SshRemoteReadRefusalReason } from "@octant/contracts/ssh-remote-project";
import { SshRemotePath } from "@octant/contracts/ssh-target";
import { resolveBoundRoot, runGit, type ExecutorReadEnvironment } from "./executorReads";

/**
 * The executor's managed worktrees of a bound root. Canonical:
 * docs/design/remote-ssh-environments.md § Terminals and managed worktrees.
 *
 * A worktree lives beside the root, at
 * `<parent of root>/.octant-worktrees/<project>/<name>`, on a new branch
 * `octant/<name>`, as a local managed worktree lives beside its repository.
 * The executor derives that folder itself from the root it was bound to, so
 * the host never names a path to write. Both folders above the worktree are
 * the remote user's own, owner-only, and never links.
 *
 * Git runs as one of Octant's own launches with the approval-gated grants: it
 * may write the root (where the repository's `.git` keeps the worktree's
 * record) and the Project's own worktree folder, nothing else, with no
 * network and no hooks. Removal is Git's own `worktree remove` without force,
 * so a worktree holding a change or an untracked file is kept.
 */

const WORKTREES_FOLDER = ".octant-worktrees";
const GIT_OUTPUT_BYTES = 16_384;
const isRemotePath = Schema.is(SshRemotePath);

/** Options every worktree launch carries: no hook the checkout names runs. */
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"] as const;

type WorktreeLocation =
  | {
      readonly status: "located";
      readonly root: string;
      readonly scope: string;
      readonly target: string;
    }
  | { readonly status: "refused"; readonly reason: SshRemoteReadRefusalReason };

const refused = (reason: SshRemoteReadRefusalReason): SshExecutorReadReply => ({
  kind: "refused",
  reason,
});

export async function createExecutorWorktree(
  environment: ExecutorReadEnvironment,
  request: SshExecutorCreateWorktreeRequest,
): Promise<SshExecutorWorktreeCreatedReply | SshExecutorReadReply> {
  const location = await locateWorktree(environment, request, { create: true });
  if (location.status === "refused") return refused(location.reason);
  if (exists(location.target)) return refused("worktree-exists");
  const branch = `octant/${request.name}`;
  const ran = await runGit(
    environment,
    location.root,
    [...NO_HOOKS, "worktree", "add", "-b", branch, "--", location.target, "HEAD"],
    GIT_OUTPUT_BYTES,
    { additionalWriteRoot: location.scope },
  );
  if (ran.status === "refused") return refused(ran.reason);
  if (ran.exitCode !== 0) {
    return refused(/already exists/iu.test(ran.stderr) ? "worktree-exists" : "worktree-failed");
  }
  let path: string;
  try {
    path = realpathSync(location.target);
  } catch {
    return refused("worktree-failed");
  }
  // The worktree must have landed where it was asked to, and be a folder the
  // host can name as a root.
  if (path !== location.target || !isRemotePath(path)) return refused("worktree-failed");
  return { kind: "worktree-created", path, branch: `octant/${request.name}` };
}

export async function removeExecutorWorktree(
  environment: ExecutorReadEnvironment,
  request: SshExecutorRemoveWorktreeRequest,
): Promise<SshExecutorWorktreeRemovedReply | SshExecutorReadReply> {
  const location = await locateWorktree(environment, request, { create: false });
  if (location.status === "refused") return refused(location.reason);
  // A folder the person already deleted leaves only Git's record of it, which
  // Git drops itself; there is nothing of theirs left to keep.
  const args = exists(location.target)
    ? [...NO_HOOKS, "worktree", "remove", "--", location.target]
    : [...NO_HOOKS, "worktree", "prune"];
  const ran = await runGit(environment, location.root, args, GIT_OUTPUT_BYTES, {
    additionalWriteRoot: location.scope,
  });
  if (ran.status === "refused") return refused(ran.reason);
  if (ran.exitCode !== 0) {
    return refused(
      /modified or untracked|contains modified|is dirty/iu.test(ran.stderr)
        ? "worktree-dirty"
        : "worktree-failed",
    );
  }
  return { kind: "worktree-removed" };
}

/**
 * The root (still the folder that was bound, and its repository's own top
 * level) and the Project's worktree folder beside it, made owner-only when
 * creating and checked as the remote user's own real folders either way.
 */
async function locateWorktree(
  environment: ExecutorReadEnvironment,
  request: { readonly root: string; readonly project: string; readonly name: string },
  options: { readonly create: boolean },
): Promise<WorktreeLocation> {
  const root = await resolveBoundRoot(environment, request.root);
  if (root.status === "refused") return root;
  // `worktree add` records the worktree in the repository's own `.git`. A
  // root inside a larger repository, or itself a linked worktree, keeps that
  // record outside the root, where no grant reaches.
  if (!isOwnFolder(join(root.canonical, ".git"))) {
    return { status: "refused", reason: "not-repository-root" };
  }
  const parent = dirname(root.canonical);
  if (parent === root.canonical) return { status: "refused", reason: "root-not-confinable" };
  const base = join(parent, WORKTREES_FOLDER);
  const scope = join(base, request.project);
  for (const folder of [base, scope]) {
    if (options.create && !exists(folder)) {
      try {
        mkdirSync(folder, { mode: 0o700 });
      } catch {
        return { status: "refused", reason: "worktree-failed" };
      }
    }
    if (!isOwnFolder(folder, { ownerOnly: true })) {
      return { status: "refused", reason: "worktree-failed" };
    }
  }
  // The folder must be one a root may be: never `~/.ssh` or the executor's
  // runtime, or inside them.
  const resolvedScope = await resolveBoundRoot(environment, scope);
  if (resolvedScope.status === "refused") return resolvedScope;
  return { status: "located", root: root.canonical, scope, target: join(scope, request.name) };
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** A real folder, not a link, owned by this user; owner-only when asked. */
function isOwnFolder(path: string, options: { readonly ownerOnly?: boolean } = {}): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (stat.uid !== process.getuid?.()) return false;
    return options.ownerOnly !== true || (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}
