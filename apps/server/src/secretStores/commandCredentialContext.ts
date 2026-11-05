import {
  decodeCodeThreadId,
  decodeCodeRelativePath,
  decodeWindowId,
  type CodeThread,
  type CodeThreadId,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import { isToolAllowedByAllowlist } from "@octant/domain";
import type { PersistenceService } from "../persistence/persistenceService";
import type { CodeFileRootAuthorityPort } from "../code/codeService";
import type { CodeSessionAuthorityStore } from "../code/codeSessionAuthorityStore";
import type { CodeOperationRuntime } from "../code/codeOperationRuntime";
import type { CommandCredentialContext } from "./commandCredentialBindings";

/** Person and provider requests resolve the same effective Code authority. */
export function commandCredentialContext(options: {
  readonly persistence: Pick<
    PersistenceService,
    "readCodeThread" | "readCodeCheckout" | "readProject"
  >;
  readonly read: (windowId: WindowId, threadId: CodeThreadId) => Promise<CodeThread>;
  readonly roots: CodeFileRootAuthorityPort;
  readonly session: Pick<CodeSessionAuthorityStore, "effectiveThread">;
  readonly runtime: Pick<CodeOperationRuntime, "threadWithActiveTurnPosture"> | undefined;
  readonly providerRevision: (thread: CodeThread) => number | undefined;
  readonly windowCurrent: (windowId: WindowId) => boolean;
  readonly canAccess: (windowId: WindowId, projectId: ProjectId) => boolean;
}): (windowId: string, threadId: string) => Promise<CommandCredentialContext | undefined> {
  const effective = (windowId: WindowId, thread: CodeThread) => {
    const session = options.session.effectiveThread(windowId, thread);
    return options.runtime?.threadWithActiveTurnPosture?.(session) ?? session;
  };
  const key = (thread: CodeThread) =>
    JSON.stringify([
      thread.id,
      thread.projectId,
      thread.bindingRevisionId,
      thread.checkoutId,
      thread.providerInstanceId,
      thread.modelId,
      thread.modelOptionValues,
      thread.profileId,
      thread.toolConstraints,
      thread.executionPolicy,
      thread.lifecycle,
    ]);
  return async (window, threadId) => {
    try {
      const windowId = decodeWindowId(window);
      const id = decodeCodeThreadId(threadId);
      if (!options.windowCurrent(windowId)) return undefined;
      const read = await options.read(windowId, id);
      const thread = effective(windowId, read);
      if (
        thread.lifecycle !== "active" ||
        !isToolAllowedByAllowlist(thread.toolConstraints ?? [], "octant_command") ||
        !options.canAccess(windowId, thread.projectId)
      )
        return undefined;
      const providerRevision = options.providerRevision(thread);
      if (providerRevision === undefined) return undefined;
      const checkout = options.persistence.readCodeCheckout(thread.checkoutId);
      if (checkout === undefined || checkout.kind === "remote-root") return undefined;
      const projectAuthority = () => {
        const project = options.persistence.readProject(thread.projectId);
        return project?.type !== "code"
          ? undefined
          : JSON.stringify([
              project.id,
              project.lifecycle,
              project.binding,
              project.bindingHistory.at(-1)?.revisionId,
              project.providerPolicy,
              project.nativeProviders,
              project.codeAccessPersistence,
            ]);
      };
      const checkoutAuthority = () => {
        const current = options.persistence.readCodeCheckout(thread.checkoutId);
        return current === undefined
          ? undefined
          : JSON.stringify([
              current.id,
              current.repositoryId,
              current.kind,
              current.availability,
              current.kind === "managed-worktree" ? current.ownershipReceiptId : undefined,
            ]);
      };
      const projectKey = projectAuthority();
      const checkoutKey = checkoutAuthority();
      const root = await options.roots.resolve(
        windowId,
        thread,
        checkout,
        decodeCodeRelativePath("package.json"),
      );
      if (root === undefined) return undefined;
      const authorityKey = key(thread);

      const current = () => {
        try {
          const stored = options.persistence.readCodeThread(id);
          return (
            stored !== undefined &&
            options.windowCurrent(windowId) &&
            options.providerRevision(stored) === providerRevision &&
            options.canAccess(windowId, thread.projectId) &&
            key(effective(windowId, stored)) === authorityKey &&
            projectKey !== undefined &&
            projectAuthority() === projectKey &&
            checkoutAuthority() === checkoutKey
          );
        } catch {
          return false;
        }
      };
      const revalidate = async () => {
        try {
          if (!current()) return false;
          const fresh = await options.roots.resolve(
            windowId,
            thread,
            checkout,
            decodeCodeRelativePath("package.json"),
          );
          return (
            current() &&
            fresh !== undefined &&
            fresh.rootPath === root.rootPath &&
            JSON.stringify(fresh.rootIdentity) === JSON.stringify(root.rootIdentity) &&
            String(fresh.fileId) === String(root.fileId)
          );
        } catch {
          return false;
        }
      };
      if (!current()) return undefined;
      return {
        windowId: window,
        threadId,
        projectId: String(thread.projectId),
        root: root.rootPath,
        authorityKey,
        executionPolicy: thread.executionPolicy,
        current,
        revalidate,
      };
    } catch {
      return undefined;
    }
  };
}
