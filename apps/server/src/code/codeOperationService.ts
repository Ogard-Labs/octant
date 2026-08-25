import {
  decodeCodeOperationCommand,
  decodeCodeOperationResult,
  type CodeApprovalEffect,
  type CodeAttachmentId,
  type CodeAttachmentReference,
  type CodeCheckpoint,
  type CodeCheckoutIdentity,
  type CodeEvidenceReference,
  type CodeOperationEvent,
  type CodeOperationEventFrame,
  type CodeOperationCommand,
  type CodeOperationId,
  type CodeOperationResult,
  type CodeTerminalId,
  type CodeRepositoryTestDefinition,
  type CodeRepositoryTestRun,
  type CodeReviewFinding,
  type CodeThread,
  type CodeThreadForkOrigin,
  type CodeThreadId,
  type MentionableThreadId,
  type ScaffoldEntry,
  type ScaffoldRun,
  type ProviderAttachmentInput,
  type ProviderContextBlock,
  type WindowId,
} from "@octant/contracts";
import {
  authorizeCodeOperation,
  clampTurnAccessPosture,
  mayWriteToRepository,
  type CodeOperation,
} from "@octant/domain/code-policy";
import {
  decideRunMerge,
  FILE_MENTION_UNREADABLE_CONTEXT,
  runMergeRefusalText,
  THREAD_MENTION_UNREADABLE_CONTEXT,
} from "@octant/domain";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import type { CodeAttachmentStore } from "./codeAttachmentStore";
import type { CodeApprovalValidationPort } from "./codeOperationApprovalStore";
import { codeRepositoryTestDefinitionsMatch } from "./repositoryTestDiscoveryService";
import { ReviewFindingServiceError } from "./reviewFindingService";

type Awaitable<T> = T | Promise<T>;

export interface CodeOperationAuthorityPort {
  readonly readThread: (threadId: CodeOperationCommand["threadId"]) => CodeThread | undefined;
  readonly effectiveThread?: (windowId: WindowId, thread: CodeThread) => CodeThread;
  readonly readCheckout: (
    checkoutId: Extract<CodeOperationCommand, { readonly checkoutId: unknown }>["checkoutId"],
  ) => CodeCheckoutIdentity | undefined;
  readonly canAccessProject: (
    windowId: WindowId,
    projectId: CodeThread["projectId"],
  ) => Awaitable<boolean>;
  readonly approvalContextDigest?: (
    windowId: WindowId,
    command: CodeOperationCommand,
    thread: CodeThread,
    checkout: CodeCheckoutIdentity,
  ) => Awaitable<string | undefined>;
  readonly resolveCheckoutRoot: (
    windowId: WindowId,
    thread: CodeThread,
    checkout: CodeCheckoutIdentity,
  ) => Awaitable<
    | Readonly<{
        checkoutRoot: string;
        workingDirectory?: string;
        shell: string;
        credentialReferences: readonly {
          readonly environmentName: string;
          readonly reference: string;
        }[];
        environment: Readonly<Record<string, string | undefined>>;
      }>
    | undefined
  >;
}

export interface CodeOperationEvidencePort {
  readonly put: (
    content: string,
    metadata?: { readonly truncated?: boolean },
  ) => CodeEvidenceReference;
  readonly read?: (reference: CodeEvidenceReference) => Awaitable<string | undefined>;
}

export type CodeOperationReplay =
  | {
      readonly status: "ok";
      readonly frames: ReadonlyArray<CodeOperationEventFrame>;
      readonly nextCursor: number;
    }
  | {
      readonly status: "snapshot-required";
      readonly reason:
        | "gap"
        | "identity-mismatch"
        | "invalid-frame"
        | "cursor-ahead"
        | "scan-limit";
    };

export interface CodeOperationEventPort {
  readonly append: (input: {
    readonly threadId: CodeThreadId;
    readonly operationId: CodeOperationId;
    readonly expectedCursor: number;
    readonly event: CodeOperationEvent;
  }) => void;
  readonly replay: (input: {
    readonly threadId: CodeThreadId;
    readonly operationId: CodeOperationId;
    readonly afterCursor: number;
    readonly limit: number;
  }) => CodeOperationReplay;
}

export class CodeOperationSnapshotRequiredError extends Error {
  override readonly name = "CodeOperationSnapshotRequiredError";

  constructor(
    readonly reason: Extract<
      CodeOperationReplay,
      { readonly status: "snapshot-required" }
    >["reason"],
  ) {
    super("Code operation snapshot is required.");
  }
}

export class CodeOperationServiceError extends Error {
  override readonly name = "CodeOperationServiceError";

  constructor(readonly category: "invalid" | "unauthorized" | "unavailable") {
    super(`Code operation is ${category}.`);
  }
}

export interface CodeOperationTerminalPort {
  readonly launch: (input: {
    readonly terminalId: string;
    readonly shell: string;
    readonly cwd: string;
    /** Authority this shell's persisted state belongs to; see TerminalLaunchInput. */
    readonly stateScope: string;
    readonly columns: number;
    readonly rows: number;
    readonly credentialReferences: readonly {
      readonly environmentName: string;
      readonly reference: string;
    }[];
  }) => Promise<CodeOperationTerminalSnapshot>;
  readonly attach: (terminalId: string) => CodeOperationTerminalSnapshot;
  readonly observe?: (
    terminalId: string,
    listener: (emission: TerminalOutputEmission) => void,
    options?: { readonly afterCharacters: number },
  ) => () => void;
  readonly write: (terminalId: string, data: string) => void;
  readonly resize: (terminalId: string, columns: number, rows: number) => void;
  readonly terminate: (terminalId: string) => Promise<CodeOperationTerminalSnapshot>;
}

export interface CodeOperationTerminalSnapshot {
  readonly terminalId: string;
  readonly status: "running" | "exited" | "interrupted";
  readonly exitCode?: number;
  readonly transcript: {
    readonly chunks: readonly string[];
    readonly truncated: boolean;
    readonly characters: number;
  };
}

interface TerminalOutputEmission {
  readonly text: string;
  readonly replace: boolean;
  readonly snapshot: CodeOperationTerminalSnapshot;
}

/**
 * One surface following a terminal, and how far its journal has been written.
 *
 * A terminal can be open in more than one place at once — a workspace tab and
 * a pinned card are two windows onto the same shell — and each of them reads
 * its own operation, so each needs its own cursor.
 */
interface TerminalOutputReader {
  readonly operationId: CodeOperationId;
  nextCursor: number;
  /**
   * When this reader last read its operation. A surface that has gone — closed,
   * unpinned, or taken down with its window — stops reading but cannot say so,
   * so reading is the only honest evidence that anyone is still there.
   */
  lastReadTick: number;
  lastTerminalStatus?: CodeOperationTerminalSnapshot["status"];
  lastExitCode?: number;
}

/**
 * How many surfaces may follow one terminal at once.
 *
 * Comfortably above the surfaces a person opens on one shell, and low enough
 * that readers left behind by a surface that never said goodbye are collected
 * instead of accumulating for as long as the shell lives.
 */
const MAX_TERMINAL_READERS = 4;

interface TerminalOwner {
  readonly windowId: string;
  readonly threadId: string;
  readonly checkoutId: string;
  /** Every surface currently following this terminal, keyed by its operation. */
  readonly readers: Map<string, TerminalOutputReader>;
  removeOutputListener?: () => void;
  /** How far the surface has already been caught up by the snapshot it was sent. */
  outputBaseline?: number;
}

export interface CodeOperationRepositoryTestPort {
  /**
   * The definitions this checkout offers, as the server derived them. A run is
   * authorized against this list, so the port must answer for the exact
   * checkout root the run would execute in.
   */
  readonly discover: (input: {
    readonly checkoutId: string;
    readonly rootPath: string;
  }) => Promise<ReadonlyArray<CodeRepositoryTestDefinition>>;
  readonly run: (input: {
    readonly runId: string;
    readonly definition: Extract<
      CodeOperationCommand,
      { readonly kind: "run-repository-test" }
    >["definition"];
    readonly threadId: CodeThread["id"];
    readonly checkoutId: CodeThread["checkoutId"];
    readonly checkoutRevision: string;
    readonly executionPolicy: CodeThread["executionPolicy"];
    readonly checkoutRoot: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
  }) => Promise<CodeRepositoryTestRun>;
  readonly cancel: (input: {
    readonly testRunId: string;
    readonly threadId: CodeThread["id"];
    readonly checkoutId: CodeThread["checkoutId"];
  }) => Promise<boolean>;
}

/**
 * The curated scaffolds this host offers, and the one gesture that runs one.
 *
 * A host without this port has no scaffolds: the operation is refused rather
 * than run against a catalog nobody published.
 */
export interface CodeOperationScaffoldPort {
  readonly entry: (scaffoldId: string) => ScaffoldEntry | undefined;
  readonly run: (input: {
    readonly runId: string;
    readonly entry: ScaffoldEntry;
    readonly directoryName: string;
    readonly threadId: CodeThread["id"];
    readonly checkoutId: CodeThread["checkoutId"];
    readonly executionPolicy: CodeThread["executionPolicy"];
    readonly checkoutRoot: string;
  }) => Promise<
    | { readonly status: "ran"; readonly run: ScaffoldRun }
    | { readonly status: "refused"; readonly message: string }
  >;
}

