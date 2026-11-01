import {
  decodeCodeWorktreeRef,
  type CodeThread,
  type CodeWorktreeRef,
} from "@octant/contracts/code";
import type {
  ManagedCodeThreadCreationInput,
  ManagedCodeThreadCreationPort,
  ManagedCodeThreadPreparation,
} from "../code/codeService";
import { repositoryFromRemote } from "../work/workPromotionProjectPort";
import type { ServerAddress, ServerCall, ServerConnection } from "./serverConnection";
import { createServerGitService } from "./serverGit";
import type { ServerProjectStore } from "./serverProjectStore";
import {
  serverCodeCheckout,
  serverThreadOf,
  serverWorktreeCheckout,
  serverWorktreeFolder,
  serverWorktreeReceiptId,
} from "./serverProjectThreads";

/**
 * A server thread's own worktree and the branch list the composer starts one
 * from. Canonical: docs/design/server-projects.md § Worktrees and pull
 * requests.
 *
 * Every step is Git on the server, in the Project's folder, through the
 * server connection; nothing is created, read, or fetched on this host. The
 * worktree is made beside the folder, where a local managed worktree is made
 * beside its repository, at a path derived from the Project and the thread,
 * and only on a branch that does not exist yet, so creating one never moves
 * or overwrites anything the person already has there.
 */

const CALL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const GIT_SWITCHES = "export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never GIT_OPTIONAL_LOCKS=0";

/** `$1` folder. Refuses unless the folder is its repository's top folder. */
const IN_REPOSITORY_TOP = `${GIT_SWITCHES}
cd -- "$1" 2>/dev/null || exit 3
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 4
[ "$top" = "$1" ] || exit 5`;

/** `$2` source branch, `$3` 1 to start from the remote, `$4` remote. Prints the source commit. */
const RESOLVE_SOURCE_SCRIPT = `${IN_REPOSITORY_TOP}
git check-ref-format --branch "$2" >/dev/null 2>&1 || exit 6
if [ "$3" = 1 ]; then
  case "$4" in ""|-*) exit 7;; esac
  git remote get-url "$4" >/dev/null 2>&1 || exit 7
  git fetch --no-tags --quiet "$4" "+refs/heads/$2:refs/remotes/$4/$2" >/dev/null 2>&1 || exit 8
  base="refs/remotes/$4/$2"
else
  base="refs/heads/$2"
fi
git rev-parse --verify --quiet "$base^{commit}" || exit 9`;

/** `$2` new branch, `$3` worktree folder, `$4` start commit. Prints the new worktree's HEAD. */
const ADD_WORKTREE_SCRIPT = `${IN_REPOSITORY_TOP}
git check-ref-format --branch "$2" >/dev/null 2>&1 || exit 6
git show-ref --verify --quiet "refs/heads/$2" && exit 10
{ [ -e "$3" ] || [ -L "$3" ]; } && exit 11
mkdir -p -- "$(dirname -- "$3")" 2>/dev/null || exit 12
git worktree add --quiet --no-track -b "$2" -- "$3" "$4" >/dev/null 2>&1 || exit 12
git -C "$3" rev-parse --verify HEAD`;

/** `$2` worktree folder, `$3` branch. Removes only what this creation just made. */
const REMOVE_WORKTREE_SCRIPT = `${GIT_SWITCHES}
cd -- "$1" 2>/dev/null || exit 3
git worktree remove --force -- "$2" >/dev/null 2>&1 || exit 12
git branch -D -- "$3" >/dev/null 2>&1 || exit 12`;

/** The current branch, then each branch as `ref NUL worktree-path`. */
const LIST_REFS_SCRIPT = `${GIT_SWITCHES}
cd -- "$1" 2>/dev/null || exit 3
git symbolic-ref --quiet --short HEAD 2>/dev/null
printf '\\n'
git for-each-ref --format='%(refname)%00%(worktreepath)' refs/heads refs/remotes`;

const REFUSALS: Readonly<Record<number, string>> = {
  3: "repository-mismatch",
  4: "repository-mismatch",
  5: "not-repository-top",
  6: "invalid-intent",
  7: "remote-unavailable",
  8: "fetch-rejected",
  9: "ref-unavailable",
  10: "branch-collision",
  11: "path-collision",
  12: "worktree-unavailable",
};

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface ServerWorktreeOptions {
  readonly store: Pick<ServerProjectStore, "project" | "addressOf">;
  readonly connection: Pick<ServerConnection, "run">;
}

