import { decodeChatThreadId, decodeCodeThreadId, decodeWorkThreadId } from "@octant/contracts";
import type { PersistenceService } from "../persistence/persistenceService";
import type { WorkThreadProjection } from "../work/workThreadProjection";
import type { WorkspaceWiring } from "./workspace";

/**
 * Whether a thread is one an authenticated window's sidebar already lists: a
 * live, active Chat, Code, or Work thread, in an active Project when it has
 * one. It reveals no more than the sidebar's own thread lists do, and unlike
 * the harness session check it does not need the thread open, which is what
 * nesting a follow-up under its parent in the sidebar needs.
 */
export function createThreadIsListed(deps: {
  readonly persistence: PersistenceService;
  readonly workThreadProjection: WorkThreadProjection;
  readonly projectService: WorkspaceWiring["projectService"];
}) {
  const { persistence, workThreadProjection, projectService } = deps;
  const purged = (threadId: string) =>
    persistence.connection
      .prepare("SELECT 1 FROM thread_purge_tombstone WHERE thread_id = ?")
      .get(threadId) !== undefined;
  const read = <T>(load: () => T): T | undefined => {
    try {
      return load();
    } catch {
      // The id belongs to another mode.
      return undefined;
    }
  };
  return (input: { readonly threadId: string; readonly windowId: string }): boolean => {
    const { threadId } = input;
    if (purged(threadId)) return false;
    const code = read(() => persistence.readCodeThread(decodeCodeThreadId(threadId)));
    if (code !== undefined) {
      return code.lifecycle === "active" && projectService.hasActiveProject(code.projectId, "code");
    }
    const work = read(() => workThreadProjection.read(decodeWorkThreadId(threadId)));
    if (work !== undefined) {
      return work.lifecycle === "active" && projectService.hasActiveProject(work.projectId, "work");
    }
    const chat = read(() => persistence.readChatThread(decodeChatThreadId(threadId)));
    return chat !== undefined && chat.lifecycle === "active";
  };
}
