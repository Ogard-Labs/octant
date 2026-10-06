import { Schema } from "effect";
import {
  decodeBindingRevisionId,
  decodeCodeCheckoutId,
  decodeCodeRepositoryId,
  ThreadCreationRootId,
  type AgentRun,
} from "@octant/contracts";
import type { CanvasWorkspaceScope } from "@octant/contracts/canvas-cards";
import {
  agentRunChildWorktreeLookup,
  resolveAgentRunChildWorktreeThreadId,
} from "../agentRun/agentRunChildWorktreePort";
import type {
  ManagedWorktreeReceipt,
  ManagedWorktreeReceiptLookup,
} from "../code/managedWorktreeReceiptStore";

/**
 * The Canvas scope a managed child may write, decided by the host.
 *
 * The model never supplies a path. Work uses the run's journaled binding,
 * re-checked against the live Project. Code uses the managed worktree the host
 * allocated for this run, found through the same receipt lookup that allocated
 * it, and only while that receipt is ready and still names the worktree the run
 * was admitted with. A child's worktree is never a journaled thread checkout,
 * so no checkout record is consulted.
 */
export interface ChildCanvasBinding {
  readonly mode: "work" | "code";
  readonly projectId: string;
  readonly workspace: CanvasWorkspaceScope;
  readonly project: {
    readonly id: string;
    readonly type: "work" | "code";
    readonly lifecycle: "active";
  };
}

export type ChildCanvasWorkspaceResolution =
  | { readonly status: "ready"; readonly binding: ChildCanvasBinding }
  | { readonly status: "refused"; readonly reason: "unresolved" | "foreign-project" };

export interface ChildCanvasProjectFacts {
  readonly id: string;
  readonly type: string;
  readonly lifecycle: string;
  readonly binding?: { readonly canonicalRoot: string };
  readonly bindingHistory?: ReadonlyArray<{ readonly revisionId: string }>;
}

export interface ChildCanvasWorkspaceHost {
  readonly readRun: (runId: string) => AgentRun | undefined;
  readonly readProject: (projectId: string) => ChildCanvasProjectFacts | undefined;
  readonly readCodeThread: (threadId: string) =>
    | {
        readonly lifecycle: string;
        readonly projectId: string;
        readonly repositoryId: string;
        readonly bindingRevisionId: string;
      }
    | undefined;
  readonly findManagedWorktreeReceipt: (
    lookup: ManagedWorktreeReceiptLookup,
  ) => Promise<ManagedWorktreeReceipt | undefined>;
}

function refused(reason: "unresolved" | "foreign-project"): ChildCanvasWorkspaceResolution {
  return { status: "refused", reason };
}