export interface CodeOperationGitPort {
  readonly observe: (input: {
    readonly checkoutRoot: string;
    readonly maxDiffBytes: number;
  }) => Promise<{
    readonly status: "ready" | "unavailable" | "failed";
    readonly head?: {
      readonly kind: "branch" | "detached" | "unborn";
      readonly name?: string;
      readonly oid?: string;
    };
    readonly stateToken?: string;
    readonly statusEntries?: readonly {
      readonly path: string;
      readonly originalPath?: string | undefined;
      readonly index: string;
      readonly worktree: string;
    }[];
    readonly changedPaths?: readonly string[];
    readonly diff?: string;
    readonly diffTruncated?: boolean;
    readonly remotes?: readonly {
      readonly name: string;
      readonly fetch: { readonly kind: "network" | "local"; readonly url?: string };
      readonly push: { readonly kind: "network" | "local"; readonly url?: string };
    }[];
    readonly upstream?: { readonly remote: string; readonly mergeRef: string } | null;
    readonly worktrees?: readonly {
      readonly checkoutId: string;
      readonly head: {
        readonly kind: "branch" | "detached" | "unborn";
        readonly name?: string;
        readonly oid?: string;
      };
      readonly state: "active" | "locked" | "prunable" | "unavailable";
    }[];
  }>;
  readonly stage: (input: {
    readonly checkoutId: string;
    readonly checkoutRoot: string;
    readonly paths: readonly string[];
    readonly expectedStateToken: string;
  }) => Promise<GitMutationOutcome>;
  readonly unstage: (input: {
    readonly checkoutId: string;
    readonly checkoutRoot: string;
    readonly paths: readonly string[];
    readonly expectedStateToken: string;
  }) => Promise<GitMutationOutcome>;
  readonly discard: (input: {
    readonly checkoutId: string;
    readonly checkoutRoot: string;
    readonly paths: readonly string[];
    readonly expectedStateToken: string;
  }) => Promise<GitMutationOutcome>;
  readonly commit: (input: {
    readonly checkoutId: string;
    readonly checkoutRoot: string;
    readonly message: string;
    readonly expectedStateToken: string;
    readonly stagedSummary: readonly {
      readonly path: string;
      readonly originalPath?: string | undefined;
      readonly index: string;
      readonly worktree: string;
    }[];
  }) => Promise<GitMutationOutcome>;
  readonly push: (input: {
    readonly checkoutId: string;
    readonly checkoutRoot: string;
    readonly remote: string;
    readonly localRef: string;
    readonly remoteRef: string;
    readonly confirmation: { readonly remote: string; readonly refspec: string };
    readonly expectedHeadOid: string;
    readonly expectedStateToken: string;
    readonly authority: "approved" | "full-access";
  }) => Promise<GitMutationOutcome>;
  /**
   * Measure one branch against another and say whether the base could take it.
   * Optional so a host assembled without it reports run review unavailable
   * rather than guessing at a comparison.
   */
  readonly compareBranch?: (input: {
    readonly checkoutRoot: string;
    readonly baseRef: string;
    readonly headRef: string;
  }) => Promise<
    | {
        readonly status: "ready";
        readonly head: string;
        readonly base?: string;
        readonly ahead: number;
        readonly behind: number;
        readonly mergeability: "clean" | "conflicts" | "nothing-to-merge" | "unknown";
      }
    | { readonly status: "unavailable" }
  >;
  /** The branch diff behind a run review. */
  readonly readBranchDiff?: (input: {
    readonly checkoutRoot: string;
    readonly baseRef: string;
  }) => Promise<
    | {
        readonly status: "ready";
        readonly paths: readonly string[];
        readonly diff: string;
        readonly diffTruncated: boolean;
      }
    | { readonly status: "unavailable" }
  >;
  /**
   * Merge a run's branch into the base branch, in the base checkout. Optional
   * so a host without it refuses to bring a run home rather than pretending to.
   */
  readonly mergeRun?: (input: {
    readonly checkoutRoot: string;
    readonly branch: string;
    readonly authority: "approved" | "full-access";
  }) => Promise<GitMutationOutcome & { readonly undo?: CodeCheckpoint }>;
  /**
   * Record the checkout's content without changing it. Optional so a host
   * assembled without checkpoint support simply runs turns that carry none.
   */
  readonly checkpoint?: (input: {
    readonly checkoutId: string;
    readonly checkoutRoot: string;
  }) => Promise<
    | { readonly status: "captured"; readonly snapshot: CodeCheckpoint }
    | { readonly status: "unavailable" }
  >;
  /**
   * Asks the thread's own provider for delivery text. Optional so a host with
   * no provider for the thread simply reports the draft unavailable.
   */
  readonly draft?: (input: {
    readonly thread: CodeThread;
    readonly checkoutRoot: string;
    readonly purpose: "commit-message" | "pull-request";
  }) => Promise<
    | { readonly status: "drafted"; readonly title: string; readonly body?: string }
    | { readonly status: "unavailable" | "failed" }
  >;
  readonly restoreCheckpoint?: (input: {
    readonly checkoutId: string;
    readonly checkoutRoot: string;
    readonly snapshot: CodeCheckpoint;
  }) => Promise<GitMutationOutcome & { readonly undo?: CodeCheckpoint }>;
}

type GitMutationOutcome =
  | { readonly status: "applied"; readonly oid?: string }
  | { readonly status: "rejected"; readonly reason?: string }
  | { readonly status: "unavailable" | "failed" };

export interface CodeOperationPullRequestPort {
  readonly ensure: (
    input: { readonly threadId: CodeThread["id"]; readonly title: string; readonly body: string },
    signal: AbortSignal,
  ) => Promise<
    | {
        readonly status: "created" | "existing";
        readonly pullRequest: {
          readonly number: number;
          readonly url: string;
          readonly baseRepository: string;
          readonly baseBranch: string;
          readonly headOwner: string;
          readonly headBranch: string;
        };
      }
    | { readonly status: "unavailable" }
  >;
  readonly observeReview: (
    input: { readonly threadId: CodeThread["id"]; readonly maxDiffBytes: number },
    signal: AbortSignal,
  ) => Promise<CodeOperationPullRequestReview>;
}

export type CodeOperationPullRequestReview =
  | {
      readonly status: "observed";
      readonly freshness: "fresh" | "stale";
      readonly ambiguous: boolean;
      readonly staleSections: readonly (
        | "description"
        | "commits"
        | "files"
        | "diff"
        | "checks"
        | "reviews"
        | "comments"
      )[];
      readonly pullRequest: {
        readonly number: number;
        readonly url: string;
        readonly title: string;
        readonly state: "open" | "merged" | "closed" | "draft";
        readonly baseRepository: string;
        readonly baseBranch: string;
        readonly headRepository: string;
        readonly headBranch: string;
        readonly author: string;
        readonly matchesDeliveryBranch: boolean;
      };
      readonly description: string;
      readonly diff: string;
      readonly diffTruncated: boolean;
      readonly commits: readonly {
        readonly oid: string;
        readonly messageHeadline: string;
        readonly author: string;
      }[];
      readonly files: readonly {
        readonly path: string;
        readonly additions: number;
        readonly deletions: number;
      }[];
      readonly checks: readonly {
        readonly name: string;
        readonly state: "success" | "failure" | "pending" | "neutral" | "unknown";
      }[];
      readonly reviews: readonly {
        readonly author: string;
        readonly state:
          | "approved"
          | "changes-requested"
          | "commented"
          | "dismissed"
          | "pending"
          | "unknown";
        readonly body: string;
      }[];
      readonly comments: readonly { readonly author: string; readonly body: string }[];
    }
  | { readonly status: "none" }
  | { readonly status: "unavailable" };

export interface CodeOperationReviewFindingPort {
  readonly create: (
    windowId: WindowId,
    input: Omit<CodeReviewFinding, "state" | "version" | "createdAt" | "updatedAt">,
  ) => Promise<CodeReviewFinding>;
  readonly changeState: (
    windowId: WindowId,
    input: {
      readonly findingId: string;
      readonly expectedVersion: number;
      readonly state: CodeReviewFinding["state"];
    },
  ) => Promise<CodeReviewFinding>;
}

export interface CodeOperationTurnPort {
  readonly start: (input: {
    readonly windowId: WindowId;
    readonly thread: CodeThread;
    readonly sessionId: string;
    readonly checkoutRoot: string;
    readonly prompt: string;
    /**
     * Read-only context this turn alone carries, beside the prompt.
     * The provider is sent it as separate context blocks, so it is never part
     * of the message the journal keeps and no later turn replays it.
     */
    readonly context?: ReadonlyArray<ProviderContextBlock>;
    /** Images this turn carries, already read from the host's own store. */
    readonly attachments?: ReadonlyArray<ProviderAttachmentInput>;
  }) => Promise<{
    readonly state: "running" | "waiting" | "completed" | "interrupted" | "failed";
    readonly evidence?: string;
  }>;
  readonly answerInput: (input: {
    readonly thread: CodeThread;
    readonly checkoutRoot: string;
    readonly requestId: string;
    readonly response: string;
  }) => Promise<CodeOperationTurnResult>;
  readonly answerApproval: (input: {
    readonly thread: CodeThread;
    readonly checkoutRoot: string;
    readonly approvalId: string;
    readonly decision: "approved" | "denied";
  }) => Promise<CodeOperationTurnResult>;
  readonly cancel: (input: {
    readonly thread: CodeThread;
    readonly checkoutRoot: string;
  }) => Promise<CodeOperationTurnResult>;
}

type CodeOperationTurnResult = {
  readonly state: "running" | "waiting" | "completed" | "interrupted" | "failed";
  readonly evidence?: string;
};

/**
 * What the host could resolve about one `#thread` mention a Code turn names.
 *
 * `unreadable` is reported rather than dropped: the user's own message still
 * shows the chip they typed, so a mention the host refused must be stated as
 * unread instead of leaving the model to treat an absent thread as one it was
 * shown. It carries no title, mode, or placement, so a refused Open leaks
 * nothing beyond the opaque id the sender already had.
 */
export type CodeThreadMentionContext =
  | {
      readonly kind: "resolved";
      readonly threadId: MentionableThreadId;
      /** Framed, bounded, read-only transcript of the mentioned thread. */
      readonly text: string;
    }
  | { readonly kind: "unreadable"; readonly threadId: MentionableThreadId };

/**
 * Who asked for the operation. `agent` is the default and is what approval
 * gating exists for; `user` marks the local person acting through their own
 * window (e.g. clicking Start terminal), which the policy treats as its own
 * approval for the classes it lists.
 */
export type CodeOperationInitiator = "user" | "agent";

export interface CodeOperationExecuteOptions {
  readonly initiator?: CodeOperationInitiator;
}

