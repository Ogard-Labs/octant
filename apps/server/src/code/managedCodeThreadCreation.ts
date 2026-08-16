import { createHash } from "node:crypto";
import { decodeCodeCheckoutId, decodeCodeRepositoryId, type Project } from "@octant/contracts";
import type {
  ManagedCodeThreadCleanupOutcome,
  ManagedCodeThreadCommitOutcome,
  ManagedCodeThreadCreationInput,
  ManagedCodeThreadCreationPort,
  ManagedCodeThreadPrepareOutcome,
  ManagedCodeThreadPreparation,
} from "./codeService";
import type {
  ManagedWorktreeRepositoryPort,
  ManagedWorktreeService,
} from "./managedWorktreeService";

export interface ManagedCodeThreadCreationDeps {
  readonly readProject: (
    projectId: ManagedCodeThreadCreationInput["projectId"],
  ) => Project | undefined;
  readonly service: ManagedWorktreeService;
  readonly repository: ManagedWorktreeRepositoryPort;
  readonly clock: () => string;
}

export function deriveManagedWorktreeCheckoutId(input: {
  readonly repositoryId: string;
  readonly threadId: string;
}) {
  const digest = createHash("sha256")
    .update("octant.managed-worktree-checkout.v1\0")
    .update(input.repositoryId)
    .update("\0")
    .update(input.threadId)
    .digest("hex")
    .slice(0, 32);
  return decodeCodeCheckoutId(
    `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`,
  );
}

function resolveBindingRoot(
  deps: ManagedCodeThreadCreationDeps,
  input: ManagedCodeThreadCreationInput,
): string | undefined {
  const project = deps.readProject(input.projectId);
  if (project?.type !== "code") return undefined;
  const revision = project.bindingHistory.at(-1);
  if (revision === undefined || revision.revisionId !== input.bindingRevisionId) return undefined;
  return project.binding.canonicalRoot;
}

/**
 * Authorized managed-worktree Code thread creation reachable through the common
 * Code command path (window capability), not the desktop-only bridge.
 *
 * The port is deliberately two-phase so the command handler can run every
 * decidable authorization before any mutation:
 * - `prepare` resolves the exact source object ID (fetching remote-tracking refs
 *   only) and derives the managed checkout context, without creating a grant,
 *   receipt, or worktree.
 * - `commit` plans the grant, creates the worktree on the confirmed delivery
 *   branch from the resolved source, and confirms the exact HEAD.
 * - `cleanup` rolls back a created-but-unbound worktree.
 *
 * The user's existing checkout, index, working tree, and local branch refs are
 * never mutated.
 */
export function createManagedCodeThreadCreationPort(
  deps: ManagedCodeThreadCreationDeps,
): ManagedCodeThreadCreationPort {
  return {
    prepare: async (
      input: ManagedCodeThreadCreationInput,
      signal: AbortSignal,
    ): Promise<ManagedCodeThreadPrepareOutcome> => {
      const repositoryRoot = resolveBindingRoot(deps, input);
      if (repositoryRoot === undefined) return { status: "refused", reason: "repository-mismatch" };
      let observation;
      try {
        observation = await deps.repository.observe(repositoryRoot, signal);
      } catch {
        return { status: "waiting" };
      }
      if (observation.status !== "available" || observation.repositoryRoot !== repositoryRoot) {
        return { status: "waiting" };
      }
      const repositoryId = decodeCodeRepositoryId(observation.repositoryId);
      const preview = await deps.service.previewSource(
        {
          repositoryId,
          repositoryRoot,
          refIntent: `refs/heads/${input.sourceBranch}`,
          startFromOrigin: input.startFromOrigin,
          ...(input.remoteName === undefined ? {} : { remoteName: input.remoteName }),
        },
        signal,
      );
      if (preview.status === "failed") {
        if (preview.reason === "cancelled") return { status: "interrupted" };
        if (preview.reason === "unavailable" || preview.reason === "fetch-rejected") {
          return { status: "refused", reason: "fetch-rejected" };
        }
        return {
          status: "refused",
          reason: preview.reason === "ambiguous-ref" ? "ref-ambiguous" : preview.reason,
        };
      }
      const preparation: ManagedCodeThreadPreparation = {
        repositoryId,
        checkoutId: deriveManagedWorktreeCheckoutId({
          repositoryId: String(repositoryId),
          threadId: String(input.threadId),
        }),
        branchIntent: input.branchIntent,
        resolvedHead: preview.resolvedHead,
        mode: preview.status,
        sourceBranch: input.sourceBranch,
        ...(preview.remoteName === undefined ? {} : { remoteName: preview.remoteName }),
        ...(preview.status === "origin" ? { fetchedAt: preview.fetchedAt } : {}),
      };
      return { status: "prepared", preparation };
    },

    commit: async (
      input: ManagedCodeThreadCreationInput,
      preparation: ManagedCodeThreadPreparation,
      signal: AbortSignal,
    ): Promise<ManagedCodeThreadCommitOutcome> => {
      const repositoryRoot = resolveBindingRoot(deps, input);
      if (repositoryRoot === undefined) return { status: "refused", reason: "repository-mismatch" };
      const creationInput = {
        authenticatedWindowId: input.authenticatedWindowId,
        projectId: input.projectId,
        bindingRevisionId: input.bindingRevisionId,
        repositoryId: preparation.repositoryId,
        repositoryRoot,
        threadId: input.threadId,
        checkoutId: preparation.checkoutId,
        branchIntent: preparation.branchIntent,
        startPoint: preparation.resolvedHead,
        startFromOrigin: input.startFromOrigin,
        sourceBranch: preparation.sourceBranch,
        sourceMode: preparation.mode,
        ...(preparation.remoteName === undefined ? {} : { remoteName: preparation.remoteName }),
        ...(preparation.fetchedAt === undefined ? {} : { fetchedAt: preparation.fetchedAt }),
      };
      const plan = await deps.service.planCreation(creationInput, signal);
      if (plan.status !== "planned") {
        return plan.status === "refused"
          ? { status: "refused", reason: plan.reason }
          : { status: plan.status === "unavailable" ? "waiting" : plan.status };
      }
      const created = await deps.service.create(
        { ...creationInput, grantId: plan.grant.grantId },
        signal,
      );
      if (created.status !== "ready") {
        const partialReceipt = "receipt" in created ? created.receipt : undefined;
        if (partialReceipt !== undefined) {
          await deps.service
            .rollbackCreation(partialReceipt.receiptId, new AbortController().signal)
            .catch(() => undefined);
        }
        return created.status === "refused"
          ? { status: "refused", reason: created.reason }
          : { status: created.status };
      }
      return {
        status: "created",
        receiptId: created.receipt.receiptId,
        expectedHead: created.receipt.expectedHead,
      };
    },

    cleanup: async (
      cleanupInput: Readonly<{ receiptId: string }>,
      signal: AbortSignal,
    ): Promise<ManagedCodeThreadCleanupOutcome> => {
      return deps.service.rollbackCreation(cleanupInput.receiptId, signal);
    },
  };
}
