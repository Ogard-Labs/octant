import type { CodeCheckoutIdentity, CodeThread, CodeThreadId, Project } from "@octant/contracts";
import type { ManagedWorktreeReceipt } from "../code/managedWorktreeReceiptStore";

/** A source folder comes from the Project and its current owned checkout, never a client path. */
export async function eligibleTerminalSessionFolders(input: {
  readonly project: Project | undefined;
  readonly projectFolder: string;
  readonly threads: ReadonlyArray<CodeThread>;
  readonly readCheckout: (threadId: CodeThreadId) => CodeCheckoutIdentity | undefined;
  readonly loadReceipt: (receiptId: string) => Promise<ManagedWorktreeReceipt | undefined>;
}): Promise<ReadonlyArray<string>> {
  const project = input.project;
  if (
    project?.type !== "code" ||
    project.lifecycle !== "active" ||
    project.binding.canonicalRoot !== input.projectFolder
  )
    return [];
  const revision = project.bindingHistory.at(-1)?.revisionId;
  if (revision === undefined) return [];
  const folders: string[] = [];
  for (const thread of input.threads
    .filter(
      (item) =>
        String(item.projectId) === String(project.id) && item.bindingRevisionId === revision,
    )
    .slice(0, 64)) {
    const checkout = input.readCheckout(thread.id);
    if (checkout?.kind !== "managed-worktree" || checkout.availability !== "available") continue;
    const receipt = await input.loadReceipt(String(checkout.ownershipReceiptId));
    if (
      receipt?.state === "ready" &&
      receipt.receiptId === String(checkout.ownershipReceiptId) &&
      receipt.threadId === String(thread.id) &&
      receipt.checkoutId === String(checkout.id) &&
      receipt.repositoryId === String(checkout.repositoryId) &&
      receipt.repositoryId === String(thread.repositoryId) &&
      receipt.canonicalRepositoryPath === input.projectFolder
    )
      folders.push(receipt.canonicalWorktreePath);
  }
  return folders;
}
