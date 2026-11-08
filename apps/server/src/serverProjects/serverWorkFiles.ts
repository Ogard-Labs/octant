import {
  MAX_WORK_FILE_LISTING_DEPTH,
  MAX_WORK_FILE_LISTING_ENTRIES,
  decodeWorkFileListingEntry,
  decodeWorkFileListingResult,
  type WorkFileListingEntry,
  type WorkFileListingResult,
  type WorkThreadId,
  type WindowId,
  type ProjectId,
} from "@octant/contracts";
import { canonicalizeWorkRelativePath } from "@octant/domain";
import type { WorkThread } from "@octant/contracts/work-threads";
import type { ServerProjectStore } from "./serverProjectStore";
import type { ServerConnection } from "./serverConnection";
import { serverWorkProjectOf } from "./serverWorkThreads";
import { listServerDirectory } from "./serverDirectoryListing";

export interface ServerWorkFileListing {
  readonly holds: (projectId: ProjectId) => boolean;
  readonly list: (input: {
    readonly windowId: WindowId;
    readonly projectId: ProjectId;
    readonly threadId: WorkThreadId;
    readonly directory?: string | undefined;
    readonly signal: AbortSignal;
    readonly current: () => boolean;
  }) => Promise<WorkFileListingResult>;
}

/** Read-only server metadata; no local filesystem, previews or output attribution. */
export function createServerWorkFileListing(options: {
  readonly store: Pick<ServerProjectStore, "project" | "workProject" | "addressOf">;
  readonly connection: Pick<ServerConnection, "run">;
  readonly thread: (
    id: WorkThreadId,
  ) => Pick<WorkThread, "id" | "projectId" | "bindingRevisionId" | "lifecycle"> | undefined;
  readonly canOpen: (windowId: WindowId, threadId: string) => Promise<boolean>;
  readonly clock: () => string;
}): ServerWorkFileListing {
  const failed = (message: string): WorkFileListingResult => ({
    status: "failed",
    failure: { category: "unavailable", message },
  });
  return {
    holds: (projectId) => options.store.project(String(projectId)) !== undefined,
    list: async (input) => {
      const thread = options.thread(input.threadId);
      const project = thread === undefined ? undefined : serverWorkProjectOf(options.store, thread);
      if (
        thread?.lifecycle !== "active" ||
        project === undefined ||
        String(project.id) !== String(input.projectId)
      )
        return failed("This Work thread is not bound to that server Project.");
      let directory: string | undefined;
      try {
        directory =
          input.directory === undefined || input.directory === "" || input.directory === "."
            ? undefined
            : canonicalizeWorkRelativePath(input.directory);
      } catch {
        return failed("That folder is not inside this Project on the server.");
      }
      const snapshot = () => {
        const freshThread = options.thread(input.threadId);
        const freshProject =
          freshThread === undefined ? undefined : serverWorkProjectOf(options.store, freshThread);
        const address = options.store.addressOf(String(input.projectId));
        return freshThread?.lifecycle === "active" &&
          freshProject !== undefined &&
          address.kind === "address"
          ? JSON.stringify([freshThread, freshProject, address])
          : undefined;
      };
      const identity = snapshot();
      const current = () =>
        identity !== undefined &&
        input.current() &&
        !input.signal.aborted &&
        snapshot() === identity;
      if (
        !current() ||
        !(await options.canOpen(input.windowId, String(input.threadId))) ||
        !current()
      )
        return failed("This server Work folder is unavailable for this window.");
      const listed = await listServerDirectory(
        {
          connection: options.connection,
          server: () => {
            const address = options.store.addressOf(String(input.projectId));
            return current() && address.kind === "address" ? address.server : undefined;
          },
          root: project.folder,
          maxDepth: MAX_WORK_FILE_LISTING_DEPTH,
          maxEntries: MAX_WORK_FILE_LISTING_ENTRIES,
        },
        { directory, signal: input.signal },
      );
      if (
        !current() ||
        !(await options.canOpen(input.windowId, String(input.threadId))) ||
        !current()
      )
        return failed(
          "This server Work folder changed while it was being read. Refresh to try again.",
        );
      if (listed.status === "failed") return failed(listed.message);
      const entries: WorkFileListingEntry[] = [];
      let truncated = listed.truncated;
      for (const entry of listed.entries) {
        if (entry.path.split("/").some((part) => part.startsWith("."))) continue;
        try {
          const decoded = decodeWorkFileListingEntry(
            entry.kind === "directory" ? entry : { ...entry, origin: "untouched" },
          );
          // A remote filename cannot be trimmed or renamed to fit the wire contract.
          if (decoded.path !== entry.path) {
            truncated = true;
            continue;
          }
          entries.push(decoded);
        } catch {
          truncated = true;
        }
      }
      return decodeWorkFileListingResult({
        status: "listed",
        listing: {
          kind: "work-file-listing",
          threadId: input.threadId,
          projectId: input.projectId,
          ...(directory === undefined ? {} : { directory }),
          entries,
          truncated,
          observedAt: options.clock(),
        },
      });
    },
  };
}
