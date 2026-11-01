import { createHash } from "node:crypto";
import { decodeBindingRevisionId, type BindingRevisionId } from "@octant/contracts/projects";
import type { ServerProject } from "@octant/contracts/server-projects";
import type { WorkThread } from "@octant/contracts/work-threads";
import type { NativeHarnessComposition } from "../harness/nativeHarnessComposition";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { ServerConnection } from "./serverConnection";
import { ServerFileSystem } from "./serverFiles";
import type { ServerProjectStore } from "./serverProjectStore";
import { createServerShell, type ServerShellOptions } from "./serverShell";
import { SERVER_RUNTIME_NOT_HARNESS } from "./serverProjectThreads";

/**
 * Work threads in a server Project. Canonical: docs/design/server-projects.md
 * § Work Projects.
 *
 * A server Work Project's thread is an ordinary Work thread on this host's
 * journal whose binding revision is derived from the Project alone, under a
 * label of its own, so it never names a local Project's binding and no local
 * Work file, folder, or terminal path resolves it. A turn runs only on the
 * Octant Harness, whose inference stays here and whose file tools and shell
 * are on the server.
 */

function digestUuid(label: string, project: ServerProject): string {
  const hex = createHash("sha256")
    .update(`${label}\0`)
    .update(String(project.id))
    .update("\0")
    .update(String(project.serverId))
    .update("\0")
    .update(project.folder)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The binding revision every Work thread in this server Project is created against. */
export function serverWorkBindingRevisionId(project: ServerProject): BindingRevisionId {
  return decodeBindingRevisionId(digestUuid("octant.server-work-project-binding.v1", project));
}

/**
 * The server Work Project a thread runs in, when the thread's binding is
 * exactly the one that Project derives.
 */
export function serverWorkProjectOf(
  store: Pick<ServerProjectStore, "workProject">,
  thread: Pick<WorkThread, "projectId" | "bindingRevisionId">,
): ServerProject | undefined {
  const project = store.workProject(String(thread.projectId));
  if (project === undefined || thread.bindingRevisionId === undefined) return undefined;
  return String(serverWorkBindingRevisionId(project)) === String(thread.bindingRevisionId)
    ? project
    : undefined;
}

export type ServerWorkTurnBinding =
  | { readonly status: "bound"; readonly folder: string; readonly tools: AppManagedToolSet }
  | { readonly status: "refused"; readonly message: string };

const SERVER_NOT_REGISTERED =
  "This Project's server is no longer registered in Settings › Access › Servers, so nothing can run there.";

/**
 * Binds a server Work thread's turn before anything launches: the harness's
 * tools with the file tools and shell on the server, or why it cannot run.
 */
export function bindServerWorkTurn(
  options: {
    readonly store: Pick<ServerProjectStore, "workProject" | "addressOf" | "serverOf">;
    readonly connection: Pick<ServerConnection, "run">;
    readonly composition: Pick<NativeHarnessComposition, "forServerWork">;
    readonly record: (
      input: Parameters<ServerShellOptions["record"]>[0] & { readonly threadId: string },
    ) => "recorded" | "unavailable";
  },
  input: { readonly thread: WorkThread },
): ServerWorkTurnBinding {
  const project = serverWorkProjectOf(options.store, input.thread);
  if (project === undefined) return { status: "refused", message: SERVER_NOT_REGISTERED };
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
  const tools = options.composition.forServerWork({
    thread: input.thread,
    filesystem: new ServerFileSystem({
      connection: options.connection,
      server: address,
      root: project.folder,
    }),
    shell: createServerShell({
      connection: options.connection,
      server: () => {
        const server = address();
        return server === undefined ? undefined : { ...server, serverId: String(project.serverId) };
      },
      root: project.folder,
      record: (record) => options.record({ ...record, threadId: String(input.thread.id) }),
    }),
    server: () => options.store.serverOf(projectId),
  });
  return tools === undefined
    ? { status: "refused", message: SERVER_RUNTIME_NOT_HARNESS }
    : { status: "bound", folder: project.folder, tools };
}