export interface CodeOperationServiceOptions {
  readonly authority: CodeOperationAuthorityPort;
  readonly approvals?: CodeApprovalValidationPort;
  readonly terminals: CodeOperationTerminalPort;
  readonly repositoryTests: CodeOperationRepositoryTestPort;
  readonly scaffolds?: CodeOperationScaffoldPort;
  readonly git: CodeOperationGitPort;
  /**
   * The Project checkout a run comes home to, as the host finds it right now.
   * Absent on a host that cannot resolve one, which refuses the merge rather
   * than merging into a checkout nobody located.
   */
  readonly resolveBaseCheckout?: (thread: CodeThread) => Promise<
    | {
        readonly status: "observed";
        readonly checkoutRoot: string;
        readonly branch: string | undefined;
        readonly clean: boolean;
      }
    | { readonly status: "unavailable" }
  >;
  readonly pullRequests: CodeOperationPullRequestPort;
  readonly reviewFindings: CodeOperationReviewFindingPort;
  readonly turns: CodeOperationTurnPort;
  readonly evidence: CodeOperationEvidencePort;
  /**
   * The images threads have staged. Optional: a host without one refuses a
   * turn that names an attachment rather than silently sending it without.
   */
  readonly attachments?: CodeAttachmentStore;
  /** Whether the thread's own provider and model can read an image. */
  readonly supportsAttachments?: (thread: CodeThread) => boolean;
  readonly events: CodeOperationEventPort;
  /**
   * Resolves the `#thread` mentions a Code turn names.
   *
   * The command carries ids only. The host re-derives this send's principal
   * Open authority over each named thread and reads its bounded transcript
   * itself, so a mention contributes exactly what the sender may still read at
   * the moment they send — never a transcript the renderer resolved earlier,
   * and never one it composed. Resolution happens per turn, so nothing a
   * mention contributed is journalled with the turn or replayed by the next.
   */
  readonly resolveThreadMentionContext?: (input: {
    readonly threadMentionIds: ReadonlyArray<MentionableThreadId>;
    readonly windowId: WindowId;
  }) => Promise<ReadonlyArray<CodeThreadMentionContext>>;
  /**
   * Resolves the `@file` mentions a Code turn names.
   *
   * The command carries relative paths only. The host classifies each path
   * against this thread's bound checkout and reads the file itself, so a
   * renderer cannot include bytes from outside the root. Out-of-root paths
   * are refused before any read and reported in words rather than dropped.
   */
  readonly resolveFileMentionContext?: (input: {
    readonly fileMentionPaths: ReadonlyArray<string>;
    readonly windowId: WindowId;
    readonly threadId: CodeThreadId;
    readonly checkoutId: CodeThread["checkoutId"];
  }) => Promise<ReadonlyArray<ProviderContextBlock>>;
  /**
   * Takes the notes the user pointed at the running product and hands them to
   * this turn. The port marks each note carried in the same step, so a note
   * travels exactly once; absent on a host with no browser surface, where a
   * thread simply has no notes waiting.
   */
  readonly takeProductFeedbackForTurn?: (input: {
    readonly threadId: CodeThreadId;
    readonly operationId: CodeOperationId;
    readonly supportsImages: boolean;
  }) => Promise<{
    readonly context?: string;
    readonly attachments: ReadonlyArray<ProviderAttachmentInput>;
  }>;
  /**
   * Reads the conversation a forked thread inherits, for its first turn only.
   *
   * A fork's own transcript starts empty, so without this its provider would be
   * answering from nothing while the user believes it continues a conversation.
   * The host reads the source thread itself and bounds what it hands over; a
   * source it cannot read contributes nothing rather than a claimed history.
   */
  readonly resolveForkHandoff?: (input: {
    readonly threadId: CodeThreadId;
    readonly origin: CodeThreadForkOrigin;
    readonly windowId: WindowId;
    /**
     * The turn asking for the handoff. Its own start event is already in the
     * journal by the time this runs, so the resolver has to know which turn to
     * discount before it can tell whether any earlier one exists.
     */
    readonly operationId: CodeOperationId;
  }) => Promise<string | undefined>;
}

export class CodeOperationService {
  readonly #options: CodeOperationServiceOptions;
  readonly #terminalOwners = new Map<string, TerminalOwner>();
  /** Counts reads, so the least recently read terminal reader is identifiable. */
  #terminalReadTick = 0;

  constructor(options: CodeOperationServiceOptions) {
    this.#options = options;
  }

  async execute(
    windowId: WindowId,
    rawCommand: unknown,
    options: CodeOperationExecuteOptions = {},
  ): Promise<CodeOperationResult> {
    const command = decodeCodeOperationCommand(rawCommand);
    const initiator = options.initiator ?? "agent";
    const scope = await this.#scope(windowId, command);
    if ("failure" in scope) return this.#failed(command.operationId, scope.failure, scope.message);
    const replay = this.#replay(command.threadId, command.operationId, 0, 256);
    const existing = replay.frames.find(
      (
        frame,
      ): frame is CodeOperationEventFrame & {
        readonly event: { readonly kind: "operation-result"; readonly result: CodeOperationResult };
      } => frame.event.kind === "operation-result",
    );
    if (existing !== undefined) {
      if (
        command.kind === "start-provider-turn" &&
        isStaleRunningProviderTurn(existing.event.result, replay.frames)
      ) {
        return this.#recoverStaleProviderTurn(
          windowId,
          command,
          scope.thread,
          scope.checkout,
          existing.event.result,
        );
      }
      return existing.event.result;
    }

