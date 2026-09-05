import {
  decodeCodeCommand,
  decodeCodeThread,
  decodeCodeThreadId,
  decodeWindowId,
  type CodeCommand,
  type CodeCommandResult,
  type CodeThread,
  type CodeThreadId,
  type HostId,
  type NativeHarnessFollowUpCreation,
  type NativeHarnessSessionView,
  type Project,
  type ProjectId,
  type WindowId,
  type WorkThreadCommandResult,
} from "@octant/contracts";
import type { ChatService } from "../chat/chatService";

export type NativeHarnessFollowUpCreationOutcome =
  | { readonly kind: "created"; readonly created: NativeHarnessFollowUpCreation }
  | { readonly kind: "refused"; readonly message: string };

export interface NativeHarnessFollowUpCreationDependencies {
  readonly chat: Pick<ChatService, "execute">;
  readonly work: {
    readonly execute: (
      windowId: WindowId,
      input: unknown,
    ) => Promise<WorkThreadCommandResult> | WorkThreadCommandResult;
  };
  readonly code:
    | {
        readonly execute: (
          windowId: WindowId,
          command: CodeCommand,
          signal?: AbortSignal,
        ) => Promise<CodeCommandResult> | CodeCommandResult;
      }
    | undefined;
  readonly readCodeThread: (threadId: CodeThreadId) => CodeThread | undefined;
  readonly readProject: (projectId: ProjectId) => Project | undefined;
  readonly hostId: HostId;
  readonly uuid: () => string;
  readonly clock: () => string;
}

/**
 * Creates the thread a confirmed follow-up names through the same creation
 * command the composer would send, on the window that confirmed it, so the
 * thread lands with ordinary authority and shows up everywhere a thread
 * does. The follow-up's prompt is not sent: it is standalone by contract, and
 * the person sends it from the new thread after reading it. A new thread
 * runs under the lead's own model, so it stays on the harness; a Code thread
 * starts approval-gated, because Full access is remembered per thread and
 * nobody remembered it for this one.
 */
export async function createNativeHarnessFollowUp(
  dependencies: NativeHarnessFollowUpCreationDependencies,
  input: {
    readonly windowId: string;
    readonly view: NativeHarnessSessionView;
    readonly creation: NativeHarnessFollowUpCreation;
  },
): Promise<NativeHarnessFollowUpCreationOutcome> {
  const { creation, view } = input;
  const lead = view.session.lead;
  try {
    if (creation.kind === "same-thread") return { kind: "created", created: creation };
    const windowId = decodeWindowId(input.windowId);
    if (creation.kind === "new-worktree") {
      return await createCodeThread(dependencies, {
        windowId,
        view,
        creation,
        placement: "worktree",
      });
    }
    if (creation.mode === "code") {
      return await createCodeThread(dependencies, {
        windowId,
        view,
        creation,
        placement: "checkout",
      });
    }
    if (creation.mode === "work") {
      if (creation.projectId === undefined) {
        return refused("A Work follow-up needs a Project to live in.");
      }
      const project = dependencies.readProject(creation.projectId);
      const binding =
        project !== undefined && "bindingHistory" in project
          ? project.bindingHistory.at(-1)
          : undefined;
      if (binding === undefined) return refused("The Work Project is unavailable.");
      const threadId = dependencies.uuid();
      const result = await dependencies.work.execute(windowId, {
        kind: "create-work-thread",
        threadId,
        projectId: creation.projectId,
        title: creation.title,
        providerInstanceId: lead.providerInstanceId,
        modelId: lead.modelId,
        hostId: "local",
        bindingRevisionId: binding.revisionId,
      });
      if (!("kind" in result) || result.kind !== "thread-created") {
        return refused("The host did not create the Work thread.");
      }
      return { kind: "created", created: { ...creation, threadId } };
    }
    const threadId = dependencies.uuid();
    const result = await dependencies.chat.execute({
      kind: "create-chat-thread",
      hostId: dependencies.hostId,
      threadId,
      title: creation.title,
      ...(creation.projectId === undefined ? {} : { projectId: creation.projectId }),
    });
    if (result.kind !== "thread-created")
      return refused("The host did not create the Chat thread.");
    // The lead's own model keeps the follow-up on the harness. A provider the
    // thread cannot take leaves the thread on its default, still created.
    await dependencies.chat
      .execute({
        kind: "change-chat-provider",
        threadId,
        expectedVersion: result.thread.version,
        providerInstanceId: lead.providerInstanceId,
        modelId: lead.modelId,
      })
      .catch(() => undefined);
    return { kind: "created", created: { ...creation, threadId } };
  } catch (error) {
    // A service refusal carries a sentence worth showing; a schema dump does not.
    const message = error instanceof Error ? error.message : "";
    return refused(
      message.length > 0 && message.length <= 240 ? message : "The follow-up could not be created.",
    );
  }
}

