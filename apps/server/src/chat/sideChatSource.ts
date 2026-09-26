import {
  MAX_SIDE_CHAT_SOURCE_CHANGED_PATHS,
  decodeCodeThreadId,
  decodeWorkThreadId,
  type CodeEnvironmentObservation,
  type CodeThreadId,
  type CodeTurnChangedFiles,
  type MentionableThreadId,
  type OctantMode,
  type ProjectId,
  type SideChatSidecar,
  type WindowId,
  type WorkThreadId,
} from "@octant/contracts";
import {
  formatSideChatSourceContext,
  type SideChatChangedFile,
  type SideChatChangedFilesState,
  type SideChatCheckoutState,
  type SideChatDeliveryTargetState,
  type SideChatSourceState,
  type SideChatSubagentsState,
  type SideChatWorkFolderState,
} from "@octant/domain";
import type { SideChatSourceContext } from "./chatService";
import { walkCodeConversation, type SideChatSourceResolution } from "./threadMentionService";

/**
 * Resolve the framed source context for one Side Chat turn, or `undefined` when
 * the thread is not a sidecar.
 *
 * The link comes from the sidecar registry and the source is re-resolved on
 * this send's own window, so the renderer can neither name a different thread
 * nor widen what the sidecar reads. The transcript is the part the turn cannot
 * do without: when it is unreadable the turn is refused. The state section is
 * supplementary, and each of its parts says "could not be read" on its own
 * rather than costing the whole turn.
 */
export async function resolveSideChatSourceContext(
  ports: {
    readonly findSidecar: (sidecarThreadId: string) => SideChatSidecar | undefined;
    readonly resolveSource: (
      windowId: WindowId,
      sourceThreadId: MentionableThreadId,
    ) => Promise<SideChatSourceResolution>;
    readonly readState: SideChatSourceStateReader;
  },
  input: {
    readonly sidecarThreadId: string;
    readonly windowId?: WindowId;
    readonly readToolNames: ReadonlyArray<string>;
  },
): Promise<SideChatSourceContext | undefined> {
  const sidecar = ports.findSidecar(input.sidecarThreadId);
  if (sidecar === undefined) return undefined;
  // Without an authenticated window there is no principal to re-derive the
  // source thread's Open authority from, so the sidecar refuses rather than
  // answering about a thread nobody proved it may read.
  if (input.windowId === undefined) return { kind: "unreadable" };
  let resolved: SideChatSourceResolution;
  try {
    resolved = await ports.resolveSource(input.windowId, sidecar.sourceThreadId);
  } catch {
    return { kind: "unreadable" };
  }
  if (resolved.kind === "unreadable") return { kind: "unreadable" };
  let state: SideChatSourceState | undefined;
  try {
    state = await ports.readState(input.windowId, {
      threadId: resolved.source.threadId,
      mode: resolved.source.mode,
    });
  } catch {
    state = undefined;
  }
  return {
    kind: "resolved",
    text: formatSideChatSourceContext({
      source: resolved.source,
      ...(state === undefined ? {} : { state }),
      readToolNames: input.readToolNames,
    }),
  };
}

export type SideChatSourceStateReader = (
  windowId: WindowId,
  source: { readonly threadId: MentionableThreadId; readonly mode: OctantMode },
) => Promise<SideChatSourceState>;

/** One AgentRun as its parent thread's summary reports it. */
export interface SideChatSubagentSummary {
  readonly role: string;
  readonly task: string;
  readonly lifecycleStatus: string;
  readonly result?: unknown;
  readonly resultText?: string;
  readonly updatedAt: string;
}

/**
 * Read-only host reads behind a Side Chat's state section. Each is an existing
 * authorized read: Code's thread read and checkout observation re-check this
 * window's Project access, the conversation reader re-authorizes per page, and
 * subagent results are read by the parent thread id the caller already proved
 * this window may Open.
 */
export interface SideChatSourceStatePorts {
  readonly code?: {
    readonly readThread: (
      windowId: WindowId,
      threadId: CodeThreadId,
    ) => Promise<{
      readonly projectId: ProjectId;
      readonly workingDirectory?: string | undefined;
      readonly deliveryTarget: {
        readonly outcomeKind: string;
        readonly branchIntent: string;
        readonly remoteName: string;
        readonly proposedBaseRepository: string;
        readonly proposedBaseBranch: string;
      };
    }>;
    readonly observeCheckout: (
      windowId: WindowId,
      projectId: ProjectId,
      threadId: CodeThreadId,
    ) => Promise<CodeEnvironmentObservation>;
    readonly conversation: (
      windowId: WindowId,
      threadId: CodeThreadId,
      afterCursor: number,
      limit: number,
    ) => Promise<{
      readonly turns: ReadonlyArray<{ readonly changedFiles?: CodeTurnChangedFiles | undefined }>;
      readonly nextCursor: number;
      readonly hasMore: boolean;
    }>;
  };
  readonly work?: {
    readonly readFolder: (
      windowId: WindowId,
      threadId: WorkThreadId,
    ) => Promise<{ readonly projectName: string; readonly workingDirectory?: string } | undefined>;
  };
  readonly subagents?: (parentThreadId: string) => ReadonlyArray<SideChatSubagentSummary>;
}

