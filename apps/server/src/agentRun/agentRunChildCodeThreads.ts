import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import {
  decodeCodeCheckoutId,
  decodeCodeThreadId,
  decodeWorktreeReceiptId,
  type CodeCheckoutId,
  type CodeCheckoutIdentity,
  type CodeFileId,
  type CodeRelativePath,
  type CodeThread,
  type CodeThreadId,
} from "@octant/contracts";
import type { CodeFileRootResolution } from "../code/codeService";
import type { AgentRunChildToolHost } from "./agentRunChildTools";
import {
  agentRunChildWorktreeLookup,
  deriveAgentRunChildWorktreeThreadId,
} from "./agentRunChildWorktreePort";

/** A Code child as the Code services see it: its own thread, in its own worktree. */
export interface AgentRunChildCodeThread {
  readonly thread: CodeThread;
  readonly checkout: CodeCheckoutIdentity;
  readonly folder: string;
}

/** A checkout id no thread or child is ever given. */
const UNREACHABLE_CHECKOUT = decodeCodeCheckoutId("00000000-0000-4000-8000-000000000000");

/** The services only carry a managed checkout's receipt id; the worktree itself is proven per call. */
function receiptIdOf(runId: string): string {
  const digest = createHash("sha256").update(`octant.child-receipt.v1\0${runId}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export interface AgentRunChildCodeThreadsOptions {
  readonly readThread: (threadId: CodeThreadId) => CodeThread | undefined;
  readonly readCheckout: (checkoutId: CodeCheckoutId) => CodeCheckoutIdentity | undefined;
  /** Proves the worktree is still the one the run recorded, as the child's own start does. */
  readonly verifiedHead: (
    host: AgentRunChildToolHost,
    parent: CodeThread,
  ) => Promise<string | undefined>;
  readonly fileId: (threadId: string, checkoutId: string, path: string) => CodeFileId;
}

/**
 * Code children, as threads the Code services can read.
 *
 * The language, debug and device services authorize a Code thread and its
 * checkout by id. A child run is neither: without this, a child's call could
 * only name its parent's thread, and would act in its parent's checkout. Each
 * child gets an in-memory thread under its own run id, in its own worktree,
 * at its own level. It is never stored or listed, it reads as absent the
 * moment the child no longer holds its grant, and only a child's own tools
 * are ever given its id.
 */
export class AgentRunChildCodeThreads {
  readonly #options: AgentRunChildCodeThreadsOptions;
  readonly #held = new Map<string, { readonly host: AgentRunChildToolHost; holders: number }>();

  constructor(options: AgentRunChildCodeThreadsOptions) {
    this.#options = options;
  }

  /** The child's thread now; undefined outside Code, or once its grant or its parent is gone. */
  read(host: AgentRunChildToolHost): AgentRunChildCodeThread | undefined {
    if (host.run.workspaceReceipt.kind !== "code-worktree" || host.folder === undefined)
      return undefined;
    const parent = this.#options.readThread(decodeCodeThreadId(host.parentThreadId));
    const checkout =
      parent === undefined ? undefined : this.#options.readCheckout(parent.checkoutId);
    if (
      parent === undefined ||
      parent.lifecycle !== "active" ||
      parent.completedAt !== undefined ||
      String(parent.projectId) !== String(host.projectId) ||
      checkout === undefined ||
      checkout.availability !== "available" ||
      checkout.kind === "remote-root" ||
      checkout.head.kind === "none"
    )
      return undefined;
    const checkoutId = decodeCodeCheckoutId(
      agentRunChildWorktreeLookup({
        repositoryId: String(parent.repositoryId),
        repositoryRoot: host.run.workspaceReceipt.checkoutRoot,
        childThreadId: deriveAgentRunChildWorktreeThreadId(
          host.parentThreadId,
          String(host.run.requestId),
        ),
      }).checkoutId,
    );
    const { fullAccessSandbox: _sandbox, workingFolderId: _folder, ...shared } = parent;
    return {
      thread: {
        ...shared,
        id: decodeCodeThreadId(host.runId),
        checkoutId,
        providerInstanceId: host.target.providerInstanceId,
        modelId: host.target.modelId,
        executionPolicy: host.executionPolicy,
        permissionPersistence: host.authority.permissionPersistence,
      },
      checkout: {
        id: checkoutId,
        repositoryId: parent.repositoryId,
        kind: "managed-worktree",
        availability: "available",
        head: checkout.head,
        ownershipReceiptId: decodeWorktreeReceiptId(receiptIdOf(host.runId)),
        observedAt: checkout.observedAt,
      },
      folder: host.folder,
    };
  }

  /** Makes the child readable by its own ids until released; each tool set holds its own. */
  hold(host: AgentRunChildToolHost): () => void {
    const held = this.#held.get(host.runId);
    if (held === undefined) this.#held.set(host.runId, { host, holders: 1 });
    else held.holders += 1;
    let released = false;
    return () => {
      const entry = this.#held.get(host.runId);
      if (released || entry === undefined) return;
      released = true;
      entry.holders -= 1;
      if (entry.holders === 0) this.#held.delete(host.runId);
    };
  }

  #live(threadId: string): AgentRunChildCodeThread | undefined {
    const host = this.#held.get(threadId)?.host;
    return host === undefined || !host.current() ? undefined : this.read(host);
  }

  readonly readThread = (threadId: CodeThreadId): CodeThread | undefined =>
    this.#live(String(threadId))?.thread;

  readonly readThreads = (): ReadonlyArray<CodeThread> =>
    [...this.#held.keys()].flatMap((id) => {
      const child = this.#live(id);
      return child === undefined ? [] : [child.thread];
    });

  readonly readCheckout = (checkoutId: CodeCheckoutId): CodeCheckoutIdentity | undefined => {
    for (const id of this.#held.keys()) {
      const child = this.#live(id);
      if (child !== undefined && String(child.checkout.id) === String(checkoutId))
        return child.checkout;
    }
    return undefined;
  };

  /**
   * The child's thread as a caller sees it: as itself only for the window the
   * child's run belongs to, which is the one its tools call with. Any other
   * caller (another window's route naming the run's id) gets a thread whose
   * checkout no request can name, so every read and start is refused.
   */
  readonly effectiveFor = (scopeId: string, thread: CodeThread): CodeThread => {
    const host = this.#held.get(String(thread.id))?.host;
    return host !== undefined && String(host.window() ?? "") === scopeId
      ? thread
      : { ...thread, executionPolicy: "plan", checkoutId: UNREACHABLE_CHECKOUT };
  };

  /** The parent whose Strict value, egress rules and marks also hold for this child. */
  readonly parentOf = (threadId: string): string | undefined =>
    this.#held.get(threadId)?.host.parentThreadId;

  /** The child's own folder, host-read. */
  readonly folderOf = (threadId: string): string | undefined => this.#live(threadId)?.folder;

  /** The worktree, proven to be the one the run recorded; undefined refuses. */
  readonly resolveRoot = async (
    thread: CodeThread,
    path: CodeRelativePath,
  ): Promise<CodeFileRootResolution | undefined> => {
    const host = this.#held.get(String(thread.id))?.host;
    const child = host === undefined ? undefined : this.#live(host.runId);
    if (host === undefined || child === undefined || String(path).startsWith("/")) return undefined;
    const parent = this.#options.readThread(decodeCodeThreadId(host.parentThreadId));
    if (parent === undefined || (await this.#options.verifiedHead(host, parent)) === undefined)
      return undefined;
    try {
      const metadata = await lstat(child.folder, { bigint: true });
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        (await realpath(child.folder)) !== child.folder
      )
        return undefined;
      return {
        fileId: this.#options.fileId(String(thread.id), String(child.checkout.id), String(path)),
        rootPath: child.folder,
        rootIdentity: {
          device: metadata.dev.toString(10),
          inode: metadata.ino.toString(10),
        },
        current: () => host.current(),
      };
    } catch {
      return undefined;
    }
  };

  /** The commit the child's worktree stands on, proven now. */
  async head(threadId: string): Promise<string | undefined> {
    const host = this.#held.get(threadId)?.host;
    const parent =
      host === undefined
        ? undefined
        : this.#options.readThread(decodeCodeThreadId(host.parentThreadId));
    return host === undefined || parent === undefined || !host.current()
      ? undefined
      : await this.#options.verifiedHead(host, parent);
  }
}
