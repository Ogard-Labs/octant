import {
  MAX_CODE_CONVERSATION_PAGE_SIZE,
  decodeCodeCommand,
  decodeCodeOperationCommand,
  decodeCodeOperationId,
  decodeCodeThreadId,
  decodeProviderSessionId,
  type CodeCommand,
  type CodeCommandResult,
  type CodeConversationPage,
  type CodeEvidenceReference,
  type CodeOperationCommand,
  type CodeOperationResult,
  type ProjectId,
  type ProviderExecutionPolicy,
  type ProviderInstanceId,
  type ProviderModelId,
  type WindowId,
} from "@octant/contracts";
import {
  BENCHMARK_CODE_DIFF_FILES,
  boundedBenchmarkReason,
  type BenchmarkCodeDiffSummary,
} from "@octant/domain";
import { CodeServiceError } from "../code/codeService";
import { deterministicUuid } from "../deterministicUuid";

/** The longest reply read back from a Code turn. */
const MAX_CODE_REPLY_CHARS = 50_000;
const MAX_CONVERSATION_PAGES = 100;

export type BenchmarkCodeTurnReading =
  | { readonly status: "gone" }
  | { readonly status: "no-turn" }
  | {
      readonly status: "turn";
      readonly turnId: string;
      readonly state: "in-flight" | "completed" | "interrupted" | "failed";
      /** The turn is parked on an approval or a question only a person can answer. */
      readonly awaitingApproval: boolean;
      /**
       * When the wait began, as the journal recorded it. Absent when the host
       * cannot say, which a restart must not read as "just now".
       */
      readonly waitingSince?: string;
      /** What the pending approval or question asks, when the host can say. */
      readonly approvalSummary?: string;
      readonly failureMessage?: string;
    };

export type BenchmarkCodeTurnStart =
  | { readonly status: "started"; readonly turnId: string }
  /** Ordinary admission has no room yet; the cell stays queued. */
  | { readonly status: "waiting"; readonly message: string }
  | { readonly status: "refused"; readonly message: string };

export interface BenchmarkCodeTurnInput {
  readonly threadId: string;
  readonly title: string;
  readonly codeProjectId: ProjectId;
  readonly ref: string;
  /** The commit the run pinned the ref to; absent on an older run, which resolves the ref itself. */
  readonly commit?: string;
  /** The local branch the cell works on; never pushed. */
  readonly branch: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly effort?: string;
  readonly prompt: string;
  readonly submissionId: string;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly autoApprove: boolean;
}

export interface BenchmarkCodeResult {
  /** The turn's reply text; absent when it said nothing. */
  readonly reply: string | undefined;
  /** Paths and line counts only, never diff text; absent when the host did not observe them. */
  readonly diff: BenchmarkCodeDiffSummary | undefined;
}

export type BenchmarkWorktreeRemoval =
  | "removed"
  | "absent"
  | { readonly status: "refused"; readonly message: string };

/**
 * What the runner may ask of Code. Every method goes through the ordinary
 * Code commands and operations, under the host's own scope, so thread
 * creation, provider admission, approvals and the turn's confinement apply
 * exactly as they do to a routine's Code thread.
 */
export interface BenchmarkCodePort {
  /** The commit the ref resolves to in the Code Project's repository. Reads only. */
  checkRef(
    codeProjectId: ProjectId,
    ref: string,
  ): Promise<
    | { readonly status: "ok"; readonly commit: string }
    | { readonly status: "refused"; readonly message: string }
  >;
  /** Creates the managed thread if missing and starts its one turn. Safe to repeat. */
  startTurn(input: BenchmarkCodeTurnInput): Promise<BenchmarkCodeTurnStart>;
  readTurn(threadId: string, submissionId: string): Promise<BenchmarkCodeTurnReading>;
  readResult(threadId: string, submissionId: string): Promise<BenchmarkCodeResult>;
  interruptTurn(threadId: string, submissionId: string): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  /** The cell's worktree folder, when it still exists. */
  worktreeRoot(threadId: string): Promise<string | undefined>;
  /**
   * Removes the cell's managed worktree, uncommitted changes included, and the
   * one local branch the cell made, through the managed-worktree service.
   */
  removeWorktree(threadId: string, branch: string): Promise<BenchmarkWorktreeRemoval>;
}

