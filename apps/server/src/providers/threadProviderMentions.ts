import { lstat } from "node:fs/promises";
import { Effect } from "effect";
import {
  decodeCodeThreadId,
  decodeThreadWorkingDirectory,
  decodeWorkThreadId,
  type CodeCheckoutId,
  type CodeCheckoutIdentity,
  type CodeThread,
  type CodeThreadId,
  type Project,
  type ProjectId,
  type ProviderInstance,
  type ProviderInstanceId,
  type ProviderMention,
  type ThreadNativeSetupRequest,
  type ThreadWorkingDirectory,
  type WindowId,
  type WorkThread,
  type WorkThreadId,
  type WorktreeReceiptId,
} from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { approvedWorkingFolderRoot } from "../approvedWorkingFolders";
import { resolveThreadWorkingDirectory } from "../threadWorkingDirectoryAuthority";
import { sessionNativeSetup } from "./providerNativeSetup";

export type ThreadProviderMentionsRequest = Extract<
  ThreadNativeSetupRequest,
  { readonly kind: "mentions" | "draft-mentions" }
>;

export type ThreadProviderMentionsOutcome =
  | { readonly status: "ok"; readonly mentions: ReadonlyArray<ProviderMention> }
  | { readonly status: "unauthorized" };

export interface ThreadProviderMentionsSources {
  readonly canAccessProject: (windowId: WindowId, projectId: ProjectId) => Promise<boolean>;
  readonly readCodeThread: (threadId: CodeThreadId) => CodeThread | undefined;
  readonly readCodeCheckout: (checkoutId: CodeCheckoutId) => CodeCheckoutIdentity | undefined;
  readonly readWorkThread: (threadId: WorkThreadId) => WorkThread | undefined;
  readonly readProject: (projectId: ProjectId) => Project | undefined;
  readonly readProviderInstance: (id: ProviderInstanceId) => ProviderInstance | undefined;
  readonly readThreadNativeSetup?: (threadId: string) => "on" | "off" | undefined;
  readonly readStrict?: (threadId: string) => boolean;
  readonly isServerProject: (projectId: ProjectId) => boolean;
  readonly resolveManagedWorktreePath: (
    receiptId: WorktreeReceiptId,
  ) => Promise<string | undefined>;
  readonly resolveWorkingDirectory?: (
    root: string,
    relative: ThreadWorkingDirectory,
  ) => Promise<string>;
  readonly isDirectory?: (path: string) => Promise<boolean>;
  readonly observedMentions: (
    instanceId: ProviderInstanceId,
  ) => ReadonlyArray<ProviderMention> | undefined;
  readonly resolveDriver: (instanceId: ProviderInstanceId) => ProviderDriver | undefined;
}

/**
 * The provider's own skills and plugins available for a Work or Code thread
 * (or draft) in its bound folder, for the composer's `@` menu.
 *
 * Project skills are queried and returned ONLY when the thread's launch
 * actually loads them (`nativeSetup.skills === true`), for the thread's own
 * local folder (`cwd` / checkout / working directory). When Project skills are
 * off, when the thread has no local folder (Chat, a server Project, an
 * unavailable checkout), or when the driver does not list folder skills, only
 * the account's own observed mentions are returned — zero Project rows, no
 * disabled or greyed entries.
 */