    let result: CodeOperationResult;
    let resultCursor = replay.nextCursor;
    const gate = await this.#authorize(windowId, command, scope.thread, scope.checkout, initiator);
    if (gate !== "allow") {
      result = this.#failed(
        command.operationId,
        gate,
        gate === "waiting"
          ? "Code operation requires approval."
          : "Code operation is unauthorized.",
      );
      if (gate === "waiting") {
        const alreadyWaiting = replay.frames.some(
          (frame) => frame.event.kind === "operation-state" && frame.event.state === "waiting",
        );
        if (!alreadyWaiting) {
          this.#options.events.append({
            threadId: command.threadId,
            operationId: command.operationId,
            expectedCursor: replay.nextCursor,
            event: { kind: "operation-state", state: "waiting" },
          });
        }
        return result;
      }
    } else {
      const root = await this.#options.authority.resolveCheckoutRoot(
        windowId,
        scope.thread,
        scope.checkout,
      );
      if (root === undefined)
        result = this.#failed(
          command.operationId,
          "unavailable",
          "Code checkout authority is unavailable.",
        );
      else {
        const recordedStart = replay.frames.find(
          (
            frame,
          ): frame is CodeOperationEventFrame & {
            readonly event: Extract<
              CodeOperationEvent,
              { readonly kind: "conversation-turn-started" }
            >;
          } => frame.event.kind === "conversation-turn-started",
        );
        if (
          command.kind === "start-provider-turn" &&
          recordedStart !== undefined &&
          !sameConversationStart(recordedStart.event, command, scope.thread)
        ) {
          result = this.#failed(
            command.operationId,
            "invalid",
            "Provider turn identity does not match durable conversation evidence.",
          );
        } else {
          const starting =
            command.kind !== "start-provider-turn"
              ? ({ status: "ok", attachments: [] } as const)
              : recordedStart === undefined
                ? this.#startingAttachments(command.threadId, command.attachmentIds)
                : ({ status: "ok", attachments: recordedStart.event.attachments ?? [] } as const);
          if (starting.status === "unknown") {
            result = this.#failed(
              command.operationId,
              "invalid",
              "An image attached to this turn is no longer staged.",
            );
          } else {
            const turnThread =
              command.kind === "start-provider-turn"
                ? threadForTurn(
                    scope.thread,
                    turnAccessPosture(scope.thread, command, recordedStart?.event.executionPolicy),
                  )
                : scope.thread;
            if (command.kind === "start-provider-turn" && recordedStart === undefined) {
              const checkpoint = await this.#checkpoint(
                turnThread,
                scope.checkout.id,
                root.checkoutRoot,
              );
              this.#options.events.append({
                threadId: command.threadId,
                operationId: command.operationId,
                expectedCursor: resultCursor,
                event: {
                  kind: "conversation-turn-started",
                  providerInstanceId: scope.thread.providerInstanceId,
                  modelId: scope.thread.modelId,
                  sessionId: command.sessionId,
                  prompt: command.prompt,
                  executionPolicy: turnThread.executionPolicy,
                  ...(starting.attachments.length === 0
                    ? {}
                    : { attachments: starting.attachments }),
                  ...(checkpoint === undefined ? {} : { checkpoint }),
                },
              });
              resultCursor += 1;
            }
            try {
              result = await this.#execute(
                command,
                windowId,
                turnThread,
                scope.checkout,
                root,
                starting.attachments,
              );
            } catch (error) {
              const category =
                error instanceof ReviewFindingServiceError ? error.failure : ("failed" as const);
              result = this.#failed(command.operationId, category, "Code operation failed.");
            }
          }
        }
      }
    }
    this.#options.events.append({
      threadId: command.threadId,
      operationId: command.operationId,
      expectedCursor: resultCursor,
      event: { kind: "operation-result", result },
    });
    if (
      (command.kind === "start-terminal" || command.kind === "attach-terminal") &&
      result.kind === "terminal-state" &&
      result.state === "running"
    ) {
      this.#activateTerminalOutput(command.terminalId, command.operationId, resultCursor + 1);
    } else if (command.kind === "stop-terminal" && result.kind === "terminal-state") {
      this.#deactivateTerminalOutput(command.terminalId);
    }
    return result;
  }

  /**
   * A4 recovery entry: when a start-provider-turn operation result says
   * `running` but no durable provider-turn launch/stream evidence exists,
   * reconstruct RuntimeTurnController state from the persisted conversation
   * start and invoke the runtime instead of returning the cached result.
   */
  async #recoverStaleProviderTurn(
    windowId: WindowId,
    command: Extract<CodeOperationCommand, { readonly kind: "start-provider-turn" }>,
    thread: CodeThread,
    checkout: CodeCheckoutIdentity,
    cached: CodeOperationResult,
  ): Promise<CodeOperationResult> {
    const root = await this.#options.authority.resolveCheckoutRoot(windowId, thread, checkout);
    if (root === undefined) {
      return this.#failed(
        command.operationId,
        "unavailable",
        "Code checkout authority is unavailable.",
      );
    }
    const gate = await this.#authorize(windowId, command, thread, checkout);
    if (gate !== "allow") {
      return this.#failed(
        command.operationId,
        gate === "waiting" ? "waiting" : "unauthorized",
        gate === "waiting"
          ? "Code operation requires approval."
          : "Code operation is unauthorized.",
      );
    }
    try {
      const frames = this.#replay(command.threadId, command.operationId, 0, 256).frames;
      const recovered = await this.#providerTurn(
        command,
        windowId,
        threadForTurn(
          thread,
          turnAccessPosture(thread, command, recordedTurnAccessPosture(frames)),
        ),
        root.checkoutRoot,
        recordedTurnAttachments(frames),
      );
      return recovered.kind === "provider-turn-state" ? recovered : cached;
    } catch {
      return this.#failed(command.operationId, "failed", "Code provider turn recovery failed.");
    }
  }

  async readTerminal(
    windowId: WindowId,
    input: {
      readonly threadId: CodeThreadId;
      readonly checkoutId: CodeCheckoutIdentity["id"];
      readonly terminalId: CodeTerminalId;
    },
  ): Promise<CodeOperationTerminalSnapshot> {
    await this.#requireOwnedTerminal(windowId, input, true);
    return this.#options.terminals.attach(input.terminalId);
  }

  async interruptTerminal(
    windowId: WindowId,
    input: {
      readonly threadId: CodeThreadId;
      readonly checkoutId: CodeCheckoutIdentity["id"];
      readonly terminalId: CodeTerminalId;
    },
  ): Promise<CodeOperationTerminalSnapshot> {
    await this.#requireOwnedTerminal(windowId, input, false);
    this.#options.terminals.write(input.terminalId, "\u0003");
    return this.#options.terminals.attach(input.terminalId);
  }

  async terminateTerminal(
    windowId: WindowId,
    input: {
      readonly threadId: CodeThreadId;
      readonly checkoutId: CodeCheckoutIdentity["id"];
      readonly terminalId: CodeTerminalId;
    },
  ): Promise<CodeOperationTerminalSnapshot> {
    await this.#requireOwnedTerminal(windowId, input, false);
    const snapshot = await this.#options.terminals.terminate(input.terminalId);
    this.#deactivateTerminalOutput(input.terminalId);
    this.#terminalOwners.delete(input.terminalId);
    return snapshot;
  }

  async #requireOwnedTerminal(
    windowId: WindowId,
    input: {
      readonly threadId: CodeThreadId;
      readonly checkoutId: CodeCheckoutIdentity["id"];
      readonly terminalId: CodeTerminalId;
    },
    useEffectiveThread: boolean,
  ): Promise<void> {
    const stored = this.#options.authority.readThread(input.threadId);
    const thread =
      stored === undefined || !useEffectiveThread
        ? stored
        : (this.#options.authority.effectiveThread?.(windowId, stored) ?? stored);
    if (
      thread === undefined ||
      thread.id !== input.threadId ||
      thread.checkoutId !== input.checkoutId ||
      thread.lifecycle !== "active"
    ) {
      throw new CodeOperationServiceError("invalid");
    }
    if (!(await this.#options.authority.canAccessProject(windowId, thread.projectId))) {
      throw new CodeOperationServiceError("unauthorized");
    }
    const checkout = this.#options.authority.readCheckout(input.checkoutId);
    if (
      checkout === undefined ||
      checkout.repositoryId !== thread.repositoryId ||
      checkout.availability !== "available"
    ) {
      throw new CodeOperationServiceError("unavailable");
    }
    const owner = this.#terminalOwners.get(input.terminalId);
    if (owner === undefined) throw new CodeOperationServiceError("unavailable");
    if (
      owner.windowId !== String(windowId) ||
      owner.threadId !== String(thread.id) ||
      owner.checkoutId !== String(checkout.id)
    ) {
      throw new CodeOperationServiceError("unauthorized");
    }
  }

  async subscribe(
    windowId: WindowId,
    threadId: CodeThreadId,
    operationId: CodeOperationId,
    afterCursor: number,
    limit: number,
  ): Promise<ReadonlyArray<CodeOperationEventFrame>> {
    const thread = this.#options.authority.readThread(threadId);
    if (thread === undefined || thread.id !== threadId)
      throw new CodeOperationServiceError("invalid");
    if (!(await this.#options.authority.canAccessProject(windowId, thread.projectId)))
      throw new CodeOperationServiceError("unauthorized");
    this.#noteTerminalRead(operationId);
    return this.#replay(threadId, operationId, afterCursor, limit).frames;
  }

  /** Record that whoever follows this operation is still reading it. */
  #noteTerminalRead(operationId: CodeOperationId): void {
    for (const owner of this.#terminalOwners.values()) {
      const reader = owner.readers.get(String(operationId));
      if (reader !== undefined) {
        reader.lastReadTick = ++this.#terminalReadTick;
        return;
      }
    }
  }

  async readEvidence(
    windowId: WindowId,
    threadId: CodeThreadId,
    operationId: CodeOperationId,
    contentId: CodeEvidenceReference["contentId"],
  ): Promise<{ readonly reference: CodeEvidenceReference; readonly text: string }> {
    let cursor = 0;
    let reference: CodeEvidenceReference | undefined;
    while (reference === undefined) {
      const frames = await this.subscribe(windowId, threadId, operationId, cursor, 256);
      for (const frame of frames) {
        reference = evidenceReferences(frame.event).find(
          (candidate) => candidate.contentId === contentId,
        );
        if (reference !== undefined) break;
      }
      if (reference !== undefined || frames.length < 256) break;
      cursor = frames.at(-1)?.cursor ?? cursor;
    }
    if (reference === undefined) throw new CodeOperationServiceError("unauthorized");
    const text = await this.#options.evidence.read?.(reference);
    if (text === undefined) throw new CodeOperationServiceError("unavailable");
    return { reference, text };
  }

  #replay(
    threadId: CodeThreadId,
    operationId: CodeOperationId,
    afterCursor: number,
    limit: number,
  ): Extract<CodeOperationReplay, { readonly status: "ok" }> {
    const replay = this.#options.events.replay({ threadId, operationId, afterCursor, limit });
    if (replay.status === "snapshot-required")
      throw new CodeOperationSnapshotRequiredError(replay.reason);
    return replay;
  }

  async #scope(
    windowId: WindowId,
    command: CodeOperationCommand,
  ): Promise<
    | { readonly thread: CodeThread; readonly checkout: CodeCheckoutIdentity }
    | { readonly failure: "invalid" | "unauthorized" | "waiting"; readonly message: string }
  > {
    const storedThread = this.#options.authority.readThread(command.threadId);
    const thread =
      storedThread === undefined
        ? undefined
        : (this.#options.authority.effectiveThread?.(windowId, storedThread) ?? storedThread);
    if (
      thread === undefined ||
      thread.id !== command.threadId ||
      thread.checkoutId !== command.checkoutId
    )
      return { failure: "invalid", message: "Code thread or checkout is invalid." };
    if (!(await this.#options.authority.canAccessProject(windowId, thread.projectId)))
      return { failure: "unauthorized", message: "Code thread is unauthorized." };
    const checkout = this.#options.authority.readCheckout(command.checkoutId);
    if (
      checkout === undefined ||
      checkout.repositoryId !== thread.repositoryId ||
      checkout.availability !== "available" ||
      thread.lifecycle !== "active"
    )
      return { failure: "waiting", message: "Code checkout is unavailable." };
    return { thread, checkout };
  }

  async #authorize(
    windowId: WindowId,
    command: CodeOperationCommand,
    thread: CodeThread,
    checkout: CodeCheckoutIdentity,
    initiator: CodeOperationInitiator = "agent",
  ): Promise<"allow" | "waiting" | "unauthorized"> {
    const operation = operationFor(command.kind);
    // Opening the person's own confined shell is the only operation this seam
    // lets a caller vouch for. Every other class — including the durable
    // mutations `operationFor` classifies as `edit` — keeps its ordinary gate,
    // so labelling a command user-initiated can never widen its authority.
    const vouchedInitiator: CodeOperationInitiator =
      initiator === "user" && operation === "terminal" ? "user" : "agent";
    const policy = authorizeCodeOperation({
      actor: "local-user",
      posture: thread.executionPolicy,
      operation,
      initiator: vouchedInitiator,
    });
    if (policy.decision === "deny") return "unauthorized";
    if (
      policy.decision === "prompt" &&
      this.#isApprovedTerminalContinuation(windowId, command, thread, checkout)
    )
      return "allow";
    const approvalId =
      "authorization" in command && command.authorization.kind === "approved"
        ? command.authorization.approvalId
        : undefined;
    const contextDigest =
      policy.decision === "prompt" || approvalId !== undefined
        ? await this.#options.authority.approvalContextDigest?.(windowId, command, thread, checkout)
        : undefined;
    if (policy.decision === "prompt") {
      if (contextDigest === undefined) return "waiting";
      const approved = await this.#options.approvals?.validate({
        windowId,
        effect: operationApprovalEffect(command),
        contextDigest,
        ...(approvalId === undefined ? {} : { approvalId }),
      });
      return approved ? "allow" : "waiting";
    }
    if (approvalId !== undefined) {
      if (contextDigest === undefined) return "unauthorized";
      if (
        !(await this.#options.approvals?.validate({
          windowId,
          effect: operationApprovalEffect(command),
          contextDigest,
          approvalId,
        }))
      )
        return "unauthorized";
    }
    return "allow";
  }

  #isApprovedTerminalContinuation(
    windowId: WindowId,
    command: CodeOperationCommand,
    thread: CodeThread,
    checkout: CodeCheckoutIdentity,
  ): boolean {
    if (
      command.kind !== "write-terminal" &&
      command.kind !== "resize-terminal" &&
      command.kind !== "stop-terminal"
    )
      return false;
    const owner = this.#terminalOwners.get(command.terminalId);
    return (
      owner?.windowId === String(windowId) &&
      owner.threadId === thread.id &&
      owner.checkoutId === checkout.id
    );
  }

  async #execute(
    command: CodeOperationCommand,
    windowId: WindowId,
    thread: CodeThread,
    checkout: CodeCheckoutIdentity,
    root: NonNullable<Awaited<ReturnType<CodeOperationAuthorityPort["resolveCheckoutRoot"]>>>,
    /** The images the caller resolved for a starting provider turn. */
    attachments: ReadonlyArray<CodeAttachmentReference>,
  ): Promise<CodeOperationResult> {
    const workingDirectory = root.workingDirectory ?? root.checkoutRoot;
    switch (command.kind) {
      case "start-terminal": {
        const allowed = new Set(command.credentialRefs);
        const credentialReferences = root.credentialReferences.filter((credential) =>
          allowed.has(credential.environmentName),
        );
        if (credentialReferences.length !== allowed.size)
          return this.#failed(
            command.operationId,
            "invalid",
            "Terminal credential authority is invalid.",
          );
        const snapshot = await this.#options.terminals.launch({
          terminalId: command.terminalId,
          shell: root.shell,
          cwd: workingDirectory,
          // The repository this checkout belongs to, not the path it sits at.
          stateScope: String(checkout.repositoryId),
          columns: command.columns,
          rows: command.rows,
          credentialReferences,
        });
        this.#terminalOwners.set(command.terminalId, {
          windowId: String(windowId),
          threadId: thread.id,
          checkoutId: checkout.id,
          readers: new Map(),
          outputBaseline: snapshot.transcript.characters,
        });
        return this.#terminal(command.operationId, snapshot);
      }
      case "attach-terminal": {
        const ownerFailure = this.#requireTerminalOwner(command, windowId, thread, checkout);
        if (ownerFailure !== undefined) return ownerFailure;
        const snapshot = this.#options.terminals.attach(command.terminalId);
        const owner = this.#terminalOwners.get(command.terminalId)!;
        owner.outputBaseline = snapshot.transcript.characters;
        return this.#terminal(command.operationId, snapshot);
      }
      case "write-terminal": {
        const owner = this.#requireTerminalOwner(command, windowId, thread, checkout);
        if (owner !== undefined) return owner;
        this.#options.terminals.write(command.terminalId, command.data);
        return this.#terminal(
          command.operationId,
          this.#options.terminals.attach(command.terminalId),
          false,
        );
      }
      case "resize-terminal": {
        const owner = this.#requireTerminalOwner(command, windowId, thread, checkout);
        if (owner !== undefined) return owner;
        this.#options.terminals.resize(command.terminalId, command.columns, command.rows);
        return this.#terminal(
          command.operationId,
          this.#options.terminals.attach(command.terminalId),
          false,
        );
      }
      case "stop-terminal": {
        const owner = this.#requireTerminalOwner(command, windowId, thread, checkout);
        if (owner !== undefined) return owner;
        return this.#terminal(
          command.operationId,
          await this.#options.terminals.terminate(command.terminalId),
        );
      }
      case "run-repository-test": {
        // The renderer selects a definition; it never authors one. Re-deriving
        // the checkout's definitions here is what stops a submitted definition
        // from carrying argv the server never discovered.
        const discovered = await this.#options.repositoryTests.discover({
          checkoutId: String(checkout.id),
          rootPath: root.checkoutRoot,
        });
        if (
          !discovered.some((candidate) =>
            codeRepositoryTestDefinitionsMatch(candidate, command.definition),
          )
        ) {
          return this.#failed(
            command.operationId,
            "unauthorized",
            "Repository test definition was not discovered in this checkout.",
          );
        }
        const run = await this.#options.repositoryTests.run({
          runId: command.testRunId,
          definition: command.definition,
          threadId: thread.id,
          checkoutId: checkout.id,
          checkoutRevision: checkout.head.oid,
          executionPolicy: thread.executionPolicy,
          checkoutRoot: root.checkoutRoot,
          environment: root.environment,
        });
        if (
          run.id !== command.testRunId ||
          run.threadId !== thread.id ||
          run.checkoutId !== checkout.id
        )
          return this.#failed(command.operationId, "stale", "Repository test identity is invalid.");
        const evidence = this.#options.evidence.put(`${run.stdout.text}\n${run.stderr.text}`);
        const state =
          run.termination === "unavailable"
            ? "unavailable"
            : run.termination === "cancelled"
              ? "interrupted"
              : "completed";
        return decodeCodeOperationResult({
          kind: "repository-test-state",
          operationId: command.operationId,
          testRunId: command.testRunId,
          state,
          ...(state === "completed" ? { verdict: run.verdict } : {}),
          evidence,
          concerns: run.concerns,
        });
      }
      case "cancel-repository-test": {
        const cancelled = await this.#options.repositoryTests.cancel({
          testRunId: command.testRunId,
          threadId: thread.id,
          checkoutId: checkout.id,
        });
        return cancelled
          ? decodeCodeOperationResult({
              kind: "repository-test-state",
              operationId: command.operationId,
              testRunId: command.testRunId,
              state: "interrupted",
              concerns: [],
            })
          : this.#failed(command.operationId, "unavailable", "Repository test is unavailable.");
      }
      case "run-scaffold": {
        // The renderer names an entry; the host owns the catalog and composes
        // the command line. An id the host does not publish is refused rather
        // than resolved into something adjacent.
        const scaffolds = this.#options.scaffolds;
        const entry = scaffolds?.entry(String(command.scaffoldId));
        if (scaffolds === undefined || entry === undefined) {
          return this.#failed(
            command.operationId,
            "unavailable",
            "This host offers no scaffold by that name.",
          );
        }
        const outcome = await scaffolds.run({
          runId: command.scaffoldRunId,
          entry,
          directoryName: command.directoryName,
          threadId: thread.id,
          checkoutId: checkout.id,
          executionPolicy: thread.executionPolicy,
          checkoutRoot: root.checkoutRoot,
        });
        if (outcome.status === "refused") {
          return this.#failed(command.operationId, "invalid", outcome.message);
        }
        return decodeCodeOperationResult({
          kind: "scaffold-run",
          operationId: command.operationId,
          run: outcome.run,
        });
      }
      case "observe-git":
        return this.#gitObservation(command, root.checkoutRoot);
      case "review-run":
        return this.#reviewRun(command, thread, root.checkoutRoot);
      case "merge-run":
        return this.#mergeRun(command, thread, root.checkoutRoot);
      case "stage-git":
        return this.#gitMutation(
          command.operationId,
          command.gitOperationId,
          "stage",
          await this.#options.git.stage({
            checkoutId: checkout.id,
            checkoutRoot: root.checkoutRoot,
            paths: command.paths,
            expectedStateToken: command.expectedStateToken,
          }),
        );
      case "unstage-git":
        return this.#gitMutation(
          command.operationId,
          command.gitOperationId,
          "unstage",
          await this.#options.git.unstage({
            checkoutId: checkout.id,
            checkoutRoot: root.checkoutRoot,
            paths: command.paths,
            expectedStateToken: command.expectedStateToken,
          }),
        );
      case "draft-git-text":
        return this.#gitDraft(command, thread, root.checkoutRoot);
      case "discard-git-changes":
        return this.#gitMutation(
          command.operationId,
          command.gitOperationId,
          "discard",
          await this.#options.git.discard({
            checkoutId: checkout.id,
            checkoutRoot: root.checkoutRoot,
            paths: command.paths,
            expectedStateToken: command.expectedStateToken,
          }),
        );
      case "commit-git":
        return this.#gitMutation(
          command.operationId,
          command.gitOperationId,
          "commit",
          await this.#options.git.commit({
            checkoutId: checkout.id,
            checkoutRoot: root.checkoutRoot,
            message: command.message,
            expectedStateToken: command.expectedStateToken,
            stagedSummary: command.stagedSummary,
          }),
        );
      case "push-git":
        return this.#gitMutation(
          command.operationId,
          command.gitOperationId,
          "push",
          await this.#options.git.push({
            checkoutId: checkout.id,
            checkoutRoot: root.checkoutRoot,
            remote: command.remote,
            localRef: command.localRef,
            remoteRef: command.remoteRef,
            confirmation: command.confirmation,
            expectedHeadOid: command.expectedHeadOid,
            expectedStateToken: command.expectedStateToken,
            authority: command.authorization.kind === "approved" ? "approved" : "full-access",
          }),
        );
      case "restore-git-checkpoint": {
        const restore = this.#options.git.restoreCheckpoint;
        if (restore === undefined)
          return this.#failed(
            command.operationId,
            "unavailable",
            "Restoring a checkpoint is unavailable.",
          );
        return this.#gitMutation(
          command.operationId,
          command.gitOperationId,
          "restore-checkpoint",
          await restore({
            checkoutId: checkout.id,
            checkoutRoot: root.checkoutRoot,
            snapshot: command.checkpoint,
          }),
        );
      }
      case "create-pull-request":
        return this.#pullRequest(command);
      case "observe-pull-request":
        return this.#pullRequestReview(command);
      case "create-review-finding": {
        const finding = await this.#options.reviewFindings.create(windowId, {
          id: command.findingId,
          threadId: thread.id,
          checkoutId: checkout.id,
          fileId: command.fileId,
          path: command.path,
          fileDigest: command.fileDigest,
          location: command.location,
          severity: command.severity,
          summary: command.summary,
          author: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
          provenance: { kind: "manual" },
        });
        return finding.id === command.findingId
          ? decodeCodeOperationResult({
              kind: "review-finding-state",
              operationId: command.operationId,
              finding,
            })
          : this.#failed(command.operationId, "stale", "Review finding identity is invalid.");
      }
      case "update-review-finding":
        return decodeCodeOperationResult({
          kind: "review-finding-state",
          operationId: command.operationId,
          finding: await this.#options.reviewFindings.changeState(windowId, {
            findingId: command.findingId,
            expectedVersion: command.expectedVersion,
            state: command.state,
          }),
        });
      case "start-provider-turn":
        return this.#providerTurn(command, windowId, thread, root.checkoutRoot, attachments);
      case "answer-provider-input":
        return this.#providerInput(command, thread, root.checkoutRoot);
      case "answer-provider-approval":
        return this.#providerResult(
          command.operationId,
          await this.#options.turns.answerApproval({
            thread,
            checkoutRoot: root.checkoutRoot,
            approvalId: command.approvalId,
            decision: command.decision,
          }),
        );
      case "cancel-provider-turn":
        return this.#providerResult(
          command.operationId,
          await this.#options.turns.cancel({ thread, checkoutRoot: root.checkoutRoot }),
        );
    }
  }

  #terminal(
    operationId: CodeOperationCommand["operationId"],
    snapshot: CodeOperationTerminalSnapshot,
    includeTranscript = true,
  ): CodeOperationResult {
    const transcript = snapshot.transcript.chunks.join("");
    const base = {
      kind: "terminal-state",
      operationId,
      terminalId: snapshot.terminalId,
      state: snapshot.status,
      ...(!includeTranscript || transcript.length === 0
        ? {}
        : { transcript: this.#options.evidence.put(transcript) }),
    } as const;
    return snapshot.status === "exited"
      ? decodeCodeOperationResult({ ...base, state: "exited", exitCode: snapshot.exitCode ?? null })
      : decodeCodeOperationResult(base);
  }

  /**
   * Start journaling this terminal for one more surface.
   *
   * The readers already following the terminal keep their own operations: a
   * second surface opening the same shell is another window onto it, not a
   * handover, so output after this point is written to every reader's journal.
   * The observer is re-armed against the transcript the joining reader was
   * handed, which is exactly where every existing reader had been written up
   * to, so nobody is sent the same output twice.
   */
  #activateTerminalOutput(
    terminalId: string,
    operationId: CodeOperationId,
    nextCursor: number,
  ): void {
    const owner = this.#terminalOwners.get(terminalId);
    if (owner === undefined || this.#options.terminals.observe === undefined) return;
    owner.removeOutputListener?.();
    this.#admitTerminalReader(owner, operationId, nextCursor);
    const outputBaseline = owner.outputBaseline;
    delete owner.outputBaseline;
    owner.removeOutputListener = this.#options.terminals.observe(
      terminalId,
      (emission) => {
        let content: CodeEvidenceReference | undefined;
        try {
          content =
            emission.text.length > 0
              ? this.#options.evidence.put(emission.text, {
                  truncated: emission.replace && emission.snapshot.transcript.truncated,
                })
              : undefined;
        } catch {
          // Output that cannot be stored cannot be journaled for anyone, so the
          // shell must not stay interactive behind an unrecorded transcript.
          this.#abandonTerminal(terminalId);
          return;
        }
        for (const reader of [...owner.readers.values()]) {
          this.#journalTerminalEmission(terminalId, owner, reader, emission, content);
        }
        // The process outlives any one surface, so it is only torn down once
        // nothing is journaling it any more.
        if (owner.readers.size === 0) this.#abandonTerminal(terminalId);
        else if (emission.snapshot.status !== "running") {
          this.#deactivateTerminalOutput(terminalId);
        }
      },
      outputBaseline === undefined ? undefined : { afterCharacters: outputBaseline },
    );
  }

  /**
   * Seat one more reader on a terminal, making room if the seats are full.
   *
   * The reader evicted is the one that has gone longest without reading, which
   * is the surface most likely to be gone; a surface that is still on screen
   * reads every couple of seconds and cannot be the oldest while a departed
   * one is still seated.
   */
  #admitTerminalReader(
    owner: TerminalOwner,
    operationId: CodeOperationId,
    nextCursor: number,
  ): void {
    owner.readers.delete(String(operationId));
    while (owner.readers.size >= MAX_TERMINAL_READERS) {
      const quietest = [...owner.readers.values()].reduce((oldest, candidate) =>
        candidate.lastReadTick < oldest.lastReadTick ? candidate : oldest,
      );
      owner.readers.delete(String(quietest.operationId));
    }
    owner.readers.set(String(operationId), {
      operationId,
      nextCursor,
      lastReadTick: ++this.#terminalReadTick,
      lastTerminalStatus: "running",
    });
  }

  /**
   * Write one emission into one reader's journal.
   *
   * A reader whose journal refuses the write is dropped rather than taken as a
   * reason to stop journaling for everyone else; an unjournaled PTY is only
   * reached when the last reader has gone.
   */
  #journalTerminalEmission(
    terminalId: string,
    owner: TerminalOwner,
    reader: TerminalOutputReader,
    emission: TerminalOutputEmission,
    content: CodeEvidenceReference | undefined,
  ): void {
    try {
      if (content !== undefined) {
        this.#options.events.append({
          threadId: owner.threadId as CodeThreadId,
          operationId: reader.operationId,
          expectedCursor: reader.nextCursor,
          event: {
            kind: "terminal-output",
            terminalId: terminalId as never,
            content,
            replace: emission.replace,
          },
        });
        reader.nextCursor += 1;
      }
      if (
        emission.snapshot.status !== reader.lastTerminalStatus ||
        emission.snapshot.exitCode !== reader.lastExitCode
      ) {
        this.#options.events.append({
          threadId: owner.threadId as CodeThreadId,
          operationId: reader.operationId,
          expectedCursor: reader.nextCursor,
          event: {
            kind: "terminal-state-changed",
            terminalId: terminalId as never,
            state: emission.snapshot.status,
            ...(emission.snapshot.status === "exited"
              ? { exitCode: emission.snapshot.exitCode ?? null }
              : {}),
          },
        });
        reader.nextCursor += 1;
        reader.lastTerminalStatus = emission.snapshot.status;
        if (emission.snapshot.exitCode === undefined) delete reader.lastExitCode;
        else reader.lastExitCode = emission.snapshot.exitCode;
      }
    } catch {
      owner.readers.delete(String(reader.operationId));
    }
  }

  /** Close a terminal nothing is journaling any more. */
  #abandonTerminal(terminalId: string): void {
    this.#deactivateTerminalOutput(terminalId);
    try {
      const termination = this.#options.terminals.terminate(terminalId);
      void Promise.resolve(termination).catch(() => undefined);
    } catch {
      // Ownership is already revoked. A transport-level close failure is
      // contained here so an unjournaled PTY can never remain interactive.
    }
  }

  #deactivateTerminalOutput(terminalId: string): void {
    const owner = this.#terminalOwners.get(terminalId);
    owner?.removeOutputListener?.();
    this.#terminalOwners.delete(terminalId);
  }

  #requireTerminalOwner(
    command: Extract<CodeOperationCommand, { readonly terminalId: string }>,
    windowId: WindowId,
    thread: CodeThread,
    checkout: CodeCheckoutIdentity,
  ): CodeOperationResult | undefined {
    const owner = this.#terminalOwners.get(command.terminalId);
    if (owner === undefined)
      return this.#failed(command.operationId, "unavailable", "Terminal is unavailable.");
    return owner.windowId === String(windowId) &&
      owner.threadId === thread.id &&
      owner.checkoutId === checkout.id
      ? undefined
      : this.#failed(
          command.operationId,
          "unauthorized",
          "Terminal belongs to another code thread.",
        );
  }

  /**
   * What this run produced, measured against the branch it targets.
   *
   * The comparison runs in the run's own worktree — it is the checkout that has
   * the branch — and reads only. The base ref is the thread's confirmed
   * delivery target, remote-tracking first, because that is what a pull request
   * would be opened against and what a merge would land on.
   */
  async #reviewRun(
    command: Extract<CodeOperationCommand, { readonly kind: "review-run" }>,
    thread: CodeThread,
    checkoutRoot: string,
  ): Promise<CodeOperationResult> {
    const compare = this.#options.git.compareBranch;
    const readDiff = this.#options.git.readBranchDiff;
    if (compare === undefined || readDiff === undefined) {
      return this.#failed(command.operationId, "unavailable", "Run review is unavailable.");
    }
    const branch = thread.deliveryTarget.branchIntent;
    const observed = await this.#options.git.observe({
      checkoutRoot,
      maxDiffBytes: command.maxDiffBytes,
    });
    if (observed.status !== "ready" || observed.statusEntries === undefined) {
      return this.#failed(command.operationId, "unavailable", "Run review is unavailable.");
    }
    for (const baseRef of [
      `${thread.deliveryTarget.remoteName}/${thread.deliveryTarget.proposedBaseBranch}`,
      thread.deliveryTarget.proposedBaseBranch,
    ]) {
      const comparison = await compare({ checkoutRoot, baseRef, headRef: "HEAD" });
      if (comparison.status !== "ready") continue;
      const diff = await readDiff({ checkoutRoot, baseRef });
      if (diff.status !== "ready") continue;
      return decodeCodeOperationResult({
        kind: "run-reviewed",
        operationId: command.operationId,
        gitOperationId: command.gitOperationId,
        outcome: {
          branch,
          baseRef,
          head: comparison.head,
          ...(comparison.base === undefined ? {} : { base: comparison.base }),
          ahead: comparison.ahead,
          behind: comparison.behind,
          changedPaths: diff.paths,
          diff: this.#options.evidence.put(diff.diff, { truncated: diff.diffTruncated }),
          // Work the run never committed is work a merge would leave behind, so
          // the review names it rather than letting the diff imply it is all
          // there is.
          uncommittedPaths: observed.statusEntries.map((entry) => entry.path),
          mergeability: comparison.mergeability,
        },
      });
    }
    return this.#failed(command.operationId, "unavailable", "Run review is unavailable.");
  }

  /**
   * Bring the run home: merge its branch into the base branch, in the base
   * checkout.
   *
   * Every refusal is decided before anything moves, from facts the host reads
   * itself: the base checkout must be on the base branch and clean, the run
   * must have committed everything it means to bring, and Git must have said
   * the merge is clean. The confirmation the caller sent must match the run the
   * host sees, so a merge computed against a stale review is refused rather
   * than applied.
   */
  async #mergeRun(
    command: Extract<CodeOperationCommand, { readonly kind: "merge-run" }>,
    thread: CodeThread,
    runCheckoutRoot: string,
  ): Promise<CodeOperationResult> {
    const merge = this.#options.git.mergeRun;
    const resolveBase = this.#options.resolveBaseCheckout;
    if (merge === undefined || resolveBase === undefined) {
      return this.#failed(
        command.operationId,
        "unavailable",
        "Bringing a run home is unavailable.",
      );
    }
    if (
      command.confirmation.branch !== thread.deliveryTarget.branchIntent ||
      command.confirmation.baseBranch !== thread.deliveryTarget.proposedBaseBranch
    ) {
      return this.#failed(
        command.operationId,
        "invalid",
        "The confirmed branch does not match this thread's delivery target.",
      );
    }
    // The merge is decided against a review the host takes now, not against the
    // one the caller happens to be holding: a run that moved since it was read
    // is refused rather than merged on trust.
    const review = await this.#reviewRun(
      { ...command, kind: "review-run", maxDiffBytes: 1_024 },
      thread,
      runCheckoutRoot,
    );
    if (review.kind !== "run-reviewed") return review;
    const base = await resolveBase(thread);
    const decision = decideRunMerge({
      outcome: review.outcome,
      base:
        base.status === "observed"
          ? { status: "observed", branch: base.branch, clean: base.clean }
          : { status: "unavailable" },
      baseBranch: command.confirmation.baseBranch,
      confirmedHead: command.confirmation.expectedHeadOid,
    });
    if (decision.decision === "refuse") {
      // A refusal here is a state the user can fix, not a broken host: it is
      // reported as stale so the surface re-reads rather than retries blindly.
      return this.#failed(command.operationId, "stale", runMergeRefusalText(decision.reason));
    }
    if (base.status !== "observed") {
      return this.#failed(
        command.operationId,
        "unavailable",
        "Bringing a run home is unavailable.",
      );
    }
    return this.#gitMutation(
      command.operationId,
      command.gitOperationId,
      "merge-run",
      await merge({
        checkoutRoot: base.checkoutRoot,
        branch: command.confirmation.branch,
        authority: command.authorization.kind === "approved" ? "approved" : "full-access",
      }),
    );
  }

  async #gitObservation(
    command: Extract<CodeOperationCommand, { readonly kind: "observe-git" }>,
    checkoutRoot: string,
  ): Promise<CodeOperationResult> {
    const result = await this.#options.git.observe({
      checkoutRoot,
      maxDiffBytes: command.maxDiffBytes,
    });
    if (
      result.status !== "ready" ||
      result.head === undefined ||
      result.stateToken === undefined ||
      result.statusEntries === undefined ||
      result.changedPaths === undefined ||
      result.diff === undefined ||
      result.remotes === undefined ||
      result.worktrees === undefined
    )
      return this.#failed(
        command.operationId,
        result.status === "unavailable" ? "unavailable" : "failed",
        "Git observation is unavailable.",
      );
    return decodeCodeOperationResult({
      kind: "git-observed",
      operationId: command.operationId,
      gitOperationId: command.gitOperationId,
      head:
        result.head.kind === "branch"
          ? { kind: "branch", name: result.head.name!, oid: result.head.oid }
          : result.head.kind === "unborn"
            ? { kind: "unborn", name: result.head.name! }
            : { kind: "detached", oid: result.head.oid },
      stateToken: result.stateToken,
      status: result.statusEntries,
      changedPaths: result.changedPaths,
      diff: this.#options.evidence.put(result.diff, { truncated: result.diffTruncated === true }),
      remotes: result.remotes.map((remote) => ({
        name: remote.name,
        fetch:
          remote.fetch.kind === "local"
            ? { kind: "local" }
            : { kind: "network", url: remote.fetch.url! },
        push:
          remote.push.kind === "local"
            ? { kind: "local" }
            : { kind: "network", url: remote.push.url! },
      })),
      upstream: result.upstream ?? null,
      worktrees: result.worktrees,
    });
  }

  #gitMutation(
    operationId: CodeOperationCommand["operationId"],
    gitOperationId: string,
    mutation:
      | "stage"
      | "unstage"
      | "discard"
      | "commit"
      | "push"
      | "restore-checkpoint"
      | "merge-run",
    result: GitMutationOutcome & { readonly undo?: CodeCheckpoint },
  ): CodeOperationResult {
    if (result.status === "unavailable")
      return this.#failed(operationId, "unavailable", "Git mutation is unavailable.");
    return decodeCodeOperationResult({
      kind: "git-mutation-state",
      operationId,
      gitOperationId,
      mutation,
      state:
        result.status === "applied"
          ? "completed"
          : result.status === "rejected"
            ? "rejected"
            : "failed",
      ...(result.status === "applied" && result.oid !== undefined ? { headOid: result.oid } : {}),
      // A failed restore may have moved files before it stopped, so its undo
      // point travels with it too; only a rejection is certainly untouched.
      ...(result.status !== "rejected" && result.undo !== undefined ? { undo: result.undo } : {}),
    });
  }

  async #gitDraft(
    command: Extract<CodeOperationCommand, { readonly kind: "draft-git-text" }>,
    thread: CodeThread,
    checkoutRoot: string,
  ): Promise<CodeOperationResult> {
    const draft = this.#options.git.draft;
    const result =
      draft === undefined
        ? ({ status: "unavailable" } as const)
        : await draft({ thread, checkoutRoot, purpose: command.purpose });
    return decodeCodeOperationResult({
      kind: "git-draft-state",
      operationId: command.operationId,
      purpose: command.purpose,
      state: result.status === "drafted" ? "completed" : result.status,
      ...(result.status === "drafted"
        ? { title: result.title, ...(result.body === undefined ? {} : { body: result.body }) }
        : {}),
    });
  }

  /**
   * Record the checkout just before a turn runs, so the user can put the files
   * back at this message. Best effort by design: a checkout that cannot be
   * read costs the turn its restore point, never the turn itself.
   *
   * A Plan turn gets none. Capturing one stages the tree into a scratch index
   * and writes the resulting trees into the object database, which is a write
   * to the repository however little it disturbs the working tree — and a Plan
   * turn changes no file, so the restore point it would buy restores nothing.
   */
  async #checkpoint(
    thread: CodeThread,
    checkoutId: string,
    checkoutRoot: string,
  ): Promise<CodeCheckpoint | undefined> {
    const capture = this.#options.git.checkpoint;
    if (capture === undefined || !mayWriteToRepository(thread.executionPolicy)) return undefined;
    try {
      const result = await capture({ checkoutId, checkoutRoot });
      return result.status === "captured" ? result.snapshot : undefined;
    } catch {
      return undefined;
    }
  }

  async #pullRequest(
    command: Extract<CodeOperationCommand, { readonly kind: "create-pull-request" }>,
  ): Promise<CodeOperationResult> {
    const result = await this.#options.pullRequests.ensure(
      { threadId: command.threadId, title: command.title, body: command.body },
      new AbortController().signal,
    );
    if (result.status === "unavailable")
      return decodeCodeOperationResult({
        kind: "pull-request-state",
        operationId: command.operationId,
        state: "unavailable",
      });
    const pr = result.pullRequest;
    return decodeCodeOperationResult({
      kind: "pull-request-state",
      operationId: command.operationId,
      state: result.status,
      number: pr.number,
      url: pr.url,
      headRepository: pr.headOwner,
      headBranch: pr.headBranch,
      baseRepository: pr.baseRepository,
      baseBranch: pr.baseBranch,
    });
  }

  async #pullRequestReview(
    command: Extract<CodeOperationCommand, { readonly kind: "observe-pull-request" }>,
  ): Promise<CodeOperationResult> {
    const result = await this.#options.pullRequests.observeReview(
      { threadId: command.threadId, maxDiffBytes: command.maxDiffBytes },
      new AbortController().signal,
    );
    if (result.status === "unavailable")
      return decodeCodeOperationResult({
        kind: "pull-request-review",
        operationId: command.operationId,
        state: "unavailable",
        freshness: "stale",
      });
    if (result.status === "none")
      return decodeCodeOperationResult({
        kind: "pull-request-review",
        operationId: command.operationId,
        state: "none",
        freshness: "fresh",
      });
    const pr = result.pullRequest;
    return decodeCodeOperationResult({
      kind: "pull-request-review",
      operationId: command.operationId,
      state: "observed",
      freshness: result.freshness,
      ambiguous: result.ambiguous,
      staleSections: result.staleSections,
      number: pr.number,
      url: pr.url,
      title: pr.title,
      pullRequestState: pr.state,
      baseRepository: pr.baseRepository,
      baseBranch: pr.baseBranch,
      headRepository: pr.headRepository,
      headBranch: pr.headBranch,
      author: pr.author,
      matchesDeliveryBranch: pr.matchesDeliveryBranch,
      description: this.#options.evidence.put(result.description),
      diff: this.#options.evidence.put(result.diff, { truncated: result.diffTruncated }),
      commits: result.commits,
      files: result.files,
      checks: result.checks,
      reviews: result.reviews,
      comments: result.comments,
    });
  }

  async #providerTurn(
    command: Extract<CodeOperationCommand, { readonly kind: "start-provider-turn" }>,
    windowId: WindowId,
    thread: CodeThread,
    checkoutRoot: string,
    references: ReadonlyArray<CodeAttachmentReference>,
  ): Promise<CodeOperationResult> {
    const prompt = await this.#options.evidence.read?.(command.prompt);
    if (prompt === undefined)
      return this.#failed(
        command.operationId,
        "unavailable",
        "Provider prompt evidence is unavailable.",
      );
    const supportsImages = this.#options.supportsAttachments?.(thread) === true;
    // Notes the user pointed at the running product ride with the next turn
    // they send. They are quoted as evidence beside the prompt, never folded
    // into it, and the port records that each one went before it is used.
    const feedback = await this.#options
      .takeProductFeedbackForTurn?.({
        threadId: command.threadId,
        operationId: command.operationId,
        supportsImages,
      })
      .catch(() => undefined);
    const context = [
      ...(await this.#resolveForkHandoff(thread, windowId, command.operationId)),
      ...(await this.#resolveThreadMentions(command.threadMentionIds, windowId)),
      ...(await this.#resolveFileMentions(command.fileMentionPaths, windowId, thread)),
      ...(feedback?.context === undefined || feedback.context.trim().length === 0
        ? []
        : [{ kind: "user-message", text: feedback.context } as const]),
    ];
    // A model that cannot read a picture is told so plainly rather than sent
    // the turn with its images quietly removed.
    if (references.length > 0 && !supportsImages) {
      return this.#failed(
        command.operationId,
        "invalid",
        "The selected model does not support images. Choose a vision model, or remove the attachments.",
      );
    }
    const own = await this.#attachmentInputs(command.threadId, references);
    const attachments = own === undefined ? undefined : [...own, ...(feedback?.attachments ?? [])];
    if (attachments === undefined) {
      return this.#failed(
        command.operationId,
        "unavailable",
        "An image attached to this turn is unavailable.",
      );
    }
    const turn = await this.#options.turns.start({
      windowId,
      thread,
      sessionId: command.sessionId,
      checkoutRoot,
      prompt,
      ...(context.length === 0 ? {} : { context }),
      ...(attachments.length === 0 ? {} : { attachments }),
    });
    return this.#providerResult(command.operationId, turn);
  }

  /**
   * Turn the attachment ids a starting turn names into the references its
   * `conversation-turn-started` event records.
   *
   * The command carries ids, so the name, media type, size, and digest written
   * to the journal are the ones this host measured when it accepted the bytes,
   * never ones a renderer claimed. Taking the ids also frees the thread's
   * staging budget: the images now belong to this turn.
   */
  #startingAttachments(
    threadId: CodeThreadId,
    attachmentIds: ReadonlyArray<CodeAttachmentId> | undefined,
  ):
    | { readonly status: "ok"; readonly attachments: ReadonlyArray<CodeAttachmentReference> }
    | { readonly status: "unknown" } {
    if (attachmentIds === undefined || attachmentIds.length === 0) {
      return { status: "ok", attachments: [] };
    }
    const attachments = this.#options.attachments;
    if (attachments === undefined) return { status: "unknown" };
    const peeked = attachments.peek(threadId, attachmentIds);
    if (peeked.status !== "ok") return { status: "unknown" };
    attachments.release(threadId, attachmentIds);
    return { status: "ok", attachments: peeked.attachments };
  }

  /**
   * Read the images this turn's journalled start recorded.
   *
   * The journal is the authority, not the composer: a turn recovered after a
   * restart sends exactly the images its start event named, verified against
   * the digests recorded with them.
   */
  async #attachmentInputs(
    threadId: CodeThreadId,
    references: ReadonlyArray<CodeAttachmentReference>,
  ): Promise<ReadonlyArray<ProviderAttachmentInput> | undefined> {
    if (references.length === 0) return [];
    const attachments = this.#options.attachments;
    if (attachments === undefined) return undefined;
    const inputs: ProviderAttachmentInput[] = [];
    for (const reference of references) {
      let bytes: Uint8Array;
      try {
        bytes = await attachments.read(threadId, reference);
      } catch {
        return undefined;
      }
      inputs.push({
        attachmentId: String(reference.attachmentId),
        displayName: reference.displayName,
        mediaType: reference.mediaType,
        bytes,
      });
    }
    return inputs;
  }

  /**
   * Resolve the conversation a forked thread carries into its first turn.
   *
   * The thread record names its own origin, so the renderer never chooses what
   * history a turn is given. The resolver decides whether this turn is the
   * fork's first — a later turn has the fork's own transcript to work from —
   * and a source it cannot read contributes nothing rather than a claimed
   * history the model would treat as real.
   */
  async #resolveForkHandoff(
    thread: CodeThread,
    windowId: WindowId,
    operationId: CodeOperationId,
  ): Promise<ReadonlyArray<ProviderContextBlock>> {
    const origin = thread.forkedFrom;
    const resolve = this.#options.resolveForkHandoff;
    if (origin === undefined || resolve === undefined) return [];
    let text: string | undefined;
    try {
      text = await resolve({ threadId: thread.id, origin, windowId, operationId });
    } catch {
      return [];
    }
    return text === undefined || text.trim().length === 0
      ? []
      : [{ kind: "user-message", text } as const];
  }

  /**
   * Resolve the `#thread` mentions this turn names into read-only context.
   *
   * The host owns every fact behind the port: whether this send's principal
   * may still Open each named thread, and how much of its transcript one
   * mention carries. A mention it refuses is answered here in words rather
   * than dropped, because the user's own message still shows the chip they
   * typed — silence would let the model treat a thread it was never shown as
   * one it read. Each mention becomes its own context block beside the prompt,
   * so it stays out of the evidence the journal records as the message and
   * costs only the turn that named it.
   */
  async #resolveThreadMentions(
    threadMentionIds: ReadonlyArray<MentionableThreadId> | undefined,
    windowId: WindowId,
  ): Promise<ReadonlyArray<ProviderContextBlock>> {
    if (threadMentionIds === undefined || threadMentionIds.length === 0) return [];
    const unreadable = () =>
      threadMentionIds.map(
        () => ({ kind: "user-message", text: THREAD_MENTION_UNREADABLE_CONTEXT }) as const,
      );
    const resolve = this.#options.resolveThreadMentionContext;
    if (resolve === undefined) return unreadable();
    let resolved: ReadonlyArray<CodeThreadMentionContext>;
    try {
      resolved = await resolve({ threadMentionIds, windowId });
    } catch {
      // A resolver that throws proves nothing about any one mention, so every
      // named thread is reported unread rather than half of them guessed.
      return unreadable();
    }
    const byThreadId = new Map(resolved.map((mention) => [String(mention.threadId), mention]));
    return threadMentionIds.map((threadId) => {
      const mention = byThreadId.get(String(threadId));
      return {
        kind: "user-message",
        text:
          mention === undefined || mention.kind === "unreadable"
            ? THREAD_MENTION_UNREADABLE_CONTEXT
            : mention.text,
      } as const;
    });
  }

  async #resolveFileMentions(
    fileMentionPaths: ReadonlyArray<string> | undefined,
    windowId: WindowId,
    thread: CodeThread,
  ): Promise<ReadonlyArray<ProviderContextBlock>> {
    if (fileMentionPaths === undefined || fileMentionPaths.length === 0) return [];
    const resolve = this.#options.resolveFileMentionContext;
    if (resolve === undefined) {
      return fileMentionPaths.map(() => ({
        kind: "user-message" as const,
        text: FILE_MENTION_UNREADABLE_CONTEXT,
      }));
    }
    try {
      return await resolve({
        fileMentionPaths,
        windowId,
        threadId: thread.id,
        checkoutId: thread.checkoutId,
      });
    } catch {
      return fileMentionPaths.map(() => ({
        kind: "user-message" as const,
        text: FILE_MENTION_UNREADABLE_CONTEXT,
      }));
    }
  }

  async #providerInput(
    command: Extract<CodeOperationCommand, { readonly kind: "answer-provider-input" }>,
    thread: CodeThread,
    checkoutRoot: string,
  ): Promise<CodeOperationResult> {
    const response = await this.#options.evidence.read?.(command.response);
    if (response === undefined)
      return this.#failed(
        command.operationId,
        "unavailable",
        "Provider response evidence is unavailable.",
      );
    return this.#providerResult(
      command.operationId,
      await this.#options.turns.answerInput({
        thread,
        checkoutRoot,
        requestId: command.requestId,
        response,
      }),
    );
  }

  #providerResult(
    operationId: CodeOperationCommand["operationId"],
    turn: CodeOperationTurnResult,
  ): CodeOperationResult {
    return decodeCodeOperationResult({
      kind: "provider-turn-state",
      operationId,
      state: turn.state,
      ...(turn.evidence === undefined
        ? {}
        : { evidence: this.#options.evidence.put(turn.evidence) }),
    });
  }

  #failed(
    operationId: CodeOperationCommand["operationId"],
    category:
      | "unavailable"
      | "unauthorized"
      | "unsupported"
      | "waiting"
      | "failed"
      | "invalid"
      | "stale",
    message: string,
  ): CodeOperationResult {
    return decodeCodeOperationResult({
      kind: "operation-failed",
      operationId,
      failure: { category, message },
    });
  }
}

