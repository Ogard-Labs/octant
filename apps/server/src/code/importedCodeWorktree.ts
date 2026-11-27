import {
  CODE_THREAD_MOVED_TO_WORKTREE,
  decodeCodeThreadMovedToWorktree,
  decodeOctantImportRecorded,
  OCTANT_IMPORT_AGGREGATE_ID,
  OCTANT_IMPORT_AGGREGATE_TYPE,
  OCTANT_IMPORT_RECORDED,
  type CodeCheckoutIdentity,
} from "@octant/contracts";
import type { Journal } from "../persistence/journal";
import { branchNameTaken, isValidBranchName } from "@octant/domain/code-worktree-naming";
import { isImportedReceipt, type ManagedWorktreeReceipt } from "./managedWorktreeReceiptStore";
import type {
  ManagedWorktreeGitPort,
  ManagedWorktreeRepositoryPort,
} from "./managedWorktreeService";

/**
 * What a Code thread imported from Octant has to continue from: Octant's
 * worktree as it stands, or, once that folder is gone, the branch it was on.
 * Everything here only reads. Octant's folder is Octant's checkout, so its
 * status is read with Git's optional locks off and nothing is written there
 * (docs/design/nightly-app.md#importing-from-octant).
 */
export type ImportedCodeWorktreeReading =
  /** The checkout is not a worktree imported from Octant. */
  | Readonly<{ status: "own" }>
  | Readonly<{
      status: "imported";
      /** The branch the new branch is named after. */
      sourceBranch: string;
      /** The commit the new worktree starts at; absent when the branch is gone too. */
      head?: string;
      octantFolder: "clean" | "uncommitted-changes-left" | "unread" | "missing";
      /** Names the new branch must not take; empty when they could not all be read. */
      takenBranchNames: ReadonlyArray<string>;
    }>
  /** The thread works in a folder that is not a Git repository: no worktree can be made. */
  | Readonly<{ status: "not-a-repository" }>
  | Readonly<{ status: "unavailable" }>;

/**
 * Which Code threads came from Octant and have not yet moved onto a worktree
 * of this host's own. A thread on a checkout both apps reach (the Project's
 * own folder) has no receipt to say so, so the import's own record does.
 */
export interface ImportedCodeThreadProvenance {
  awaitsOwnWorktree(threadId: string): boolean;
}

export interface ImportedCodeWorktreePort {
  /**
   * Whether the checkout is a worktree imported from Octant, from its receipt
   * alone. A receipt that cannot be read is not taken as imported: the turn's
   * own checks then decide, as for any thread of this host.
   */
  isImported(checkout: CodeCheckoutIdentity): Promise<boolean>;
  /**
   * What to continue from. A managed worktree is read only when its receipt
   * says it came from Octant; a shared checkout (the Project's own folder, or
   * a plain folder) is read as it stands, since only the caller knows from
   * the import's record that its thread came from Octant. `fallbackBranch`
   * names the new branch when that folder's HEAD is detached.
   */
  read(
    checkout: CodeCheckoutIdentity,
    repositoryRoot: string,
    signal: AbortSignal,
    fallbackBranch?: string,
  ): Promise<ImportedCodeWorktreeReading>;
}