function decodeRootId(revisionId: string) {
  try {
    return Schema.decodeUnknownSync(ThreadCreationRootId)(revisionId);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Canvas workspace for one managed child from durable host state.
 *
 * A missing checkout, a stale binding, or a receipt whose worktree no longer
 * matches the run is unresolved. A Project that is not the run's own Project
 * is a foreign write. Neither case invents a scope from a path the renderer
 * could have named.
 */
export async function loadChildCanvasWorkspace(
  host: ChildCanvasWorkspaceHost,
  runId: string,
): Promise<ChildCanvasWorkspaceResolution> {
  const run = host.readRun(runId);
  if (run === undefined) return refused("unresolved");
  const receipt = run.workspaceReceipt;
  if (receipt.kind === "chat-virtual") return refused("unresolved");
  if (receipt.kind === "work-root") {
    return resolveWork(host, receipt);
  }
  return resolveCode(host, run, receipt);
}

function resolveWork(
  host: ChildCanvasWorkspaceHost,
  receipt: Extract<AgentRun["workspaceReceipt"], { readonly kind: "work-root" }>,
): ChildCanvasWorkspaceResolution {
  const project = host.readProject(String(receipt.projectId));
  if (project === undefined || String(project.id) !== String(receipt.projectId)) {
    return refused("foreign-project");
  }
  if (project.type !== "work" || project.lifecycle !== "active" || project.binding === undefined) {
    return refused("unresolved");
  }
  const revision = project.bindingHistory?.at(-1);
  if (
    revision === undefined ||
    String(revision.revisionId) !== String(receipt.bindingRevisionId) ||
    project.binding.canonicalRoot !== receipt.canonicalRoot
  ) {
    return refused("unresolved");
  }
  const rootId = decodeRootId(String(revision.revisionId));
  if (rootId === undefined) return refused("unresolved");
  return {
    status: "ready",
    binding: {
      mode: "work",
      projectId: String(receipt.projectId),
      workspace: {
        kind: "work-root",
        projectId: receipt.projectId,
        rootId,
      },
      project: { id: String(project.id), type: "work", lifecycle: "active" },
    },
  };
}

async function resolveCode(
  host: ChildCanvasWorkspaceHost,
  run: AgentRun,
  receipt: Extract<AgentRun["workspaceReceipt"], { readonly kind: "code-worktree" }>,
): Promise<ChildCanvasWorkspaceResolution> {
  if (!receipt.verified || receipt.worktreeRoot === receipt.checkoutRoot) {
    return refused("unresolved");
  }
  const project = host.readProject(String(receipt.projectId));
  if (project === undefined) return refused("unresolved");
  if (String(project.id) !== String(receipt.projectId)) return refused("foreign-project");
  if (
    project.type !== "code" ||
    project.lifecycle !== "active" ||
    project.bindingHistory === undefined
  ) {
    return refused("unresolved");
  }
  const thread = host.readCodeThread(String(run.parentThreadId));
  if (
    thread === undefined ||
    thread.lifecycle !== "active" ||
    String(thread.projectId) !== String(receipt.projectId)
  ) {
    return thread !== undefined && String(thread.projectId) !== String(receipt.projectId)
      ? refused("foreign-project")
      : refused("unresolved");
  }
  const revision = project.bindingHistory.at(-1);
  if (revision === undefined || String(revision.revisionId) !== String(thread.bindingRevisionId)) {
    return refused("unresolved");
  }
  if (project.binding === undefined || project.binding.canonicalRoot !== receipt.checkoutRoot) {
    return refused("unresolved");
  }
  let repositoryId: string;
  let lookup: ManagedWorktreeReceiptLookup;
  try {
    repositoryId = String(decodeCodeRepositoryId(thread.repositoryId));
    decodeBindingRevisionId(String(thread.bindingRevisionId));
    const childThreadId = resolveAgentRunChildWorktreeThreadId({
      parentThreadId: String(run.parentThreadId),
      requestId: String(run.requestId),
      repositoryId,
      workspace: receipt,
    });
    if (childThreadId === undefined) return refused("unresolved");
    lookup = agentRunChildWorktreeLookup({
      repositoryId,
      repositoryRoot: receipt.checkoutRoot,
      childThreadId: String(childThreadId),
    });
    decodeCodeCheckoutId(lookup.checkoutId);
  } catch {
    return refused("unresolved");
  }
  let managed: ManagedWorktreeReceipt | undefined;
  try {
    managed = await host.findManagedWorktreeReceipt(lookup);
  } catch {
    return refused("unresolved");
  }
  if (
    managed === undefined ||
    managed.state !== "ready" ||
    managed.canonicalWorktreePath !== receipt.worktreeRoot ||
    managed.canonicalRepositoryPath !== receipt.checkoutRoot ||
    managed.checkoutId !== lookup.checkoutId ||
    managed.repositoryId !== repositoryId
  ) {
    return refused("unresolved");
  }
  const checkoutId = lookup.checkoutId;
  return {
    status: "ready",
    binding: {
      mode: "code",
      projectId: String(receipt.projectId),
      workspace: {
        kind: "code-worktree",
        projectId: receipt.projectId,
        repositoryId: decodeCodeRepositoryId(repositoryId),
        bindingRevisionId: decodeBindingRevisionId(String(thread.bindingRevisionId)),
        checkoutId: decodeCodeCheckoutId(checkoutId),
        verified: true,
      },
      project: { id: String(project.id), type: "code", lifecycle: "active" },
    },
  };
}