/**
 * The images a turn's durable start recorded, in the order it recorded them.
 */
function recordedTurnAttachments(
  frames: ReadonlyArray<CodeOperationEventFrame>,
): ReadonlyArray<CodeAttachmentReference> {
  for (const frame of frames) {
    if (frame.event.kind === "conversation-turn-started") return frame.event.attachments ?? [];
  }
  return [];
}

function recordedTurnAccessPosture(
  frames: ReadonlyArray<CodeOperationEventFrame>,
): CodeThread["executionPolicy"] | undefined {
  for (const frame of frames) {
    if (frame.event.kind === "conversation-turn-started") return frame.event.executionPolicy;
  }
  return undefined;
}

/**
 * The posture this provider turn runs under. A recorded start is the requested
 * ceiling so recovery cannot widen a turn that already ran narrower — and a
 * later lower thread grant still clamps it, so a crashed Full-access turn
 * cannot resume after the user has taken that grant away. Otherwise the
 * composer intent is clamped to the thread: the host never grants more than
 * the thread already allows.
 */
function turnAccessPosture(
  thread: CodeThread,
  command: Extract<CodeOperationCommand, { readonly kind: "start-provider-turn" }>,
  recorded?: CodeThread["executionPolicy"],
): CodeThread["executionPolicy"] {
  const requested = recorded ?? command.executionPolicy;
  return clampTurnAccessPosture({
    thread: thread.executionPolicy,
    ...(requested === undefined ? {} : { requested }),
  });
}

