// The Code side of a thread move, on both computers. The source captures the
// checkout as a Git bundle (the branch's unpushed commits, then the index and
// the working tree as two snapshot commits) and the conversation as a moved
// transcript. The destination fetches the bundle into a clone of the same
// repository, starts a managed Code thread from the two snapshots under the
// host's own scope, keeps the transcript as the thread's moved history, and
// holds the thread until the source commits.
//
// The source erases its thread through the ordinary purge. A worktree that
// still holds something the move did not carry (a refused file, an ignored
// file, or an edit made after the snapshot) is moved out of the managed
// folder first, so the purge leaves it in place.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CodeThreadId,
  MovedHistoryEntry,
  ProviderModelId,
  type CodeThread,
  type MovedThreadReference,
} from "@octant/contracts";
import { mayRemoveMovedWorktree, normalizeRepositoryRemote } from "@octant/domain";
import { Schema } from "effect";
import {
  branchExists,
  captureCheckoutForMove,
  checkoutStillMatchesMove,
  forgetMoveSnapshot,
  receiveCheckoutFromMove,
  relocateWorktree,
  repositoryRemotes,
} from "./codeThreadMoveGit";
import {
  MovedThreadParts,
  packThreadParts,
  rehomeThreadParts,
  type ThreadPartsDestination,
  type ThreadPartsSource,
} from "./movedThreadParts";
import type { ThreadMoveHolds } from "./threadMoveHolds";
import type {
  PackedPart,
  ThreadMoveDestinationHost,
  ThreadMoveSourceHost,
} from "./threadMoveService";

export const MOVED_CODE_THREAD_FORMAT = "octant.thread-move.code/1" as const;

const strict = { parseOptions: { onExcessProperty: "error" as const } };

const MovedCodeThread = Schema.Struct({
  format: Schema.Literal(MOVED_CODE_THREAD_FORMAT),
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  /** The branch the thread worked on; absent for a detached head. */
  branch: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255))),
  /** The provider the thread ran on, by kind, so the destination can pick its own instance of it. */
  providerDriverKind: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
  modelId: ProviderModelId,
  externalContentIngested: Schema.Boolean,
  refusedFiles: Schema.Array(Schema.String).pipe(Schema.maxItems(10_000)),
  entries: Schema.Array(MovedHistoryEntry).pipe(Schema.maxItems(10_000)),
  parts: Schema.optional(MovedThreadParts),
}).annotations(strict);
type MovedCodeThread = typeof MovedCodeThread.Type;

const decodeMovedCodeThread = Schema.decodeUnknownSync(MovedCodeThread);
const decodeCodeThreadId = Schema.decodeUnknownSync(CodeThreadId);

/** A Code Project on the destination, as far as a move needs it. */
export interface MoveDestinationCodeProject {
  readonly projectId: string;
  /** The repository folder the Project is bound to; the bundle is fetched into it. */
  readonly canonicalRoot: string;
  readonly repositoryId: string;
  readonly bindingRevisionId: string;
}

export interface CodeThreadMoveHostOptions {
  readonly readThread: (threadId: CodeThreadId) => CodeThread | undefined;
  /** Whether a turn runs or the thread waits on the person. */
  readonly isBusy: (threadId: CodeThreadId) => boolean;
  /** The folder the thread's checkout is, resolved under the host's own scope. */
  readonly checkoutRoot: (threadId: CodeThreadId) => Promise<string | undefined>;
  /** Whether the checkout is a managed worktree this host made for the thread. */
  readonly ownsManagedWorktree: (threadId: CodeThreadId) => boolean;
  readonly providerDriverKind: (providerInstanceId: string) => string | undefined;
  readonly transcript: (threadId: CodeThreadId) => Promise<ReadonlyArray<MovedHistoryEntry>>;
  readonly externalContentIngested: (threadId: string) => boolean;
  /** Erases one Code thread through the ordinary purge. */
  readonly purge: (threadId: CodeThreadId) => Promise<void>;
  readonly codeProject: (projectId: string) => MoveDestinationCodeProject | undefined;
  /**
   * This host's provider instance for a moved thread: one of the same kind
   * when it has one, otherwise its first enabled Code provider, which the
   * person confirms or switches before the first turn.
   */
  readonly resolveProvider: (
    driverKind: string,
    modelId: string,
  ) => { readonly providerInstanceId: string; readonly modelId: string } | undefined;
  /** Starts a managed Code thread from the moved snapshots under the host's own scope. */
  readonly createThread: (input: {
    readonly threadId: CodeThreadId;
    readonly project: MoveDestinationCodeProject;
    readonly title: string;
    readonly branchIntent: string;
    readonly sourceBranch: string;
    readonly head: string;
    readonly provider: { readonly providerInstanceId: string; readonly modelId: string };
    readonly files: { readonly worktree: string; readonly index: string };
    /** Set when the source thread had read outside content; the new thread starts marked too. */
    readonly inheritedMark?: { readonly sourceLabel: string; readonly contentReference: string };
  }) => Promise<void>;
  readonly journalHistory: (input: {
    readonly threadId: string;
    readonly moveId: string;
    readonly entries: ReadonlyArray<MovedHistoryEntry>;
  }) => void;
  readonly holds: ThreadMoveHolds;
  readonly parts: {
    readonly source: ThreadPartsSource;
    readonly destination: ThreadPartsDestination;
  };
}