/**
 * Managed-thread creation that makes a server Project's worktree on its
 * server and hands every other Project to `local`.
 */
export function withServerWorktreeCreation(
  options: ServerWorktreeOptions,
  local: ManagedCodeThreadCreationPort,
): ManagedCodeThreadCreationPort {
  // What a commit made, so a creation that cannot be bound removes it again.
  // Only this process's own creations are kept; nothing else is ever removed.
  const created = new Map<
    string,
    { readonly projectId: string; readonly folder: string; readonly branch: string }
  >();
  const placeOf = (input: ManagedCodeThreadCreationInput) => {
    const project = options.store.project(String(input.projectId));
    if (project === undefined) return undefined;
    const address = options.store.addressOf(String(project.id));
    return { project, server: address.kind === "address" ? address.server : undefined };
  };
  const run = (
    server: ServerAddress,
    script: string,
    args: ReadonlyArray<string>,
    signal?: AbortSignal,
  ) =>
    options.connection.run(server, {
      script,
      args,
      timeoutMs: CALL_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
  return {
    prepare: async (input, signal) => {
      const place = placeOf(input);
      if (place === undefined) return local.prepare(input, signal);
      if (place.server === undefined) return { status: "refused", reason: "server-not-registered" };
      // Even the source fetch writes refs on the server, so a Plan thread's
      // creation is refused before anything runs there.
      if (input.executionPolicy === "plan") return { status: "refused", reason: "plan-on-server" };
      const derived = serverCodeCheckout(place.project);
      if (String(derived.bindingRevisionId) !== String(input.bindingRevisionId)) {
        return { status: "refused", reason: "repository-mismatch" };
      }
      // A fork's files live in this host's checkpoints, which a server never had.
      if (input.sourceFiles !== undefined || input.sourceRevision !== undefined) {
        return { status: "refused", reason: "source-files-unavailable" };
      }
      const remoteName = input.remoteName ?? "origin";
      const resolved = await run(
        place.server,
        RESOLVE_SOURCE_SCRIPT,
        [place.project.folder, input.sourceBranch, input.startFromOrigin ? "1" : "0", remoteName],
        signal,
      );
      const head = objectIdOf(resolved);
      if (head.kind === "interrupted") return { status: "interrupted" };
      if (head.kind === "refused") return { status: "refused", reason: head.reason };
      const preparation: ManagedCodeThreadPreparation = {
        repositoryId: derived.checkout.repositoryId,
        checkoutId: serverWorktreeCheckout(
          place.project,
          String(input.threadId),
          place.project.boundAt,
        ).checkout.id,
        branchIntent: input.branchIntent,
        resolvedHead: head.oid,
        mode: input.startFromOrigin ? "origin" : "local",
        sourceBranch: input.sourceBranch,
        ...(input.startFromOrigin ? { remoteName, fetchedAt: new Date().toISOString() } : {}),
        checkoutKind: "remote-root",
      };
      return { status: "prepared", preparation };
    },
    commit: async (input, preparation, signal) => {
      const place = placeOf(input);
      if (place === undefined) return local.commit(input, preparation, signal);
      if (place.server === undefined) return { status: "refused", reason: "server-not-registered" };
      const folder = serverWorktreeFolder(place.project, String(input.threadId));
      const added = await run(
        place.server,
        ADD_WORKTREE_SCRIPT,
        [place.project.folder, preparation.branchIntent, folder, preparation.resolvedHead],
        signal,
      );
      const head = objectIdOf(added);
      if (head.kind === "interrupted") return { status: "interrupted" };
      if (head.kind === "refused") return { status: "refused", reason: head.reason };
      const receiptId = serverWorktreeReceiptId(place.project, String(input.threadId));
      created.set(receiptId, {
        projectId: String(place.project.id),
        folder,
        branch: preparation.branchIntent,
      });
      return { status: "created", receiptId, expectedHead: head.oid };
    },
    cleanup: async (input, signal) => {
      const made = created.get(input.receiptId);
      if (made === undefined) return local.cleanup(input, signal);
      const project = options.store.project(made.projectId);
      const address = options.store.addressOf(made.projectId);
      if (project === undefined || address.kind !== "address") return { status: "waiting" };
      const removed = await run(address.server, REMOVE_WORKTREE_SCRIPT, [
        project.folder,
        made.folder,
        made.branch,
      ]);
      if (removed.status !== "ran") return { status: "waiting" };
      if (removed.exitCode !== 0) return { status: "refused" };
      created.delete(input.receiptId);
      return { status: "removed" };
    },
  };
}

/**
 * The composer's branch list for a server Project, read on its server, or
 * `undefined` for any other Project. A server that cannot be reached lists
 * nothing, as an unavailable local repository does.
 */
export async function listServerWorktreeRefs(
  options: ServerWorktreeOptions,
  projectId: string,
  signal: AbortSignal,
): Promise<ReadonlyArray<CodeWorktreeRef> | undefined> {
  const project = options.store.project(projectId);
  if (project === undefined) return undefined;
  const address = options.store.addressOf(projectId);
  if (address.kind !== "address") return [];
  const call = await options.connection.run(address.server, {
    script: LIST_REFS_SCRIPT,
    args: [project.folder],
    timeoutMs: CALL_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    signal,
  });
  if (call.status !== "ran" || call.exitCode !== 0 || call.truncated) return [];
  const [current = "", ...lines] = call.output.toString("utf8").split("\n");
  const refs: CodeWorktreeRef[] = [];
  for (const line of lines) {
    const [refname = "", worktreePath = ""] = line.split("\0");
    const candidate = refFrom(refname, current.trim(), worktreePath, project.folder);
    if (candidate === undefined) continue;
    try {
      refs.push(decodeCodeWorktreeRef(candidate));
    } catch {
      // A name the composer's contract cannot carry is left out, not guessed at.
    }
  }
  return refs;
}

/**
 * The repository a server thread's pull request names. A composer can read
 * no remote of a server, so its proposal is the `local/…` placeholder; the
 * repository is then the GitHub repository of the remote the thread pushes
 * to, read with Git on the server. A repository the person named stays, and
 * a server that cannot be reached leaves the placeholder, which no pull
 * request can be opened against.
 */
export async function serverPullRequestRepository(
  options: ServerWorktreeOptions,
  thread: Pick<
    CodeThread,
    "id" | "projectId" | "bindingRevisionId" | "repositoryId" | "checkoutId" | "deliveryTarget"
  >,
): Promise<string> {
  const proposed = thread.deliveryTarget.proposedBaseRepository;
  const place = serverThreadOf(options.store, thread);
  if (place === undefined || !proposed.startsWith("local/")) return proposed;
  const projectId = String(place.project.id);
  const remotes = await createServerGitService({
    connection: options.connection,
    server: () => {
      const address = options.store.addressOf(projectId);
      return address.kind === "address" ? address.server : undefined;
    },
  }).observeRemotes(place.folder);
  const remote = remotes?.find((candidate) => candidate.name === thread.deliveryTarget.remoteName);
  if (remote === undefined) return proposed;
  return repositoryFromRemote(remote.pushUrl || remote.fetchUrl) ?? proposed;
}

function refFrom(
  refname: string,
  current: string,
  worktreePath: string,
  folder: string,
): Record<string, unknown> | undefined {
  if (refname.startsWith("refs/heads/")) {
    const name = refname.slice("refs/heads/".length);
    return {
      name,
      kind: "local",
      ...(name === current ? { isCurrent: true } : {}),
      ...(worktreePath !== "" && worktreePath !== folder ? { hasWorktree: true } : {}),
    };
  }
  if (refname.startsWith("refs/remotes/")) {
    const name = refname.slice("refs/remotes/".length);
    const slash = name.indexOf("/");
    if (slash <= 0 || name.endsWith("/HEAD")) return undefined;
    return { name, kind: "remote", remoteName: name.slice(0, slash) };
  }
  return undefined;
}

type ObjectIdAnswer =
  | { readonly kind: "oid"; readonly oid: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "interrupted" };

function objectIdOf(call: ServerCall): ObjectIdAnswer {
  if (call.status === "unreachable") return { kind: "refused", reason: "server-unreachable" };
  // A step Octant stopped waiting for may still finish on the server.
  if (call.status !== "ran") return { kind: "interrupted" };
  if (call.exitCode !== 0) {
    return { kind: "refused", reason: REFUSALS[call.exitCode] ?? "worktree-unavailable" };
  }
  const oid = call.output.toString("utf8").trim();
  return OBJECT_ID.test(oid)
    ? { kind: "oid", oid }
    : { kind: "refused", reason: "ref-unavailable" };
}
