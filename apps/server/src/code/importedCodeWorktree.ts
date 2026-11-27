import type { CodeCheckoutIdentity } from "@octant/contracts";
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
  | Readonly<{ status: "unavailable" }>;

export interface ImportedCodeWorktreePort {
  read(
    checkout: CodeCheckoutIdentity,
    repositoryRoot: string,
    signal: AbortSignal,
  ): Promise<ImportedCodeWorktreeReading>;
}

export function createImportedCodeWorktreePort(deps: {
  readonly loadReceipt: (receiptId: string) => Promise<ManagedWorktreeReceipt | undefined>;
  readonly repository: ManagedWorktreeRepositoryPort;
  readonly git: Pick<ManagedWorktreeGitPort, "isDirty" | "resolveBranchHead" | "listBranchNames">;
}): ImportedCodeWorktreePort {
  return {
    read: async (checkout, repositoryRoot, signal) => {
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
export type ImportedThreadContinuationRefusal = "branch-missing" | "turn-running" | "unavailable";

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
    case "turn-running":
      return "This task is already being given a worktree of its own. Send the message again in a moment.";
    case "unavailable":
      return "This task came from Octant, and Octant Nightly could not give it a worktree of its own. Check that its repository is available and send the message again.";
  }
}