export function createImportedCodeWorktreePort(deps: {
  readonly loadReceipt: (receiptId: string) => Promise<ManagedWorktreeReceipt | undefined>;
  readonly repository: ManagedWorktreeRepositoryPort;
  readonly git: Pick<ManagedWorktreeGitPort, "isDirty" | "resolveBranchHead" | "listBranchNames">;
}): ImportedCodeWorktreePort {
  return {
    isImported: async (checkout) => {
      if (checkout.kind !== "managed-worktree") return false;
      try {
        const receipt = await deps.loadReceipt(String(checkout.ownershipReceiptId));
        return receipt !== undefined && isImportedReceipt(receipt);
      } catch {
        return false;
      }
    },
    read: async (checkout, repositoryRoot, signal, fallbackBranch) => {
      if (checkout.kind === "existing-worktree" || checkout.kind === "plain-folder") {
        return readSharedCheckout(deps, checkout, repositoryRoot, signal, fallbackBranch);
      }
      if (checkout.kind !== "managed-worktree") return { status: "own" };
      let receipt: ManagedWorktreeReceipt | undefined;
      try {
        receipt = await deps.loadReceipt(String(checkout.ownershipReceiptId));
      } catch {
        return { status: "unavailable" };
      }
      if (receipt === undefined || !isImportedReceipt(receipt)) return { status: "own" };
      if (
        receipt.checkoutId !== String(checkout.id) ||
        receipt.canonicalRepositoryPath !== repositoryRoot
      ) {
        return { status: "unavailable" };
      }
      try {
        const observation = await deps.repository.observe(repositoryRoot, signal);
        if (
          observation.status !== "available" ||
          observation.repositoryId !== receipt.repositoryId ||
          observation.repositoryRoot !== repositoryRoot
        ) {
          return { status: "unavailable" };
        }
        const names = await deps.git.listBranchNames?.(repositoryRoot, signal);
        const takenBranchNames =
          names?.status === "observed" && !names.truncated ? names.names : [];
        const recordedBranch = receipt.currentBranch ?? receipt.branchIntent;
        const present = observation.worktrees.find(
          (worktree) =>
            worktree.status === "present" &&
            worktree.canonicalPath === receipt.canonicalWorktreePath,
        );
        if (present !== undefined) {
          const dirty = await deps.git.isDirty(receipt.canonicalWorktreePath, signal);
          return {
            status: "imported",
            sourceBranch: branchOfRef(present.branch) ?? recordedBranch,
            head: present.head,
            octantFolder:
              dirty.status !== "observed"
                ? "unread"
                : dirty.dirty
                  ? "uncommitted-changes-left"
                  : "clean",
            takenBranchNames,
          };
        }
        const branch = await deps.git.resolveBranchHead?.(
          { repositoryRoot, branch: recordedBranch },
          signal,
        );
        if (branch === undefined || branch.status !== "observed") return { status: "unavailable" };
        return {
          status: "imported",
          sourceBranch: recordedBranch,
          ...(branch.head === undefined ? {} : { head: branch.head }),
          octantFolder: "missing",
          takenBranchNames,
        };
      } catch {
        return { status: "unavailable" };
      }
    },
  };
}

/**
 * The folder a thread shares with Octant, read and never written: its
 * commit and branch from Git's worktree list, and whether it holds changes
 * with Git's optional locks off.
 */
async function readSharedCheckout(
  deps: Parameters<typeof createImportedCodeWorktreePort>[0],
  checkout: CodeCheckoutIdentity,
  repositoryRoot: string,
  signal: AbortSignal,
  fallbackBranch: string | undefined,
): Promise<ImportedCodeWorktreeReading> {
  try {
    const observation = await deps.repository.observe(repositoryRoot, signal);
    if (observation.status === "unavailable" && observation.reason === "not-repository") {
      return { status: "not-a-repository" };
    }
    if (
      observation.status !== "available" ||
      observation.repositoryRoot !== repositoryRoot ||
      (checkout.kind === "existing-worktree" &&
        observation.repositoryId !== String(checkout.repositoryId))
    ) {
      return checkout.kind === "plain-folder"
        ? { status: "not-a-repository" }
        : { status: "unavailable" };
    }
    const sourceBranch = branchOfRef(observation.checkout.branch) ?? fallbackBranch;
    if (sourceBranch === undefined) return { status: "unavailable" };
    const names = await deps.git.listBranchNames?.(repositoryRoot, signal);
    const dirty = await deps.git.isDirty(repositoryRoot, signal);
    return {
      status: "imported",
      sourceBranch,
      head: observation.checkout.head,
      octantFolder:
        dirty.status !== "observed" ? "unread" : dirty.dirty ? "uncommitted-changes-left" : "clean",
      takenBranchNames: names?.status === "observed" && !names.truncated ? names.names : [],
    };
  } catch {
    return { status: "unavailable" };
  }
}

