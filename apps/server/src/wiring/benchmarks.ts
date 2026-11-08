import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  LOCAL_HOST_ID,
  decodeChatThreadId,
  decodeCodeCheckoutId,
  decodeCodeRelativePath,
  decodeCodeThreadId,
  decodeUtcTimestamp,
  type ChatThreadId,
  type CodeCheckoutIdentity,
  type CodeThread,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import { defaultPermissionModeFor } from "@octant/domain";
import { keepBenchmarksOutOfPersonMemory } from "../benchmarks/benchmarkMemory";
import { BenchmarkEventStore } from "../benchmarks/benchmarkEventStore";
import {
  BENCHMARKS_PROJECT_ID,
  BENCHMARKS_PROJECT_NAME,
  createBenchmarkChatPort,
} from "../benchmarks/benchmarkChatPort";
import { createBenchmarkCheckCommandPort } from "../benchmarks/benchmarkCheckCommand";
import {
  createBenchmarkCodePort,
  type BenchmarkCodeRouteService,
  type BenchmarkWorktreeRemoval,
} from "../benchmarks/benchmarkCodePort";
import { createWorkerPatternMatcher } from "../benchmarks/benchmarkPatternMatcher";
import { createBenchmarkRouteHandler } from "../benchmarks/benchmarkRoutes";
import { BenchmarkRunner } from "../benchmarks/benchmarkRunner";
import { BenchmarkService } from "../benchmarks/benchmarkService";
import { extractReply } from "../chat/threadDialogueService";
import type { CodeRouteService } from "../codeRoutes";
import type { NativeHarnessShellPort } from "../harness/nativeHarnessTools";
import type { ManagedWorktreeService } from "../code/managedWorktreeService";
import { ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import type { ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { AgentRunsWiring } from "./agentRuns";
import type { ChatWiring } from "./chat";
import type { WorkspaceWiring } from "./workspace";

/**
 * Purges one cell thread through the thread retention service. That service is
 * built after the routes that need it, so the wiring hands the routes a slot
 * the host fills once it exists; a purge asked before then fails, and the run
 * is kept.
 */
export interface BenchmarkThreadPurgeSlot {
  purge?: (threadId: string, mode: "chat" | "code") => Promise<"purged" | "absent" | "failed">;
}

export type BenchmarksDependencies = Pick<ServerStart, "persistence"> &
  Pick<AuthorityWiring, "windowAuthorityStore" | "personMemory"> &
  Pick<AgentRunsWiring, "turnMetrics"> &
  Pick<WorkspaceWiring, "projectService"> &
  Pick<ChatWiring, "chatService"> & {
    readonly threadPurge: BenchmarkThreadPurgeSlot;
    readonly routeCodeService: CodeRouteService;
    readonly codeEvidence: {
      readonly put: (text: string) => import("@octant/contracts").CodeEvidenceReference;
    };
    /** Whether a Code thread's running turn waits on an approval or a question. */
    readonly awaitsPerson: (threadId: string) => boolean;
    /** When the thread's oldest pending request was asked, from the journal; absent when unknown. */
    readonly pendingSince: (threadId: string) => Promise<string | undefined>;
    /** The confined, network-less shell Octant's own tools use; check commands run in it. */
    readonly benchmarkCheckShell: NativeHarnessShellPort;
    readonly managedWorktreeService: Pick<ManagedWorktreeService, "cleanup">;
    readonly managedWorktreeReceipts: {
      readonly load: (
        receiptId: string,
      ) => Promise<{ readonly state: string; readonly canonicalWorktreePath: string } | undefined>;
    };
    readonly roots: {
      readonly resolve: (
        windowId: WindowId,
        thread: CodeThread,
        checkout: CodeCheckoutIdentity,
        relativePath: ReturnType<typeof decodeCodeRelativePath>,
      ) =>
        | Promise<{ readonly rootPath: string } | undefined>
        | { readonly rootPath: string }
        | undefined;
    };
    readonly allowedRendererHttpOrigin?: string | null;
  };

export function wireBenchmarks(deps: BenchmarksDependencies) {
  const {
    awaitsPerson,
    pendingSince,
    codeEvidence,
    benchmarkCheckShell,
    managedWorktreeReceipts,
    managedWorktreeService,
    roots,
    routeCodeService,
    chatService,
    personMemory,
    persistence,
    projectService,
    threadPurge,
    turnMetrics,
    windowAuthorityStore,
  } = deps;
  const clock = () => new Date().toISOString();
  const store = new BenchmarkEventStore({
    journal: persistence.journal,
    connection: persistence.connection,
    uuid: randomUUID,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    clock,
  });
  const projection = persistence.benchmarkProjection;
  const chat = createBenchmarkChatPort({
    chat: {
      read: (threadId: ChatThreadId) => chatService.read(threadId),
      execute: async (command, context) => chatService.execute(command, context),
    },
    answer: (threadId, turnId) =>
      extractReply(chatService.read(decodeChatThreadId(threadId)), turnId),
  });
  // Code cells act under the host's own scope, as routines and goal rounds do.
  const codeWindowId = ROUTINE_HOST_SCOPE_ID;
  const projectMode = (projectId: ProjectId) => {
    const project = persistence.readProject(projectId);
    if (project?.type !== "code" || project.lifecycle !== "active") return undefined;
    const settings = persistence.readCodeSettings()?.settings;
    return defaultPermissionModeFor({
      project,
      settings: {
        defaultExecutionPolicy: settings?.defaultExecutionPolicy ?? "approval-gated",
        defaultAutoApprove: settings?.defaultAutoApprove,
      },
    });
  };
  const resolveRoot = async (threadId: string): Promise<string | undefined> => {
    const thread = persistence.readCodeThread(decodeCodeThreadId(threadId));
    const checkout =
      thread === undefined ? undefined : persistence.readCodeCheckout(thread.checkoutId);
    if (thread === undefined || checkout === undefined) return undefined;
    const root = await roots.resolve(
      codeWindowId,
      thread,
      checkout,
      decodeCodeRelativePath("package.json"),
    );
    return root !== undefined && existsSync(root.rootPath) ? root.rootPath : undefined;
  };
  const removeWorktree = async (
    threadId: string,
    branch: string,
  ): Promise<BenchmarkWorktreeRemoval> => {
    const thread = persistence.readCodeThread(decodeCodeThreadId(threadId));
    if (thread === undefined) return "absent";
    const checkout = persistence.readCodeCheckout(decodeCodeCheckoutId(String(thread.checkoutId)));
    if (checkout?.kind !== "managed-worktree") return "absent";
    const receiptId = String(checkout.ownershipReceiptId);
    const receipt = await managedWorktreeReceipts.load(receiptId);
    if (receipt === undefined) return "absent";
    // A receipt still "ready" whose folder is gone has nothing to clean up. One
    // that is cleanup-pending, or already removed, may still owe its branch, so
    // cleanup runs and finishes the delete.
    if (receipt.state === "ready" && !existsSync(receipt.canonicalWorktreePath)) return "absent";
    // The thread must not be active for the existing cleanup to run.
    if (thread.lifecycle === "active") {
      await routeCodeService.execute(codeWindowId, {
        kind: "change-code-thread-lifecycle",
        threadId: thread.id,
        expectedVersion: thread.version,
        lifecycle: "archived",
      });
    }
    // The existing managed-worktree cleanup, asked to discard changes. The
    // service accepts that only for this exact benchmark branch on the
    // checkout derived from its own thread, and removes only that branch.
    const result = await managedWorktreeService.cleanup(
      { receiptId, confirmedByLocalUser: true, discardChanges: { branch } },
      new AbortController().signal,
    );
    if (result.status === "removed") return "removed";
    return {
      status: "refused",
      message:
        result.status === "refused"
          ? `worktree cleanup refused it (${result.reason}).`
          : `worktree cleanup answered ${result.status}.`,
    };
  };
  const { executeOperation, conversation, readOperationContent } = routeCodeService;
  const codePort =
    executeOperation === undefined ||
    conversation === undefined ||
    readOperationContent === undefined
      ? undefined
      : createBenchmarkCodePort({
          code: {
            execute: (windowId, command) => routeCodeService.execute(windowId, command),
            executeOperation: (windowId, command) =>
              executeOperation.call(routeCodeService, windowId, command),
            conversation: (windowId, threadId, afterCursor, limit) =>
              conversation.call(routeCodeService, windowId, threadId, afterCursor, limit),
            readOperationContent: (windowId, threadId, operationId, contentId) =>
              readOperationContent.call(
                routeCodeService,
                windowId,
                threadId,
                operationId,
                contentId,
              ),
          } satisfies BenchmarkCodeRouteService,
          windowId: codeWindowId,
          readThread: (threadId) => {
            const thread = persistence.readCodeThread(decodeCodeThreadId(threadId));
            return thread === undefined
              ? undefined
              : {
                  version: thread.version,
                  checkoutId: String(thread.checkoutId),
                  lifecycle: thread.lifecycle,
                };
          },
          awaitsPerson,
          pendingSince,
          evidence: codeEvidence,
          clock: () => new Date().toISOString(),
          resolveRoot,
          removeWorktree,
        });
  const benchmarkRunner = new BenchmarkRunner({
    ...(codePort === undefined
      ? {}
      : {
          code: codePort,
          checkCommand: createBenchmarkCheckCommandPort(benchmarkCheckShell),
          projectMode,
        }),
    chat,
    projection,
    store,
    turnMetrics,
    projectId: BENCHMARKS_PROJECT_ID,
    matchPattern: createWorkerPatternMatcher(),
    clock,
  });
  const service = new BenchmarkService({
    projection,
    store,
    turnMetrics,
    runner: benchmarkRunner,
    contenderAvailable: (providerInstanceId, modelId) => {
      const instance = persistence.readProviderInstance(providerInstanceId);
      if (instance === undefined || !instance.enabled) return false;
      const catalog = persistence.readProviderCatalog?.(providerInstanceId);
      if (catalog === undefined) return true;
      return catalog.models.some((model) => String(model.id) === String(modelId));
    },
    ensureProject: async (windowId: WindowId) => {
      const existing = persistence.readProject(BENCHMARKS_PROJECT_ID);
      if (existing !== undefined) {
        return existing.type === "chat" && existing.lifecycle === "active"
          ? { status: "ready" }
          : { status: "refused", message: "The Benchmarks Project is archived or unavailable." };
      }
      // Before the Project exists, so a crash between the two steps leaves a
      // list entry for a Project that is simply made on the next start.
      const kept = keepBenchmarksOutOfPersonMemory(personMemory);
      if (kept.status === "refused") return kept;
      try {
        await projectService.executeProject(windowId, {
          kind: "create-chat-project",
          projectId: BENCHMARKS_PROJECT_ID,
          expectedVersion: 0,
          name: BENCHMARKS_PROJECT_NAME,
          hostId: LOCAL_HOST_ID,
        });
        return { status: "ready" };
      } catch (error) {
        return {
          status: "refused",
          message:
            error instanceof Error ? error.message : "The Benchmarks Project could not be created.",
        };
      }
    },
    ...(codePort === undefined
      ? {}
      : {
          codeCases: {
            projectMode,
            checkRef: (projectId, ref) => codePort.checkRef(projectId, ref),
            removeWorktree: (threadId, branch) => codePort.removeWorktree(threadId, branch),
          },
        }),
    purgeThread: async (threadId, mode) => (await threadPurge.purge?.(threadId, mode)) ?? "failed",
    clock: () => decodeUtcTimestamp(clock()),
    uuid: randomUUID,
  });
  const benchmarkRoutes = createBenchmarkRouteHandler({
    windowAuthorityStore,
    ...(deps.allowedRendererHttpOrigin === undefined
      ? {}
      : { allowedRendererHttpOrigin: deps.allowedRendererHttpOrigin }),
    service,
  });
  return { benchmarkRoutes, benchmarkRunner };
}

export type BenchmarksWiring = ReturnType<typeof wireBenchmarks>;
