import type { CoordinatorWorkerChoice } from "@octant/contracts";
import { threadRowActivity, type ChatThreadNavigationItem } from "../shell/navigationModel";
import type { SubagentWorkerThread } from "./AgentHierarchyPanel";

/**
 * The line a worker row shows beside its model when the host did not start
 * the role's main model (docs/design/workspace.md, Coordinators): the
 * coordinator's reason for an override, else the host's reason for a fallback.
 */
export function coordinatorChoiceNote(
  choice: CoordinatorWorkerChoice | undefined,
): string | undefined {
  if (choice === undefined) return undefined;
  if (choice.why !== undefined) return `chosen: ${choice.why}`;
  if (choice.rank === "person") return "chosen by you";
  if (choice.rank === "main" || choice.rank === "chosen") return undefined;
  return `fallback: ${choice.reason ?? "main unavailable"}`;
}

/**
 * The workers a coordinator started, from the thread list a window already
 * holds, in that list's order. `undefined` for a thread that is not a
 * coordinator or has no listed workers, so the Agents tool shows no Workers
 * section and asks the host for nothing.
 *
 * Nothing here is new to the window: the same rows sit folded under the
 * coordinator in the sidebar.
 */
export function coordinatorWorkersOf(
  threads: ReadonlyArray<ChatThreadNavigationItem>,
  coordinatorThreadId: string | undefined,
  modelName?: (worker: { readonly providerInstanceId: string; readonly modelId: string }) => string,
): ReadonlyArray<SubagentWorkerThread> | undefined {
  if (coordinatorThreadId === undefined) return undefined;
  const coordinator = threads.find((thread) => thread.threadId === coordinatorThreadId);
  if (coordinator?.coordinator !== true) return undefined;
  const workers = threads
    .filter((thread) => thread.coordinatorThreadId === coordinatorThreadId)
    .map((thread): SubagentWorkerThread => {
      const activity = threadRowActivity(thread);
      const note = coordinatorChoiceNote(thread.coordinatorChoice);
      // Only a worker whose model the roles chose names it; the rest run on
      // the coordinator's own model, as before roles existed.
      const model =
        thread.modelId === undefined || thread.coordinatorChoice === undefined
          ? undefined
          : (modelName?.({
              providerInstanceId: thread.providerInstanceId ?? "",
              modelId: thread.modelId,
            }) ?? thread.modelId);
      return {
        threadId: thread.threadId,
        title: thread.title,
        ...(thread.provider === undefined ? {} : { provider: thread.provider }),
        ...(model === undefined ? {} : { model }),
        ...(note === undefined ? {} : { choiceNote: note }),
        state:
          activity === "working" || activity === "attention"
            ? activity
            : thread.completedAt === undefined
              ? "idle"
              : "done",
      };
    });
  return workers.length === 0 ? undefined : workers;
}
