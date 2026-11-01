import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  decodeCodeCheckoutId,
  decodeCodeCheckoutIdentity,
  decodeCodeRepositoryId,
  type CodeCheckoutIdentity,
  type CodeThread,
} from "@octant/contracts/code";
import { decodeBindingRevisionId, type BindingRevisionId } from "@octant/contracts/projects";
import type { ServerProject } from "@octant/contracts/server-projects";
import type { WindowId } from "@octant/contracts/shell";
import type { CodeCheckoutObservationPort } from "../code/codeService";
import type { NativeHarnessComposition } from "../harness/nativeHarnessComposition";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { ServerConnection } from "./serverConnection";
import { ServerFileSystem } from "./serverFiles";
import type { ServerProjectStore } from "./serverProjectStore";
import { createServerShell, type ServerShellOptions } from "./serverShell";

/**
 * Code threads in a server Project. Canonical: docs/design/server-projects.md
 * § Threads.
 *
 * A server Project's thread is an ordinary Code thread on this host's journal
 * whose checkout is a `remote-root` derived from the Project alone, under
 * labels of its own, so it never names a checkout of the retired SSH target
 * build and no local Files, Git, terminal, test, or checkpoint path resolves
 * it. A turn runs only on the Octant Harness, whose inference stays here and
 * whose file tools and shell are on the server; every other runtime is
 * refused before anything launches, because its own tools act on this
 * host's files.
 */

export interface ServerCodeCheckout {
  readonly bindingRevisionId: BindingRevisionId;
  readonly checkout: Extract<CodeCheckoutIdentity, { readonly kind: "remote-root" }>;
}

function digest(label: string, project: ServerProject, threadId?: string): string {
  const hash = createHash("sha256")
    .update(`${label}\0`)
    .update(String(project.id))
    .update("\0")
    .update(String(project.serverId))
    .update("\0")
    .update(project.folder);
  if (threadId !== undefined) hash.update("\0").update(threadId);
  return hash.digest("hex");
}

function digestUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function serverCodeCheckout(project: ServerProject): ServerCodeCheckout {
  const checkout = decodeCodeCheckoutIdentity({
    id: decodeCodeCheckoutId(digestUuid(digest("octant.server-project-checkout.v1", project))),
    repositoryId: decodeCodeRepositoryId(
      `repo_${digest("octant.server-project-repository.v1", project)}`,
    ),
    kind: "remote-root",
    availability: "available",
    head: { kind: "none" },
    observedAt: project.boundAt,
  });
  if (checkout.kind !== "remote-root") throw new Error("A server checkout decoded as local.");
  return {
    bindingRevisionId: decodeBindingRevisionId(
      digestUuid(digest("octant.server-project-binding.v1", project)),
    ),
    checkout,
  };
}

/**
 * Where a thread's own worktree lives on the server: beside the Project's
 * folder, as a local managed worktree lives beside its repository, under the
 * Project's repository and the thread. Derived from the Project and thread
 * alone, so no path is ever read back from a record.
 */
export function serverWorktreeFolder(project: ServerProject, threadId: string): string {
  const repositoryId = String(serverCodeCheckout(project).checkout.repositoryId);
  return posix.join(posix.dirname(project.folder), ".octant-worktrees", repositoryId, threadId);
}

/**
 * The checkout of a thread that works in its own worktree on the server. Like
 * the Project's own, it is a `remote-root`, so every host-side path keeps
 * refusing it; its id is a digest of the Project and the thread under a label
 * of its own.
 */
export function serverWorktreeCheckout(
  project: ServerProject,
  threadId: string,
  observedAt: string,
): ServerCodeCheckout {
  const derived = serverCodeCheckout(project);
  const checkout = decodeCodeCheckoutIdentity({
    id: decodeCodeCheckoutId(
      digestUuid(digest("octant.server-project-worktree-checkout.v1", project, threadId)),
    ),
    repositoryId: derived.checkout.repositoryId,
    kind: "remote-root",
    availability: "available",
    head: { kind: "none" },
    observedAt,
  });
  if (checkout.kind !== "remote-root") throw new Error("A server checkout decoded as local.");
  return { bindingRevisionId: derived.bindingRevisionId, checkout };
}

/** The receipt id a thread's server worktree is recorded under. */
export function serverWorktreeReceiptId(project: ServerProject, threadId: string): string {
  return digestUuid(digest("octant.server-project-worktree-receipt.v1", project, threadId));
}

export interface ServerThreadPlace {
  readonly project: ServerProject;
  /** The folder on the server the thread's hands act in. */
  readonly folder: string;
}

/**
 * The server Project a thread runs in and the folder it works in there: the
 * Project's own folder, or the thread's own worktree. Only a thread whose
 * binding, repository, and checkout are exactly the ones the Project derives
 * has one.
 */