/** The slice of the Code route service the adapter uses. */
export interface BenchmarkCodeRouteService {
  readonly execute: (
    windowId: WindowId,
    command: CodeCommand,
  ) => Promise<CodeCommandResult> | CodeCommandResult;
  readonly executeOperation: (
    windowId: WindowId,
    command: CodeOperationCommand,
  ) => Promise<CodeOperationResult> | CodeOperationResult;
  readonly conversation: (
    windowId: WindowId,
    threadId: ReturnType<typeof decodeCodeThreadId>,
    afterCursor: number,
    limit: number,
  ) => Promise<CodeConversationPage> | CodeConversationPage;
  readonly readOperationContent: (
    windowId: WindowId,
    threadId: ReturnType<typeof decodeCodeThreadId>,
    operationId: ReturnType<typeof decodeCodeOperationId>,
    contentId: string,
  ) => Promise<{ readonly bytes: Uint8Array }> | { readonly bytes: Uint8Array };
}

export interface CreateBenchmarkCodePortOptions {
  readonly code: BenchmarkCodeRouteService;
  /** The host's own scope, the one routines and goal rounds act under. */
  readonly windowId: WindowId;
  readonly readThread: (threadId: string) =>
    | {
        readonly version: number;
        readonly checkoutId: string;
        readonly lifecycle: string;
      }
    | undefined;
  /** Whether the thread's running turn waits on an approval or a question. */
  readonly awaitsPerson: (threadId: string) => boolean;
  /** When the thread's oldest pending request was asked, from the journal; absent when unknown. */
  readonly pendingApproval?: (
    threadId: string,
  ) =>
    | Promise<{ readonly since: string; readonly summary: string } | undefined>
    | { readonly since: string; readonly summary: string }
    | undefined;
  readonly evidence: { readonly put: (text: string) => CodeEvidenceReference };
  readonly clock: () => string;
  readonly resolveRoot: (threadId: string) => Promise<string | undefined>;
  readonly removeWorktree: (threadId: string, branch: string) => Promise<BenchmarkWorktreeRemoval>;
}

const SOURCE_REFUSAL: Readonly<Record<string, string>> = {
  "ref-unavailable": "that ref does not exist in the Code Project's repository",
  "ambiguous-ref": "that ref names more than one thing",
  "remote-unavailable": "the Code Project's repository has no remote to read it from",
  "fetch-rejected": "the Code Project's repository could not be read",
  unavailable: "the Code Project's repository is unavailable",
  cancelled: "the check was cancelled",
};

/** The operation and session a cell's Code turn runs under, fixed by its submission id. */
export function benchmarkCodeOperationIdentity(submissionId: string): {
  readonly operationId: string;
  readonly sessionId: string;
} {
  return {
    operationId: submissionId,
    sessionId: deterministicUuid(`benchmark-code-session:${submissionId}`),
  };
}