export function createSideChatSourceStateReader(
  ports: SideChatSourceStatePorts,
): SideChatSourceStateReader {
  return async (windowId, source) => {
    const subagents = readSubagents(ports, String(source.threadId));
    if (source.mode === "code" && ports.code !== undefined) {
      const code = ports.code;
      const threadId = decodeCodeThreadId(String(source.threadId));
      const [thread, changedFiles] = await Promise.all([
        code.readThread(windowId, threadId).catch(() => undefined),
        readChangedFiles(code.conversation, windowId, threadId),
      ]);
      const checkout =
        thread === undefined
          ? ({ kind: "unavailable" } as const)
          : await readCheckout(code.observeCheckout, windowId, thread, threadId);
      return {
        checkout,
        changedFiles,
        ...(thread === undefined ? {} : { deliveryTarget: deliveryTarget(thread.deliveryTarget) }),
        subagents,
      };
    }
    if (source.mode === "work" && ports.work !== undefined) {
      let folder: SideChatWorkFolderState;
      try {
        const read = await ports.work.readFolder(
          windowId,
          decodeWorkThreadId(String(source.threadId)),
        );
        folder =
          read === undefined
            ? { kind: "unavailable" }
            : {
                kind: "observed",
                projectName: read.projectName,
                ...(read.workingDirectory === undefined
                  ? {}
                  : { workingDirectory: read.workingDirectory }),
              };
      } catch {
        folder = { kind: "unavailable" };
      }
      return { workFolder: folder, subagents };
    }
    return { subagents };
  };
}

async function readCheckout(
  observe: NonNullable<SideChatSourceStatePorts["code"]>["observeCheckout"],
  windowId: WindowId,
  thread: { readonly projectId: ProjectId; readonly workingDirectory?: string | undefined },
  threadId: CodeThreadId,
): Promise<SideChatCheckoutState> {
  let observation: CodeEnvironmentObservation;
  try {
    observation = await observe(windowId, thread.projectId, threadId);
  } catch {
    return { kind: "unavailable" };
  }
  if (observation.status !== "ready") return { kind: "unavailable" };
  return {
    kind: "observed",
    branch: observation.branch,
    changes: observation.changes,
    ...(observation.insertions === undefined ? {} : { insertions: observation.insertions }),
    ...(observation.deletions === undefined ? {} : { deletions: observation.deletions }),
    ...(thread.workingDirectory === undefined ? {} : { workingDirectory: thread.workingDirectory }),
  };
}

/**
 * Paths the host recorded changing while the thread's turns ran, newest turn
 * first and each path once, using the counts from the turn that last changed
 * it. These records are journaled observations of the checkout, so reading
 * them runs no Git and cannot disturb the working tree.
 */
async function readChangedFiles(
  conversation: NonNullable<SideChatSourceStatePorts["code"]>["conversation"],
  windowId: WindowId,
  threadId: CodeThreadId,
): Promise<SideChatChangedFilesState> {
  const turns = await walkCodeConversation(conversation, windowId, threadId);
  if (turns === undefined) return { kind: "unavailable" };
  const seen = new Set<string>();
  const files: SideChatChangedFile[] = [];
  let truncated = false;
  for (const turn of [...turns].reverse()) {
    const changed = turn.changedFiles;
    if (changed === undefined) continue;
    if (changed.truncated) truncated = true;
    for (const file of changed.files) {
      if (seen.has(String(file.path))) continue;
      seen.add(String(file.path));
      // One past the cap is enough for the formatter to say the list was cut.
      if (files.length > MAX_SIDE_CHAT_SOURCE_CHANGED_PATHS) {
        truncated = true;
        continue;
      }
      files.push({
        path: String(file.path),
        insertions: file.insertions,
        deletions: file.deletions,
        ...(file.binary === true ? { binary: true } : {}),
      });
    }
  }
  return { kind: "observed", files, truncated };
}

function deliveryTarget(target: {
  readonly outcomeKind: string;
  readonly branchIntent: string;
  readonly remoteName: string;
  readonly proposedBaseRepository: string;
  readonly proposedBaseBranch: string;
}): SideChatDeliveryTargetState {
  return {
    outcomeKind: target.outcomeKind,
    branchIntent: target.branchIntent,
    remoteName: target.remoteName,
    baseRepository: target.proposedBaseRepository,
    baseBranch: target.proposedBaseBranch,
  };
}

function readSubagents(ports: SideChatSourceStatePorts, threadId: string): SideChatSubagentsState {
  if (ports.subagents === undefined) return { kind: "observed", runs: [] };
  let summaries: ReadonlyArray<SideChatSubagentSummary>;
  try {
    summaries = ports.subagents(threadId);
  } catch {
    return { kind: "unavailable" };
  }
  const newestFirst = [...summaries].sort((left, right) =>
    left.updatedAt === right.updatedAt ? 0 : left.updatedAt < right.updatedAt ? 1 : -1,
  );
  return {
    kind: "observed",
    runs: newestFirst.map((run) => ({
      role: run.role,
      task: run.task,
      status: run.lifecycleStatus,
      ...(run.resultText === undefined ? {} : { resultText: run.resultText }),
      ...(run.result !== undefined && run.resultText === undefined ? { resultPurged: true } : {}),
    })),
  };
}
