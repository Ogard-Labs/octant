import {
  decodeCodeOperationCommand,
  decodeCodeOperationResult,
  type CodeApprovalEffect,
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
  type CodeThreadId,
  type MentionableThreadId,
  type ProviderContextBlock,
  type WindowId,
} from "@octant/contracts";
import { authorizeCodeOperation, type CodeOperation } from "@octant/domain/code-policy";
import { THREAD_MENTION_UNREADABLE_CONTEXT } from "@octant/domain";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
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
    options?: { readonly afterTranscript: string },
  ) => () => void;
  readonly write: (terminalId: string, data: string) => void;
  readonly resize: (terminalId: string, columns: number, rows: number) => void;
  readonly terminate: (terminalId: string) => Promise<CodeOperationTerminalSnapshot>;
}

export interface CodeOperationTerminalSnapshot {
  readonly terminalId: string;
  readonly status: "running" | "exited" | "interrupted";
  readonly exitCode?: number;
  readonly transcript: { readonly chunks: readonly string[]; readonly truncated: boolean };
}

interface TerminalOutputEmission {
  readonly text: string;
  readonly replace: boolean;
  readonly snapshot: CodeOperationTerminalSnapshot;
}

interface TerminalOwner {
  readonly windowId: string;
  readonly threadId: string;
  readonly checkoutId: string;
  operationId?: CodeOperationId;
  nextCursor?: number;
  lastTerminalStatus?: CodeOperationTerminalSnapshot["status"];
  lastExitCode?: number;
  removeOutputListener?: () => void;
  outputBaseline?: string;
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

export interface CodeOperationGitPort {
  readonly observe: (input: {
    readonly checkoutRoot: string;
    readonly maxDiffBytes: number;
  }) => Promise<{
    readonly status: "ready" | "unavailable" | "failed";
    readonly head?: {
      readonly kind: "branch" | "detached";
      readonly name?: string;
      readonly oid: string;
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
        readonly kind: "branch" | "detached";
        readonly name?: string;
        readonly oid: string;
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
  readonly merge: (
    input: {
      readonly threadId: CodeThread["id"];
      readonly expectedHeadSha: string;
      readonly mergeMethod: "merge" | "squash" | "rebase";
      readonly confirmation: {
        readonly number: number;
        readonly baseRepository: string;
        readonly baseBranch: string;
        readonly headBranch: string;
        readonly mergeMethod: "merge" | "squash" | "rebase";
        readonly expectedHeadSha: string;
      };
    },
    signal: AbortSignal,
  ) => Promise<
    | {
        readonly status: "merged";
        readonly pullRequest: {
          readonly number: number;
          readonly url: string;
          readonly baseRepository: string;
          readonly baseBranch: string;
          readonly headOwner: string;
          readonly headBranch: string;
        };
      }
    | {
        readonly status: "unavailable" | "failed";
        readonly code?:
          | "conflict"
          | "checks"
          | "auth"
          | "not-found"
          | "sha-mismatch"
          | "dirty"
          | "not-mergeable";
      }
  >;
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
      readonly mergePreview?: {
        readonly headSha: string;
        readonly mergeable: boolean | null;
        readonly requiredChecksPassing: boolean;
        readonly advertisedMergeMethods: readonly ("merge" | "squash" | "rebase")[];
      };
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

export interface CodeOperationServiceOptions {
  readonly authority: CodeOperationAuthorityPort;
  readonly approvals?: CodeApprovalValidationPort;
  readonly terminals: CodeOperationTerminalPort;
  readonly repositoryTests: CodeOperationRepositoryTestPort;
  readonly git: CodeOperationGitPort;
  readonly pullRequests: CodeOperationPullRequestPort;
  readonly reviewFindings: CodeOperationReviewFindingPort;
  readonly turns: CodeOperationTurnPort;
  readonly evidence: CodeOperationEvidencePort;
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
}

export class CodeOperationService {
  readonly #options: CodeOperationServiceOptions;
  readonly #terminalOwners = new Map<string, TerminalOwner>();

  constructor(options: CodeOperationServiceOptions) {
    this.#options = options;
  }

  async execute(windowId: WindowId, rawCommand: unknown): Promise<CodeOperationResult> {
    const command = decodeCodeOperationCommand(rawCommand);
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
    const gate = await this.#authorize(windowId, command, scope.thread, scope.checkout);
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
          if (command.kind === "start-provider-turn" && recordedStart === undefined) {
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
              },
            });
            resultCursor += 1;
          }
          try {
            result = await this.#execute(command, windowId, scope.thread, scope.checkout, root);
          } catch (error) {
            const category =
              error instanceof ReviewFindingServiceError ? error.failure : ("failed" as const);
            result = this.#failed(command.operationId, category, "Code operation failed.");
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
      const recovered = await this.#providerTurn(command, windowId, thread, root.checkoutRoot);
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
    return this.#replay(threadId, operationId, afterCursor, limit).frames;
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
  ): Promise<"allow" | "waiting" | "unauthorized"> {
    const operation = operationFor(command.kind);
    const policy = authorizeCodeOperation({
      actor: "local-user",
      posture: thread.executionPolicy,
      operation,
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
          columns: command.columns,
          rows: command.rows,
          credentialReferences,
        });
        this.#terminalOwners.set(command.terminalId, {
          windowId: String(windowId),
          threadId: thread.id,
          checkoutId: checkout.id,
          outputBaseline: snapshot.transcript.chunks.join(""),
        });
        return this.#terminal(command.operationId, snapshot);
      }
      case "attach-terminal": {
        const ownerFailure = this.#requireTerminalOwner(command, windowId, thread, checkout);
        if (ownerFailure !== undefined) return ownerFailure;
        const snapshot = this.#options.terminals.attach(command.terminalId);
        const owner = this.#terminalOwners.get(command.terminalId)!;
        owner.outputBaseline = snapshot.transcript.chunks.join("");
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
      case "observe-git":
        return this.#gitObservation(command, root.checkoutRoot);
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
      case "create-pull-request":
        return this.#pullRequest(command);
      case "observe-pull-request":
        return this.#pullRequestReview(command);
      case "merge-pull-request":
        return this.#mergePullRequest(command);
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
        return this.#providerTurn(command, windowId, thread, root.checkoutRoot);
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

  #activateTerminalOutput(
    terminalId: string,
    operationId: CodeOperationId,
    nextCursor: number,
  ): void {
    const owner = this.#terminalOwners.get(terminalId);
    if (owner === undefined || this.#options.terminals.observe === undefined) return;
    owner.removeOutputListener?.();
    owner.operationId = operationId;
    owner.nextCursor = nextCursor;
    owner.lastTerminalStatus = "running";
    delete owner.lastExitCode;
    const outputBaseline = owner.outputBaseline;
    delete owner.outputBaseline;
    owner.removeOutputListener = this.#options.terminals.observe(
      terminalId,
      (emission) => {
        if (owner.operationId === undefined || owner.nextCursor === undefined) return;
        try {
          if (emission.text.length > 0) {
            const content = this.#options.evidence.put(emission.text, {
              truncated: emission.replace && emission.snapshot.transcript.truncated,
            });
            this.#options.events.append({
              threadId: owner.threadId as CodeThreadId,
              operationId: owner.operationId,
              expectedCursor: owner.nextCursor,
              event: {
                kind: "terminal-output",
                terminalId: terminalId as never,
                content,
                replace: emission.replace,
              },
            });
            owner.nextCursor += 1;
          }
          if (
            emission.snapshot.status !== owner.lastTerminalStatus ||
            emission.snapshot.exitCode !== owner.lastExitCode
          ) {
            this.#options.events.append({
              threadId: owner.threadId as CodeThreadId,
              operationId: owner.operationId,
              expectedCursor: owner.nextCursor,
              event: {
                kind: "terminal-state-changed",
                terminalId: terminalId as never,
                state: emission.snapshot.status,
                ...(emission.snapshot.status === "exited"
                  ? { exitCode: emission.snapshot.exitCode ?? null }
                  : {}),
              },
            });
            owner.nextCursor += 1;
            owner.lastTerminalStatus = emission.snapshot.status;
            if (emission.snapshot.exitCode === undefined) delete owner.lastExitCode;
            else owner.lastExitCode = emission.snapshot.exitCode;
            if (emission.snapshot.status !== "running") this.#deactivateTerminalOutput(terminalId);
          }
        } catch {
          this.#deactivateTerminalOutput(terminalId);
          try {
            const termination = this.#options.terminals.terminate(terminalId);
            void Promise.resolve(termination).catch(() => undefined);
          } catch {
            // Ownership is already revoked. A transport-level close failure is
            // contained here so an unjournaled PTY can never remain interactive.
          }
        }
      },
      outputBaseline === undefined ? undefined : { afterTranscript: outputBaseline },
    );
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
    mutation: "stage" | "discard" | "commit" | "push",
    result: GitMutationOutcome,
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
    });
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
      ...(result.mergePreview === undefined ? {} : { mergePreview: result.mergePreview }),
    });
  }

  async #mergePullRequest(
    command: Extract<CodeOperationCommand, { readonly kind: "merge-pull-request" }>,
  ): Promise<CodeOperationResult> {
    const result = await this.#options.pullRequests.merge(
      {
        threadId: command.threadId,
        expectedHeadSha: command.expectedHeadSha,
        mergeMethod: command.mergeMethod,
        confirmation: command.confirmation,
      },
      new AbortController().signal,
    );
    if (result.status === "merged") {
      const pr = result.pullRequest;
      return decodeCodeOperationResult({
        kind: "pull-request-state",
        operationId: command.operationId,
        state: "merged",
        number: pr.number,
        url: pr.url,
        headRepository: pr.headOwner,
        headBranch: pr.headBranch,
        baseRepository: pr.baseRepository,
        baseBranch: pr.baseBranch,
      });
    }
    return decodeCodeOperationResult({
      kind: "pull-request-state",
      operationId: command.operationId,
      state: result.status === "unavailable" ? "unavailable" : "failed",
      ...(result.code === undefined ? {} : { failureCode: result.code }),
    });
  }

  async #providerTurn(
    command: Extract<CodeOperationCommand, { readonly kind: "start-provider-turn" }>,
    windowId: WindowId,
    thread: CodeThread,
    checkoutRoot: string,
  ): Promise<CodeOperationResult> {
    const prompt = await this.#options.evidence.read?.(command.prompt);
    if (prompt === undefined)
      return this.#failed(
        command.operationId,
        "unavailable",
        "Provider prompt evidence is unavailable.",
      );
    const context = await this.#resolveThreadMentions(command.threadMentionIds, windowId);
    const turn = await this.#options.turns.start({
      windowId,
      thread,
      sessionId: command.sessionId,
      checkoutRoot,
      prompt,
      ...(context.length === 0 ? {} : { context }),
    });
    return this.#providerResult(command.operationId, turn);
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
    case "stage-git":
      return "stage";
    case "discard-git-changes":
      return "discard";
    case "commit-git":
      return "commit";
    case "push-git":
      return "push";
    case "create-pull-request":
      return "create-pr";
    case "merge-pull-request":
      return "merge-pr";
    default:
      return "edit";
  }
}

function operationApprovalEffect(command: CodeOperationCommand): CodeApprovalEffect {
  return { kind: "operation", command } as CodeApprovalEffect;
}