export async function readThreadProviderMentions(
  sources: ThreadProviderMentionsSources,
  windowId: WindowId,
  request: ThreadProviderMentionsRequest,
): Promise<ThreadProviderMentionsOutcome> {
  const accountOnly = (instanceId: ProviderInstanceId): ReadonlyArray<ProviderMention> =>
    (sources.observedMentions(instanceId) ?? []).filter((mention) => mention.scope !== "project");
  const isDirectory = sources.isDirectory ?? isRealDirectory;
  const resolveWorkingDirectory = sources.resolveWorkingDirectory ?? resolveThreadWorkingDirectory;
  const verifiedDirectory = async (path: string | undefined): Promise<string | undefined> =>
    path !== undefined && (await isDirectory(path)) ? path : undefined;

  const nativeSetupSources = {
    readProviderInstance: sources.readProviderInstance,
    readProject: sources.readProject,
    ...(sources.readThreadNativeSetup === undefined
      ? {}
      : { readThreadNativeSetup: sources.readThreadNativeSetup }),
    ...(sources.readStrict === undefined ? {} : { readStrict: sources.readStrict }),
  };

  let instanceId: ProviderInstanceId;
  let projectRoot: string | undefined;
  let nativeSetup: ReturnType<typeof sessionNativeSetup>;

  if (request.kind === "draft-mentions") {
    if (!(await sources.canAccessProject(windowId, request.projectId))) {
      return { status: "unauthorized" };
    }
    instanceId = request.providerInstanceId;
    const project = sources.readProject(request.projectId);
    if (
      project === undefined ||
      project.type !== request.mode ||
      project.lifecycle !== "active" ||
      sources.isServerProject(project.id)
    ) {
      return { status: "ok", mentions: accountOnly(instanceId) };
    }
    projectRoot = await verifiedDirectory(project.binding.canonicalRoot);
    const executionPolicy =
      request.mode === "code"
        ? (request.executionPolicy ?? "approval-gated")
        : request.executionPolicy === "auto-accept-edits"
          ? "auto-accept-edits"
          : "approval-gated";
    nativeSetup = sessionNativeSetup(nativeSetupSources, {
      providerInstanceId: instanceId,
      projectId: project.id,
      mode: request.mode,
      executionPolicy,
    });
  } else if (request.mode === "code") {
    const thread = sources.readCodeThread(decodeCodeThreadId(request.threadId));
    if (thread === undefined || thread.lifecycle !== "active") {
      return { status: "ok", mentions: [] };
    }
    if (!(await sources.canAccessProject(windowId, thread.projectId))) {
      return { status: "unauthorized" };
    }
    instanceId = thread.providerInstanceId;
    const project = sources.readProject(thread.projectId);
    const checkout = sources.readCodeCheckout(thread.checkoutId);
    const latest = project?.type === "code" ? project.bindingHistory.at(-1) : undefined;
    if (
      project === undefined ||
      project.type !== "code" ||
      project.lifecycle !== "active" ||
      sources.isServerProject(project.id) ||
      checkout === undefined ||
      checkout.kind === "remote-root" ||
      latest === undefined ||
      String(latest.revisionId) !== String(thread.bindingRevisionId)
    ) {
      return { status: "ok", mentions: accountOnly(instanceId) };
    }
    const checkoutRoot =
      checkout.kind === "managed-worktree"
        ? await sources.resolveManagedWorktreePath(checkout.ownershipReceiptId)
        : project.binding.canonicalRoot;
    if (checkoutRoot !== undefined) {
      if (thread.workingFolderId !== undefined) {
        const selectedRoot = approvedWorkingFolderRoot(
          project,
          thread.workingFolderId,
          checkoutRoot,
        );
        if (selectedRoot !== undefined) {
          const resolved = await resolveWorkingDirectory(
            selectedRoot,
            thread.workingDirectory ?? decodeThreadWorkingDirectory("."),
          ).catch(() => undefined);
          projectRoot = await verifiedDirectory(resolved);
        }
      } else {
        projectRoot = await verifiedDirectory(checkoutRoot);
      }
    }
    nativeSetup = sessionNativeSetup(nativeSetupSources, {
      providerInstanceId: instanceId,
      projectId: thread.projectId,
      threadId: String(thread.id),
      mode: "code",
      executionPolicy: thread.executionPolicy,
    });
  } else {
    const thread = sources.readWorkThread(decodeWorkThreadId(request.threadId));
    if (thread === undefined || thread.lifecycle !== "active") {
      return { status: "ok", mentions: [] };
    }
    if (!(await sources.canAccessProject(windowId, thread.projectId))) {
      return { status: "unauthorized" };
    }
    instanceId = thread.providerInstanceId;
    const project = sources.readProject(thread.projectId);
    const latest = project?.type === "work" ? project.bindingHistory.at(-1) : undefined;
    if (
      project === undefined ||
      project.type !== "work" ||
      project.lifecycle !== "active" ||
      sources.isServerProject(project.id) ||
      thread.bindingRevisionId === undefined ||
      latest === undefined ||
      String(latest.revisionId) !== String(thread.bindingRevisionId)
    ) {
      return { status: "ok", mentions: accountOnly(instanceId) };
    }
    const selectedRoot = approvedWorkingFolderRoot(project, thread.workingFolderId);
    if (selectedRoot !== undefined) {
      const resolved = await resolveWorkingDirectory(
        selectedRoot,
        thread.workingDirectory ?? decodeThreadWorkingDirectory("."),
      ).catch(() => undefined);
      projectRoot = await verifiedDirectory(resolved);
    }
    nativeSetup = sessionNativeSetup(nativeSetupSources, {
      providerInstanceId: instanceId,
      projectId: thread.projectId,
      threadId: String(thread.id),
      mode: "work",
      // Matches WorkTurnService's launch policy so `@` never offers skills a turn switches off.
      executionPolicy:
        thread.access === "auto-accept-edits" ? "auto-accept-edits" : "approval-gated",
    });
  }

  const instance = sources.readProviderInstance(instanceId);
  if (instance === undefined || !instance.enabled) {
    return { status: "ok", mentions: [] };
  }
  if (nativeSetup?.skills !== true || projectRoot === undefined) {
    return { status: "ok", mentions: accountOnly(instanceId) };
  }
  const driver = sources.resolveDriver(instanceId);
  const listMentions = driver?.listMentions;
  if (listMentions === undefined) {
    return { status: "ok", mentions: accountOnly(instanceId) };
  }
  try {
    const mentions = await Effect.runPromise(
      listMentions({ instanceId, projectRoot, nativeSetup }),
    );
    return { status: "ok", mentions };
  } catch {
    return { status: "ok", mentions: accountOnly(instanceId) };
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch {
    return false;
  }
}