function threadForTurn(
  thread: CodeThread,
  executionPolicy: CodeThread["executionPolicy"],
): CodeThread {
  return thread.executionPolicy === executionPolicy ? thread : { ...thread, executionPolicy };
}

function sameConversationStart(
  event: Extract<CodeOperationEvent, { readonly kind: "conversation-turn-started" }>,
  command: Extract<CodeOperationCommand, { readonly kind: "start-provider-turn" }>,
  thread: CodeThread,
): boolean {
  return (
    event.providerInstanceId === thread.providerInstanceId &&
    event.modelId === thread.modelId &&
    event.sessionId === command.sessionId &&
    event.prompt.contentId === command.prompt.contentId &&
    event.prompt.digest === command.prompt.digest &&
    event.prompt.byteLength === command.prompt.byteLength
  );
}

/**
 * A cached `running` provider-turn result is stale when the journal has no
 * durable launch/stream evidence after conversation-turn-started. Returning
 * that cached result would leave the thread permanently idle after a crash
 * between the operation-result append and RuntimeTurnController.launch.
 */
function isStaleRunningProviderTurn(
  result: CodeOperationResult,
  frames: ReadonlyArray<CodeOperationEventFrame>,
): boolean {
  if (result.kind !== "provider-turn-state" || result.state !== "running") return false;
  return !frames.some((frame) => isDurableProviderLaunchEvidence(frame.event));
}