async function createCodeThread(
  dependencies: NativeHarnessFollowUpCreationDependencies,
  input: {
    readonly windowId: ReturnType<typeof decodeWindowId>;
    readonly view: NativeHarnessSessionView;
    readonly creation: Exclude<NativeHarnessFollowUpCreation, { readonly kind: "same-thread" }>;
    readonly placement: "checkout" | "worktree";
  },
): Promise<NativeHarnessFollowUpCreationOutcome> {
  if (dependencies.code === undefined) return refused("Code is unavailable on this host.");
  const parent = dependencies.readCodeThread(decodeCodeThreadId(input.view.session.threadId));
  if (parent === undefined)
    return refused("The Code thread this follow-up came from is unavailable.");
  const projectId = input.creation.projectId ?? parent.projectId;
  const prepared = await dependencies.code.execute(
    input.windowId,
    decodeCodeCommand({ kind: "prepare-code-project-checkout", projectId }),
  );
  if (prepared.kind !== "checkout-prepared") {
    return refused("The Code checkout could not be prepared.");
  }
  const now = dependencies.clock();
  const threadId = dependencies.uuid();
  const lead = input.view.session.lead;
  if (input.placement === "worktree") {
    const result = await dependencies.code.execute(
      input.windowId,
      decodeCodeCommand({
        kind: "create-managed-code-thread",
        threadId,
        projectId,
        bindingRevisionId: prepared.bindingRevisionId,
        title: input.creation.title,
        providerInstanceId: lead.providerInstanceId,
        modelId: lead.modelId,
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
        deliveryTarget: { ...parent.deliveryTarget, confirmedAt: now },
        sourceBranch: parent.deliveryTarget.proposedBaseBranch,
        startFromOrigin: false,
        remoteName: parent.deliveryTarget.remoteName,
      }),
    );
    if (result.kind !== "thread-created")
      return refused("The host did not create the worktree thread.");
    return { kind: "created", created: { ...input.creation, threadId } };
  }
  if (prepared.checkout.head.kind !== "branch") {
    return refused(
      "Create or select a branch before starting a Code thread in the current checkout.",
    );
  }
  const thread = decodeCodeThread({
    id: threadId,
    projectId,
    bindingRevisionId: prepared.bindingRevisionId,
    repositoryId: prepared.checkout.repositoryId,
    checkoutId: prepared.checkout.id,
    title: input.creation.title,
    lifecycle: "active",
    providerInstanceId: lead.providerInstanceId,
    modelId: lead.modelId,
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    // Work in the existing checkout lands on the branch it is already on.
    deliveryTarget: {
      ...parent.deliveryTarget,
      branchIntent: prepared.checkout.head.name,
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  const result = await dependencies.code.execute(
    input.windowId,
    decodeCodeCommand({ kind: "create-code-thread", thread }),
  );
  if (result.kind !== "thread-created") return refused("The host did not create the Code thread.");
  return { kind: "created", created: { ...input.creation, threadId } };
}

function refused(message: string): NativeHarnessFollowUpCreationOutcome {
  return { kind: "refused", message };
}