export function serverThreadOf(
  store: Pick<ServerProjectStore, "project">,
  thread: Pick<
    CodeThread,
    "id" | "projectId" | "bindingRevisionId" | "repositoryId" | "checkoutId"
  >,
): ServerThreadPlace | undefined {
  const project = store.project(String(thread.projectId));
  if (project === undefined) return undefined;
  const derived = serverCodeCheckout(project);
  if (
    String(derived.bindingRevisionId) !== String(thread.bindingRevisionId) ||
    String(derived.checkout.repositoryId) !== String(thread.repositoryId)
  ) {
    return undefined;
  }
  if (String(derived.checkout.id) === String(thread.checkoutId)) {
    return { project, folder: project.folder };
  }
  const worktree = serverWorktreeCheckout(project, String(thread.id), project.boundAt);
  return String(worktree.checkout.id) === String(thread.checkoutId)
    ? { project, folder: serverWorktreeFolder(project, String(thread.id)) }
    : undefined;
}

/**
 * The server Project a thread runs in, when the thread's binding, repository,
 * and checkout are exactly the ones that Project derives.
 */
export function serverProjectOf(
  store: Pick<ServerProjectStore, "project">,
  thread: Pick<
    CodeThread,
    "id" | "projectId" | "bindingRevisionId" | "repositoryId" | "checkoutId"
  >,
): ServerProject | undefined {
  return serverThreadOf(store, thread)?.project;
}

/** Prepares a Project's checkout for a new thread: a server Project's from the Project alone. */
export function withServerCodeCheckouts(
  store: Pick<ServerProjectStore, "project">,
  local: CodeCheckoutObservationPort,
): CodeCheckoutObservationPort {
  return {
    observe: async (windowId, projectId) => {
      const project = store.project(String(projectId));
      return project === undefined
        ? local.observe(windowId, projectId)
        : serverCodeCheckout(project);
    },
  };
}

/**
 * A server thread's checkout root as the Code operation runtime takes it: the
 * folder as the server names it, never resolved or opened here. Only the
 * turn's server tools act on it.
 */
export function serverCodeCheckoutRoot(
  store: Pick<ServerProjectStore, "project">,
  thread: Pick<
    CodeThread,
    "id" | "projectId" | "bindingRevisionId" | "repositoryId" | "checkoutId"
  >,
) {
  const place = serverThreadOf(store, thread);
  return place === undefined
    ? undefined
    : {
        checkoutRoot: place.folder,
        shell: "/bin/sh",
        credentialReferences: [],
        environment: {},
      };
}

export type ServerCodeTurnBinding =
  | { readonly status: "bound"; readonly tools: AppManagedToolSet }
  | { readonly status: "refused"; readonly message: string };

export const SERVER_RUNTIME_NOT_HARNESS =
  "A thread in a Project on a server runs on the Octant Harness only, because other runtimes act on this computer's files. Choose a model the Octant Harness runs.";
const SERVER_NOT_REGISTERED =
  "This Project's server is no longer registered in Settings › Access › Servers, so nothing can run there.";

/**
 * Binds a server thread's turn before anything launches: the harness's
 * tools with the file tools and shell on the server, or why it cannot run.
 */
export function bindServerCodeTurn(
  options: {
    readonly store: Pick<ServerProjectStore, "project" | "addressOf">;
    readonly connection: Pick<ServerConnection, "run">;
    readonly composition: Pick<NativeHarnessComposition, "forServerCode">;
    readonly record: (
      input: Parameters<ServerShellOptions["record"]>[0] & {
        readonly threadId: string;
      },
    ) => "recorded" | "unavailable";
  },
  input: {
    readonly thread: CodeThread;
    readonly windowId: WindowId;
    readonly secrets: ReadonlyArray<string>;
  },
): ServerCodeTurnBinding {
  const place = serverThreadOf(options.store, input.thread);
  if (place === undefined) return { status: "refused", message: SERVER_NOT_REGISTERED };
  const project = place.project;
  const projectId = String(project.id);
  if (options.store.addressOf(projectId).kind !== "address") {
    return { status: "refused", message: SERVER_NOT_REGISTERED };
  }
  // The registry is read on every call, so a server removed mid-turn refuses
  // the next call rather than reaching a host it no longer names.
  const address = () => {
    const now = options.store.addressOf(projectId);
    return now.kind === "address" ? now.server : undefined;
  };
  const filesystem = new ServerFileSystem({
    connection: options.connection,
    server: address,
    root: place.folder,
  });
  const shell = createServerShell({
    connection: options.connection,
    server: () => {
      const server = address();
      return server === undefined ? undefined : { ...server, serverId: String(project.serverId) };
    },
    root: place.folder,
    record: (record) => options.record({ ...record, threadId: String(input.thread.id) }),
  });
  const tools = options.composition.forServerCode({
    thread: input.thread,
    filesystem,
    shell,
    windowId: String(input.windowId),
    secrets: input.secrets,
  });
  return tools === undefined
    ? { status: "refused", message: SERVER_RUNTIME_NOT_HARNESS }
    : { status: "bound", tools };
}
