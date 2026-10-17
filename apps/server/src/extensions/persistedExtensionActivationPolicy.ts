import {
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeWorkThreadId,
  type ChatThread,
  type CodeThread,
  type Project,
  type WorkThread,
} from "@octant/contracts";
import {
  createLocalExtensionActivationPolicy,
  type ExtensionActivationPolicyPort,
} from "./extensionActivationService";

/**
 * The Project and thread records the host's activation policy reads. A thread
 * allows an extension only while it is active and still belongs to the scope's
 * Project; a Project only while it is active and of the scope's mode.
 */
export interface ExtensionActivationRecords {
  readProject(projectId: NonNullable<Project["id"]>): Project | undefined;
  readChatThread(threadId: ChatThread["id"]): ChatThread | undefined;
  readWorkThread(threadId: WorkThread["id"]): WorkThread | undefined;
  readCodeThread(threadId: CodeThread["id"]): CodeThread | undefined;
}

export function createPersistedExtensionActivationPolicy(
  records: ExtensionActivationRecords,
): ExtensionActivationPolicyPort {
  return createLocalExtensionActivationPolicy({
    project: (scope) => {
      if (scope.projectId === null) return { allowed: true, revision: 0 };
      const project = records.readProject(scope.projectId);
      return {
        allowed:
          project !== undefined && project.lifecycle === "active" && project.type === scope.mode,
        revision: Number(project?.version ?? 0),
      };
    },
    thread: (scope) => {
      if (scope.threadId === null) return { allowed: true, revision: 0 };
      if (scope.mode === "chat") {
        const thread = records.readChatThread(decodeChatThreadId(scope.threadId));
        return {
          allowed: thread?.lifecycle === "active" && (thread.projectId ?? null) === scope.projectId,
          revision: Number(thread?.version ?? 0),
        };
      }
      if (scope.mode === "work") {
        const thread = records.readWorkThread(decodeWorkThreadId(scope.threadId));
        return {
          allowed: thread?.lifecycle === "active" && thread.projectId === scope.projectId,
          revision: Number(thread?.version ?? 0),
        };
      }
      const thread = records.readCodeThread(decodeCodeThreadId(scope.threadId));
      return {
        allowed: thread?.lifecycle === "active" && thread.projectId === scope.projectId,
        revision: Number(thread?.version ?? 0),
      };
    },
  });
}
