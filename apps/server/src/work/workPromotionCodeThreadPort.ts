import {
  decodeCodeThread,
  decodeCodeThreadId,
  type CodeDeliveryTarget,
  type CodeThreadId,
  type WorkArtifactRef,
  type WorkPromotionProposalId,
  type PermissionPersistence,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderModelId,
  type WindowId,
} from "@octant/contracts";
import type { CodeRouteService } from "../codeRoutes";
import type { WorkPromotionCodeThreadPort } from "./workPromotionService";

export interface CreateWorkPromotionCodeThreadPortOptions {
  readonly codeService: Pick<CodeRouteService, "execute" | "bootstrap">;
  readonly clock: () => string;
}

/**
 * Idempotent production Work promotion Code-thread port. Creates linked Code
 * threads through the ordinary authoritative Code command flow with
 * approval-gated execution policy only. Uses the promotion proposal id as the
 * Code thread id so retries and restart recovery bind to the same thread.
 * Never passes Work filesystem authority, canonical roots, or binding
 * receipts into Code thread creation.
 */
export function createWorkPromotionCodeThreadPort(
  options: CreateWorkPromotionCodeThreadPortOptions,
): WorkPromotionCodeThreadPort {
  return {
    async createApprovalGatedThread(input) {
      const threadId = decodeCodeThreadId(String(input.proposalId));
      const existing = await readThreadIfPresent(
        options.codeService,
        input.authenticatedWindowId,
        threadId,
      );
      if (existing !== undefined) {
        assertApprovalGated(existing.executionPolicy);
        return { codeThreadId: threadId };
      }

      const prepared = await options.codeService.execute(input.authenticatedWindowId, {
        kind: "prepare-code-project-checkout",
        projectId: input.targetCodeProjectId,
      });
      if (prepared.kind !== "checkout-prepared") {
        throw new Error("Code checkout could not be prepared for promotion approval.");
      }
      if (prepared.checkout.head.kind !== "branch") {
        throw new Error("Code checkout must be on a branch before promotion approval.");
      }

      const now = options.clock();
      const thread = decodeCodeThread({
        id: threadId,
        projectId: input.targetCodeProjectId,
        bindingRevisionId: prepared.bindingRevisionId,
        repositoryId: prepared.checkout.repositoryId,
        checkoutId: prepared.checkout.id,
        title: promotionThreadTitle(input.originSummary),
        lifecycle: "active",
        providerInstanceId: input.providerInstanceId,
        modelId: input.modelId,
        executionPolicy: "approval-gated",
        permissionPersistence: input.permissionPersistence,
        deliveryTarget: input.deliveryTarget,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      assertNoAuthorityLeakage(thread, input.originArtifactRefs);

      const created = await options.codeService.execute(input.authenticatedWindowId, {
        kind: "create-code-thread",
        thread,
      });
      if (created.kind !== "thread-created") {
        throw new Error("Linked Code thread could not be created.");
      }
      if (created.thread.executionPolicy !== "approval-gated") {
        throw new Error("Promoted Code thread must start approval-gated.");
      }
      return { codeThreadId: threadId };
    },
    async cancelCodeThread(input) {
      const thread = await readThreadIfPresent(
        options.codeService,
        input.authenticatedWindowId,
        input.codeThreadId,
      );
      if (thread === undefined || thread.lifecycle === "archived") return;
      await options.codeService.execute(input.authenticatedWindowId, {
        kind: "change-code-thread-lifecycle",
        threadId: input.codeThreadId,
        expectedVersion: thread.version,
        lifecycle: "archived",
      });
    },
  };
}

async function readThreadIfPresent(
  codeService: Pick<CodeRouteService, "bootstrap">,
  windowId: WindowId,
  threadId: CodeThreadId,
) {
  try {
    const bootstrap = await codeService.bootstrap(windowId);
    return bootstrap.threads.find((thread) => String(thread.id) === String(threadId));
  } catch {
    return undefined;
  }
}

function promotionThreadTitle(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.length <= 120) return trimmed;
  return `${trimmed.slice(0, 117)}...`;
}

function assertApprovalGated(policy: string): void {
  if (policy !== "approval-gated") {
    throw new Error("Promoted Code thread must remain approval-gated.");
  }
}

function assertNoAuthorityLeakage(
  thread: ReturnType<typeof decodeCodeThread>,
  artifactRefs: ReadonlyArray<WorkArtifactRef>,
): void {
  // Branch names and owner/repo delivery fields legitimately contain `/`.
  // Probe only title + artifact refs for authority markers / host paths.
  const probe = JSON.stringify({
    title: thread.title,
    artifactRefs,
    executionPolicy: thread.executionPolicy,
  });
  if (
    /file:|https?:|canonicalRoot|bindingReceipt|(?:^|[^a-z0-9])\/(?:Users|home|private|var|tmp|secret)\b/i.test(
      probe,
    )
  ) {
    throw new Error("Work promotion must not carry filesystem authority into Code.");
  }
  const repository = thread.deliveryTarget.proposedBaseRepository;
  if (/^(?:file|https?):/i.test(repository) || /^[\\/]/.test(repository)) {
    throw new Error("Work promotion must not carry filesystem authority into Code.");
  }
}

export type { WorkPromotionProposalId, CodeDeliveryTarget, ProviderInstanceId, ProviderModelId };