export function createCodeThreadMoveHost(options: CodeThreadMoveHostOptions): {
  readonly source: ThreadMoveSourceHost;
  readonly destination: ThreadMoveDestinationHost;
} {
  const codeThreadOf = (thread: MovedThreadReference): CodeThread | undefined => {
    if (thread.mode !== "code") return undefined;
    try {
      return options.readThread(decodeCodeThreadId(thread.threadId));
    } catch {
      return undefined;
    }
  };

  const source: ThreadMoveSourceHost = {
    read: async (thread) => {
      const code = codeThreadOf(thread);
      if (code === undefined || code.lifecycle !== "active") return { status: "missing" };
      const root = await options.checkoutRoot(code.id);
      return {
        status: "found",
        title: code.title,
        busy: options.isBusy(code.id),
        // Delegation between computers carries Work threads only.
        delegated: false,
        repositoryRemotes: root === undefined ? [] : await repositoryRemotes(root),
      };
    },
    freeze: (thread) => options.holds.hold(thread),
    unfreeze: (thread) => options.holds.release(thread),
    isFrozen: (thread) => options.holds.isHeld(thread),
    pack: async (thread, folder, moveId) => {
      const code = codeThreadOf(thread);
      if (code === undefined) return { status: "refused", reason: "refused" };
      const root = await options.checkoutRoot(code.id);
      const driverKind = options.providerDriverKind(String(code.providerInstanceId));
      if (root === undefined || driverKind === undefined) {
        return { status: "refused", reason: "refused" };
      }
      const bundlePath = join(folder, "checkout.bundle");
      let captured;
      try {
        captured = await captureCheckoutForMove({
          checkoutRoot: root,
          moveId: String(moveId),
          bundlePath,
        });
      } catch {
        return { status: "refused", reason: "transfer-failed" };
      }
      const bulk = await packThreadParts(thread, folder, options.parts.source);
      const moved: MovedCodeThread = {
        format: MOVED_CODE_THREAD_FORMAT,
        title: code.title,
        ...(captured.branch === undefined ? {} : { branch: captured.branch }),
        providerDriverKind: driverKind,
        modelId: code.modelId,
        externalContentIngested: options.externalContentIngested(thread.threadId),
        refusedFiles: captured.refusedFiles,
        entries: await options.transcript(code.id),
        ...(bulk.index === undefined ? {} : { parts: bulk.index }),
      };
      const threadPath = join(folder, "thread.json");
      await writeFile(threadPath, JSON.stringify(moved), { mode: 0o600 });
      const parts: ReadonlyArray<PackedPart> = [
        { partId: "thread", kind: "thread-bundle", path: threadPath },
        { partId: "checkout", kind: "git-bundle", path: bundlePath },
        ...bulk.parts,
      ];
      return {
        status: "packed",
        parts,
        ...(bulk.partsLeftBehind.length === 0 ? {} : { partsLeftBehind: bulk.partsLeftBehind }),
      };
    },
    erase: async ({ thread, moveId }) => {
      const code = codeThreadOf(thread);
      if (code === undefined) return { worktreeKept: false };
      const root = await options.checkoutRoot(code.id);
      let worktreeKept = false;
      let keptWorktree: string | undefined;
      let changesRemainInCheckout = false;
      if (root !== undefined) {
        const check = await checkoutStillMatchesMove({
          checkoutRoot: root,
          moveId: String(moveId),
        }).catch(() => ({ matches: false, ignoredFiles: 0 }));
        const removable = mayRemoveMovedWorktree({
          refusedFiles: check.matches ? 0 : 1,
          ignoredFiles: check.ignoredFiles,
        });
        await forgetMoveSnapshot(root, String(moveId));
        if (!options.ownsManagedWorktree(code.id)) {
          // The Project's own checkout is the person's folder; Octant never
          // resets it, so the thread's changes remain there.
          changesRemainInCheckout = true;
          worktreeKept = !removable;
        } else if (!removable) {
          // Out of the managed folder, the purge below leaves it in place.
          keptWorktree = `${root}-moved-out-${String(moveId).slice(0, 8)}`;
          await relocateWorktree({ worktreeRoot: root, target: keptWorktree });
          worktreeKept = true;
        }
      }
      await options.purge(code.id);
      return {
        worktreeKept,
        ...(keptWorktree === undefined ? {} : { keptWorktree }),
        ...(changesRemainInCheckout ? { changesRemainInCheckout } : {}),
      };
    },
  };

  const destination: ThreadMoveDestinationHost = {
    acceptsProject: async (placement) => {
      if (placement.mode !== "code" || placement.destinationProjectId === undefined) return false;
      const project = options.codeProject(placement.destinationProjectId);
      if (project === undefined) return false;
      return sharesRepository(
        placement.repositoryRemotes ?? [],
        await repositoryRemotes(project.canonicalRoot),
      );
    },
    arrive: async ({ thread: planned, offer, parts }) => {
      if (planned.mode !== "code" || offer.destinationProjectId === undefined) {
        return { status: "refused", reason: "transfer-failed" };
      }
      const threadPart = offer.manifest.parts.find((part) => part.kind === "thread-bundle");
      const bundlePart = offer.manifest.parts.find((part) => part.kind === "git-bundle");
      const threadPath = threadPart === undefined ? undefined : parts.get(threadPart.partId);
      const bundlePath = bundlePart === undefined ? undefined : parts.get(bundlePart.partId);
      if (threadPath === undefined || bundlePath === undefined) {
        return { status: "refused", reason: "transfer-failed" };
      }
      let moved: MovedCodeThread;
      try {
        moved = decodeMovedCodeThread(JSON.parse(await readFile(threadPath, "utf8")));
      } catch {
        return { status: "refused", reason: "transfer-failed" };
      }
      const history = {
        threadId: planned.threadId,
        moveId: String(offer.moveId),
        entries: moved.entries,
      };
      // Bulk parts are re-homed under ids the move derives, so a second try
      // records nothing twice.
      const rehome = async () =>
        (
          await rehomeThreadParts({
            index: moved.parts,
            parts,
            moveId: String(offer.moveId),
            thread: planned,
            projectId: String(offer.destinationProjectId),
            destination: options.parts.destination,
          })
        ).status === "carried"
          ? ({ status: "arrived", thread: planned } as const)
          : ({ status: "refused", reason: "transfer-failed" } as const);
      // A thread already started under the planned id was started by an
      // earlier try that stopped before it was recorded: hold it and start no
      // second. That try may have stopped before the history was kept or
      // every part re-homed, so they are now (a second import keeps the
      // first), before the source is told it arrived and erases the only
      // other copy.
      if (codeThreadOf(planned) !== undefined) {
        options.holds.hold(planned);
        options.journalHistory(history);
        return rehome();
      }
      const project = options.codeProject(String(offer.destinationProjectId));
      if (project === undefined) return { status: "refused", reason: "no-eligible-project" };
      const received = await receiveCheckoutFromMove({
        repositoryRoot: project.canonicalRoot,
        moveId: String(offer.moveId),
        bundlePath,
      });
      if (received.status === "refused") return { status: "refused", reason: "transfer-failed" };
      const provider = options.resolveProvider(moved.providerDriverKind, String(moved.modelId));
      if (provider === undefined) return { status: "refused", reason: "no-matching-provider" };
      const wanted = moved.branch ?? `octant/moved/${planned.threadId.slice(0, 8)}`;
      const branchIntent = (await branchExists(project.canonicalRoot, wanted))
        ? `${wanted}-moved-${planned.threadId.slice(0, 8)}`
        : wanted;
      const threadId = decodeCodeThreadId(planned.threadId);
      options.holds.hold(planned);
      try {
        await options.createThread({
          threadId,
          project,
          title: moved.title,
          branchIntent,
          sourceBranch: moved.branch ?? branchIntent,
          head: received.checkout.head,
          provider,
          files: { worktree: received.checkout.worktreeTree, index: received.checkout.indexTree },
          ...(moved.externalContentIngested
            ? {
                inheritedMark: {
                  sourceLabel: "moved-thread",
                  contentReference: `moved-thread-${String(offer.moveId)}`,
                },
              }
            : {}),
        });
      } catch {
        options.holds.release(planned);
        return { status: "refused", reason: "transfer-failed" };
      }
      options.journalHistory(history);
      return rehome();
    },
    activate: async (thread) => options.holds.release(thread),
    discard: async (thread) => {
      options.holds.release(thread);
      const code = codeThreadOf(thread);
      if (code !== undefined) await options.purge(code.id);
    },
  };

  return { source, destination };
}

function sharesRepository(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  const known = new Set(left.map(normalizeRepositoryRemote).filter((value) => value !== undefined));
  return right.some((remote) => {
    const normalized = normalizeRepositoryRemote(remote);
    return normalized !== undefined && known.has(normalized);
  });
}