export function createBenchmarkCodePort(
  options: CreateBenchmarkCodePortOptions,
): BenchmarkCodePort {
  const { code, windowId } = options;

  /** Full ref names to try, so a bare name finds a branch first and then a tag. */
  const candidates = (ref: string): ReadonlyArray<string> =>
    /^[a-f0-9]{40}$|^[a-f0-9]{64}$|^refs\//.test(ref)
      ? [ref]
      : [`refs/heads/${ref}`, `refs/tags/${ref}`];

  type Source =
    | {
        readonly status: "ready";
        readonly bindingRevisionId: string;
        readonly repositoryId: string;
        readonly resolvedHead: string;
      }
    | { readonly status: "refused"; readonly message: string }
    | { readonly status: "waiting"; readonly message: string };

  const resolveSource = async (
    projectId: ProjectId,
    ref: string,
    pinned?: string,
  ): Promise<Source> => {
    const prepared = await code.execute(
      windowId,
      decodeCodeCommand({ kind: "prepare-code-project-checkout", projectId }),
    );
    if (prepared.kind !== "checkout-prepared") {
      return { status: "refused", message: "The Code Project's repository is unavailable." };
    }
    // A pinned commit is the run's own answer: the ref is not read again, so a
    // branch that moved since the run started changes nothing.
    if (pinned !== undefined) {
      return {
        status: "ready",
        bindingRevisionId: String(prepared.bindingRevisionId),
        repositoryId: String(prepared.checkout.repositoryId),
        resolvedHead: pinned,
      };
    }
    let reason = "ref-unavailable";
    for (const refIntent of candidates(ref)) {
      const result = await code.execute(
        windowId,
        decodeCodeCommand({
          kind: "preview-code-worktree-source",
          projectId,
          bindingRevisionId: prepared.bindingRevisionId,
          repositoryId: prepared.checkout.repositoryId,
          refIntent,
          startFromOrigin: false,
        }),
      );
      if (result.kind !== "worktree-source-previewed") continue;
      if (result.preview.kind === "failed") {
        reason = result.preview.reason;
        continue;
      }
      return {
        status: "ready",
        bindingRevisionId: String(prepared.bindingRevisionId),
        repositoryId: String(prepared.checkout.repositoryId),
        resolvedHead: String(result.preview.resolvedHead),
      };
    }
    return {
      status: "refused",
      message: `The ref "${ref}" cannot be used: ${SOURCE_REFUSAL[reason] ?? "it could not be resolved"}.`,
    };
  };

  const readTurnOf = async (threadId: string, operationId: string) => {
    const id = decodeCodeThreadId(threadId);
    let cursor = 0;
    for (let page = 0; page < MAX_CONVERSATION_PAGES; page += 1) {
      const read = await code.conversation(windowId, id, cursor, MAX_CODE_CONVERSATION_PAGE_SIZE);
      const turn = read.turns.find((candidate) => String(candidate.operationId) === operationId);
      if (turn !== undefined) return turn;
      if (!read.hasMore || read.nextCursor <= cursor) return undefined;
      cursor = read.nextCursor;
    }
    return undefined;
  };

  return {
    async checkRef(codeProjectId, ref) {
      try {
        const source = await resolveSource(codeProjectId, ref);
        return source.status === "ready"
          ? { status: "ok", commit: source.resolvedHead }
          : { status: "refused", message: source.message };
      } catch (error) {
        return {
          status: "refused",
          message: boundedBenchmarkReason(
            error instanceof Error ? error.message : "The ref could not be checked.",
            300,
          ),
        };
      }
    },

    async startTurn(input) {
      try {
        const threadId = decodeCodeThreadId(input.threadId);
        let thread = options.readThread(input.threadId);
        if (thread === undefined) {
          const source = await resolveSource(input.codeProjectId, input.ref, input.commit);
          if (source.status !== "ready") return source;
          const created = await code.execute(
            windowId,
            decodeCodeCommand({
              kind: "create-managed-code-thread",
              threadId,
              projectId: input.codeProjectId,
              bindingRevisionId: source.bindingRevisionId,
              title: input.title,
              providerInstanceId: input.providerInstanceId,
              modelId: input.modelId,
              ...(input.effort === undefined
                ? {}
                : { modelOptionValues: { effort: input.effort } }),
              executionPolicy: input.executionPolicy,
              ...(input.autoApprove ? { autoApprove: true } : {}),
              permissionPersistence: "current-session",
              // Local only: the branch is never pushed and nothing proposes a pull request.
              deliveryTarget: {
                branchIntent: input.branch,
                remoteName: "origin",
                proposedBaseRepository: source.repositoryId,
                proposedBaseBranch: input.ref.slice(0, 255),
                outcomeKind: "local-implementation",
                confirmedAt: options.clock(),
              },
              sourceBranch: input.ref,
              startFromOrigin: false,
              // The pinned commit, so every contender starts from the same files.
              sourceRevision: source.resolvedHead,
            }),
          );
          if (created.kind !== "managed-thread-created") {
            return {
              status: "refused",
              message: "The Code thread could not be created for this cell.",
            };
          }
          thread = options.readThread(input.threadId);
        }
        if (thread === undefined) {
          return { status: "refused", message: "The Code thread is not available." };
        }
        const { operationId, sessionId } = benchmarkCodeOperationIdentity(input.submissionId);
        const result = await code.executeOperation(
          windowId,
          decodeCodeOperationCommand({
            kind: "start-provider-turn",
            threadId,
            checkoutId: thread.checkoutId,
            operationId,
            sessionId: decodeProviderSessionId(sessionId),
            prompt: options.evidence.put(input.prompt),
            // The thread's own level; a turn can only narrow it, never widen it.
            executionPolicy: input.executionPolicy,
          }),
        );
        if (
          result.kind === "provider-turn-state" &&
          (result.state === "running" || result.state === "waiting" || result.state === "completed")
        ) {
          return { status: "started", turnId: operationId };
        }
        if (result.kind === "operation-failed" || result.kind === "provider-turn-state") {
          const failure = result.failure;
          if (failure?.category === "waiting") {
            return { status: "waiting", message: failure.message };
          }
          return {
            status: "refused",
            message: failure?.message ?? "The Code turn was not accepted.",
          };
        }
        return { status: "refused", message: "The Code turn was not accepted." };
      } catch (error) {
        if (error instanceof CodeServiceError) {
          return error.failure.category === "waiting"
            ? { status: "waiting", message: error.failure.message }
            : { status: "refused", message: error.failure.message };
        }
        return {
          status: "refused",
          message: boundedBenchmarkReason(
            error instanceof Error ? error.message : "The Code turn could not be started.",
            300,
          ),
        };
      }
    },

    async readTurn(threadId, submissionId) {
      if (options.readThread(threadId) === undefined) return { status: "gone" };
      const { operationId } = benchmarkCodeOperationIdentity(submissionId);
      let turn;
      try {
        turn = await readTurnOf(threadId, operationId);
      } catch {
        return { status: "gone" };
      }
      if (turn === undefined) return { status: "no-turn" };
      const state =
        turn.status === "completed"
          ? "completed"
          : turn.status === "interrupted"
            ? "interrupted"
            : turn.status === "failed"
              ? "failed"
              : "in-flight";
      const awaitingApproval = state === "in-flight" && options.awaitsPerson(threadId);
      const pending = awaitingApproval ? await options.pendingApproval?.(threadId) : undefined;
      return {
        status: "turn",
        turnId: operationId,
        state,
        awaitingApproval,
        ...(pending === undefined
          ? {}
          : { waitingSince: pending.since, approvalSummary: pending.summary }),
        ...(turn.failure === undefined ? {} : { failureMessage: turn.failure.message }),
      };
    },

    async readResult(threadId, submissionId) {
      const { operationId } = benchmarkCodeOperationIdentity(submissionId);
      let turn;
      try {
        turn = await readTurnOf(threadId, operationId);
      } catch {
        return { reply: undefined, diff: undefined };
      }
      if (turn === undefined) return { reply: undefined, diff: undefined };
      const decoder = new TextDecoder();
      let reply = "";
      for (const part of turn.assistant) {
        if (reply.length >= MAX_CODE_REPLY_CHARS) break;
        try {
          const content = await code.readOperationContent(
            windowId,
            decodeCodeThreadId(threadId),
            decodeCodeOperationId(operationId),
            String(part.contentId),
          );
          reply += decoder.decode(content.bytes);
        } catch {
          // Evidence the host cannot serve is left out, never replaced by a guess.
        }
      }
      const trimmed = reply.trim();
      return {
        reply: trimmed === "" ? undefined : trimmed.slice(0, MAX_CODE_REPLY_CHARS),
        diff:
          turn.changedFiles === undefined
            ? undefined
            : {
                files: turn.changedFiles.files.slice(0, BENCHMARK_CODE_DIFF_FILES).map((file) => ({
                  path: String(file.path),
                  insertions: file.insertions,
                  deletions: file.deletions,
                })),
                total: turn.changedFiles.total,
              },
      };
    },

    async interruptTurn(threadId, submissionId) {
      const thread = options.readThread(threadId);
      if (thread === undefined) return;
      const { operationId } = benchmarkCodeOperationIdentity(submissionId);
      try {
        await code.executeOperation(
          windowId,
          decodeCodeOperationCommand({
            kind: "cancel-provider-turn",
            operationId,
            threadId: decodeCodeThreadId(threadId),
            checkoutId: thread.checkoutId,
          }),
        );
      } catch {
        // A turn that already ended has nothing to interrupt.
      }
    },

    async archiveThread(threadId) {
      const thread = options.readThread(threadId);
      if (thread === undefined || thread.lifecycle !== "active") return;
      try {
        await code.execute(
          windowId,
          decodeCodeCommand({
            kind: "change-code-thread-lifecycle",
            threadId: decodeCodeThreadId(threadId),
            expectedVersion: thread.version,
            lifecycle: "archived",
          }),
        );
      } catch {
        // The cell is settled; a thread left active only shows in a list.
      }
    },

    worktreeRoot: (threadId) => options.resolveRoot(threadId),

    async removeWorktree(threadId, branch) {
      try {
        return await options.removeWorktree(threadId, branch);
      } catch (error) {
        return {
          status: "refused",
          message: boundedBenchmarkReason(
            error instanceof Error ? error.message : "The worktree could not be removed.",
            200,
          ),
        };
      }
    },
  };
}