function isDurableProviderLaunchEvidence(event: CodeOperationEvent): boolean {
  switch (event.kind) {
    case "provider-content":
    case "tool-activity":
    case "approval-requested":
    case "input-requested":
    case "file-change":
    case "diff":
    case "task-progress":
    case "usage":
    case "child-activity":
      return true;
    case "operation-result":
      return (
        event.result.kind === "provider-turn-state" &&
        event.result.state !== "running" &&
        event.result.state !== "waiting"
      );
    default:
      return false;
  }
}

function evidenceReferences(event: CodeOperationEvent): readonly CodeEvidenceReference[] {
  switch (event.kind) {
    case "conversation-turn-started":
      return [event.prompt];
    case "provider-content":
    case "terminal-output":
    case "diff":
      return [event.content];
    case "operation-result":
      return resultEvidenceReferences(event.result);
    default:
      return [];
  }
}

function resultEvidenceReferences(result: CodeOperationResult): readonly CodeEvidenceReference[] {
  switch (result.kind) {
    case "git-observed":
      return [result.diff];
    case "pull-request-review":
      return result.state === "observed" ? [result.description, result.diff] : [];
    case "terminal-state":
      return result.transcript === undefined ? [] : [result.transcript];
    case "repository-test-state":
    case "provider-turn-state":
      return result.evidence === undefined ? [] : [result.evidence];
    default:
      return [];
  }
}