function branchOfRef(ref: string | undefined): string | undefined {
  return ref?.startsWith("refs/heads/") === true ? ref.slice("refs/heads/".length) : undefined;
}

/**
 * The branch a continued thread gets: the one it was on in Octant, with
 * `-nightly` after it (and a number when that is taken), so the person can
 * tell which app's work is on which branch. Undefined when no such name is
 * free or valid.
 */
export function continuationBranchName(
  sourceBranch: string,
  taken: ReadonlyArray<string>,
): string | undefined {
  const known = [sourceBranch, ...taken];
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const candidate = `${sourceBranch}-nightly${attempt === 1 ? "" : `-${attempt}`}`;
    if (!isValidBranchName(candidate)) return undefined;
    if (!branchNameTaken(candidate, known)) return candidate;
  }
  return undefined;
}

/** Why an imported thread's turn did not start; each is an expected answer. */
export type ImportedThreadContinuationRefusal =
  | "branch-missing"
  | "not-a-repository"
  | "working-folder"
  | "turn-running"
  | "unavailable";

/** What preparing an imported thread's first turn here did. */
export type ImportedThreadContinuation =
  /** Nothing to do: the thread is not on a worktree imported from Octant. */
  | Readonly<{ status: "own" }>
  | Readonly<{ status: "continued"; checkoutId: CodeCheckoutIdentity["id"] }>
  | Readonly<{ status: "refused"; reason: ImportedThreadContinuationRefusal }>;

export function importedThreadContinuationMessage(
  reason: ImportedThreadContinuationRefusal,
): string {
  switch (reason) {
    case "branch-missing":
      return "This task came from Octant, and its worktree and branch there are both gone, so Octant Nightly has nothing to continue it from.";
    case "not-a-repository":
      return "This task came from Octant and works in a folder that is not a Git repository, so Octant Nightly cannot give it a worktree of its own. Continue it in Octant, or start a new task here.";
    case "working-folder":
      return "This task came from Octant and works in another of the Project's folders, so Octant Nightly cannot give it a worktree of its own. Continue it in Octant, or start a new task here.";
    case "turn-running":
      return "This task is already being given a worktree of its own. Send the message again in a moment.";
    case "unavailable":
      return "This task came from Octant, and Octant Nightly could not give it a worktree of its own. Check that its repository is available and send the message again.";
  }
}

/**
 * Reads which Code threads came from Octant from the import's own records,
 * and whether each has since left for a worktree of this host's own (its move
 * record says `fromOctant`). Read on each turn start, so the answer follows
 * the journal without a cache to keep current.
 */
export function createImportedCodeThreadProvenance(
  journal: Pick<Journal, "replayAggregate" | "replayAggregateType">,
): ImportedCodeThreadProvenance {
  return {
    awaitsOwnWorktree: (threadId) => {
      let imported = false;
      for (let afterVersion = 0; !imported;) {
        const page = journal.replayAggregate({
          aggregateType: OCTANT_IMPORT_AGGREGATE_TYPE,
          aggregateId: OCTANT_IMPORT_AGGREGATE_ID,
          afterVersion,
          limit: 100,
        });
        for (const envelope of page) {
          afterVersion = envelope.aggregateVersion;
          if (envelope.eventName !== OCTANT_IMPORT_RECORDED) continue;
          try {
            if (decodeOctantImportRecorded(envelope.payload).codeThreadIds?.includes(threadId)) {
              imported = true;
            }
          } catch {
            // A record this host cannot read names no thread.
          }
        }
        if (page.length < 100) break;
      }
      if (!imported) return false;
      const moves = journal.replayAggregateType({
        aggregateType: "code-thread",
        eventName: CODE_THREAD_MOVED_TO_WORKTREE,
        payloadPrefix: { path: "threadId", prefix: threadId },
        afterSequence: 0,
        limit: 8,
      });
      return !moves.some((envelope) => {
        try {
          const moved = decodeCodeThreadMovedToWorktree(envelope.payload);
          return String(moved.threadId) === threadId && moved.fromOctant !== undefined;
        } catch {
          return false;
        }
      });
    },
  };
}