function operationFor(kind: CodeOperationCommand["kind"]): CodeOperation {
  switch (kind) {
    case "observe-git":
    case "observe-pull-request":
    case "start-provider-turn":
    case "answer-provider-input":
    case "answer-provider-approval":
    case "cancel-provider-turn":
    case "attach-terminal":
      return "read";
    case "start-terminal":
    case "write-terminal":
    case "resize-terminal":
    case "stop-terminal":
      return "terminal";
    case "run-repository-test":
    case "cancel-repository-test":
      return "test";
    // A scaffold runs a generator that writes a directory of files. It is a
    // shell command with a narrower surface, not a new kind of authority.
    case "run-scaffold":
      return "terminal";
    case "stage-git":
      return "stage";
    case "unstage-git":
      return "unstage";
    // Drafting reads the checkout's own diff and writes a sentence. It
    // changes nothing, so it is an ordinary read.
    case "draft-git-text":
      return "read";
    case "discard-git-changes":
      return "discard";
    case "restore-git-checkpoint":
      return "restore-checkpoint";
    case "review-run":
      return "read";
    case "merge-run":
      return "merge-run";
    case "commit-git":
      return "commit";
    case "push-git":
      return "push";
    case "create-pull-request":
      return "create-pr";
    default:
      return "edit";
  }
}

function operationApprovalEffect(command: CodeOperationCommand): CodeApprovalEffect {
  return { kind: "operation", command } as CodeApprovalEffect;
}
