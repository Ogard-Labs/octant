import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import {
  CodeApprovalId,
  MAX_CODE_OPERATION_TEXT_BYTES,
  decodeCodeOperationApprovalRequest,
  decodeCodeOperationApprovalConfirmation,
  decodeCodeCheckoutId,
  decodeCodeOperationCommand,
  decodeCodeRelativePath,
  decodeCodeReviewFindingId,
  type CodeCheckoutIdentity,
  type AppleActionRequest,
  type CodeOperationCommand,
  type CodeOperationFailure,
  type CodeConversationPage,
  type CodeOperationApprovalReceipt,
  type CodeOperationApprovalRequest,
  type CodeOperationApprovalChallenge,
  type CodeOperationApprovalConfirmation,
  type CodeEvidenceContentId,
  type CodeOperationEvent,
  type CodeOperationId,
  type CodeOperationResult,
  type CodeThread,
  type CodeThreadId,
  type EventActor,
  type ProviderRuntimeEvent,
  type WindowId,
} from "@octant/contracts";
import { Effect } from "effect";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import type { Journal } from "../persistence/journal";
import { GhPullRequestPort, createGhCommandPort, type GhDeliveryTarget } from "./ghPullRequestPort";
import { GitMutationPort } from "./gitMutationPort";
import { GitObservationPort, type GitObservationResult } from "./gitObservationPort";
import { GitService } from "./gitService";
import { CodeOperationEventStore } from "./codeOperationEventStore";
import { decidesCodeEffectsByApproval } from "@octant/domain";
import {
  approvalContextDigest,
  CodeOperationApprovalStore,
  type CodeApprovalValidationPort,
} from "./codeOperationApprovalStore";
import {
  CodeOperationService,
  CodeOperationServiceError,
  type CodeOperationAuthorityPort,
  type CodeOperationEvidencePort,
  type CodeOperationGitPort,
  type CodeOperationPullRequestPort,
  type CodeOperationServiceOptions,
  type CodeOperationTurnPort,
} from "./codeOperationService";
import type { CodeAttachmentStore } from "./codeAttachmentStore";
import { RepositoryTestProcessPort } from "./repositoryTestProcessPort";
import { RepositoryTestRunner } from "./repositoryTestRunner";
import { RepositoryTestDiscoveryService } from "./repositoryTestDiscoveryService";
import {
  ReviewFindingService,
  type ReviewFindingFilePort,
  type ReviewFindingPersistencePort,
} from "./reviewFindingService";
import { TerminalProcessPort } from "./terminalProcessPort";
import { TerminalService } from "./terminalService";
import { CodeSessionAuthorityStore } from "./codeSessionAuthorityStore";
import { CodeTurnRunner, type CodeTurnEvent, type CodeTurnOutcome } from "./codeTurnRunner";
import { createCodeAppManagedTools, type CodeAppManagedToolsOptions } from "./codeAppManagedTools";
import { combineAppManagedToolSets, type AppManagedToolSet } from "../providers/appManagedToolSet";
import { CodeEvidenceCapacityExceeded } from "./codeEvidenceStore";

type Awaitable<T> = T | Promise<T>;

interface RuntimePersistence extends ReviewFindingPersistencePort {
  readonly journal: Journal;
  readonly readCodeCheckout: (
    checkoutId: CodeCheckoutIdentity["id"],
  ) => CodeCheckoutIdentity | undefined;
}

interface CredentialResolver {
  resolve(reference: string): Promise<string | undefined>;
}

interface ProcessTestPort {
  execute: RepositoryTestProcessPort["execute"];
  readArtifact: RepositoryTestProcessPort["readArtifact"];
  reconcile?: () => Promise<void>;
}

export interface CodeOperationRuntimeOptions {
  readonly persistence: RuntimePersistence;
  readonly windowAccess: {
    readonly canAccessProject: CodeOperationAuthorityPort["canAccessProject"];
  };
  readonly resolveCheckoutRoot: CodeOperationAuthorityPort["resolveCheckoutRoot"];
  readonly resolveProviderDriver: (thread: CodeThread) => Awaitable<ProviderDriver | undefined>;
  readonly credentialResolver: CredentialResolver;
  readonly resolvePullRequestTarget: (
    threadId: CodeThreadId,
  ) => Promise<GhDeliveryTarget | undefined>;
  readonly reviewFiles: ReviewFindingFilePort;
  readonly evidence: CodeOperationEvidencePort;
  /** The images Code threads have staged for their next turn. */
  readonly attachments?: CodeAttachmentStore;
  readonly approvalValidator?: CodeApprovalValidationPort;
  readonly approvalStore?: CodeOperationApprovalStore;
  readonly sessionAuthority?: CodeSessionAuthorityStore;
  readonly actor: EventActor;
  readonly clock: () => string;
  readonly uuid: () => string;
  readonly ghExecutable?: string;
  readonly pullRequestPort?: CodeOperationPullRequestPort;
  readonly inheritedEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly terminalProcessPort?: Pick<TerminalProcessPort, "start"> & {
    readonly reconcile?: () => Promise<void>;
  };
  readonly repositoryTestProcessPort?: ProcessTestPort;
  /**
   * Discovery of the definitions a checkout offers. A run is authorized against
   * it, so the runtime always has one; the option exists so a host can share
   * the instance it already built for the listing surface.
   */
  readonly repositoryTestDiscovery?: Pick<RepositoryTestDiscoveryService, "discover">;
  readonly gitObservationPort?: Pick<GitObservationPort, "observe">;
  readonly gitMutationPort?: Pick<
    GitMutationPort,
    | "stage"
    | "discard"
    | "commit"
    | "push"
    | "revertCommit"
    | "snapshotWorkingTree"
    | "restoreWorkingTree"
  >;
  readonly supportsAppManagedTools?: (thread: CodeThread) => boolean;
  /**
   * Whether the thread's provider can take an image. A host that cannot say so
   * answers false: a turn that attached images then fails in words rather than
   * reaching the provider with the pictures silently dropped.
   */
  readonly supportsAttachments?: (thread: CodeThread) => boolean;
  readonly browserAutomation?: CodeAppManagedToolsOptions["browser"];
  /** Optional Project-fixed, read-only GitHub tools composed per active turn. */
  readonly githubReadTools?: (input: {
    readonly windowId: WindowId;
    readonly thread: CodeThread;
    readonly readThread: (windowId: WindowId, threadId: CodeThreadId) => CodeThread | undefined;
  }) => AppManagedToolSet | undefined;
  /** Reads the `#thread` mentions a turn names, on that turn's own principal. */
  readonly resolveThreadMentionContext?: CodeOperationServiceOptions["resolveThreadMentionContext"];
}

export interface CodeOperationRuntime {
  execute(windowId: WindowId, command: unknown): Promise<CodeOperationResult>;
  inspectTerminal(
    windowId: WindowId,
    input: import("@octant/contracts").CodeTerminalInspectionRequest,
  ): Promise<import("@octant/contracts").CodeTerminalInspection>;
  subscribe(
    windowId: WindowId,
    threadId: CodeThreadId,
    operationId: CodeOperationId,
    afterCursor: number,
    limit: number,
  ): Promise<readonly import("@octant/contracts").CodeOperationEventFrame[]>;
  conversation(
    windowId: WindowId,
    threadId: CodeThreadId,
    afterCursor: number,
    limit: number,
  ): Promise<CodeConversationPage>;
  readEvidence(
    windowId: WindowId,
    threadId: CodeThreadId,
    operationId: CodeOperationId,
    contentId: CodeEvidenceContentId,
  ): Promise<{ readonly bytes: Uint8Array; readonly digest: string; readonly byteLength: number }>;
  prepareApproval(
    windowId: WindowId,
    request: CodeOperationApprovalRequest,
  ): Promise<CodeOperationApprovalChallenge | undefined>;
  confirmApproval(
    windowId: WindowId,
    confirmation: CodeOperationApprovalConfirmation,
  ): Promise<CodeOperationApprovalReceipt | undefined>;
  validateAppleApproval(windowId: WindowId, request: AppleActionRequest): Promise<boolean>;
  revokeApprovals(windowId: WindowId): void;
  close(): Promise<void>;
  reconcile?: () => Promise<void>;
}

export function createCodeOperationRuntime(
  options: CodeOperationRuntimeOptions,
): CodeOperationRuntime {
  const events = new CodeOperationEventStore({
    journal: options.persistence.journal,
    actor: options.actor,
    clock: options.clock,
    uuid: options.uuid,
  });
  const roots = new Map<
    string,
    Awaited<ReturnType<CodeOperationAuthorityPort["resolveCheckoutRoot"]>>
  >();
  const authority: CodeOperationAuthorityPort = {
    readThread: (threadId) => options.persistence.readCodeThread(threadId),
    effectiveThread: (windowId, thread) =>
      options.sessionAuthority?.effectiveThread(windowId, thread) ?? thread,
    readCheckout: (checkoutId) => options.persistence.readCodeCheckout(checkoutId),
    canAccessProject: options.windowAccess.canAccessProject,
    approvalContextDigest: async (_windowId, command, thread, checkout) => {
      const context = await approvalContext(options, command, thread, checkout);
      return context === undefined ? undefined : approvalContextDigest(context);
    },
    resolveCheckoutRoot: async (windowId, thread, checkout) => {
      const root = await options.resolveCheckoutRoot(windowId, thread, checkout);
      roots.set(String(thread.id), root);
      return root;
    },
  };
  const approvalStore =
    options.approvalValidator === undefined
      ? (options.approvalStore ??
        new CodeOperationApprovalStore({
          uuid: options.uuid,
          now: () => Date.parse(options.clock()),
        }))
      : undefined;
  const approvalValidator = options.approvalValidator ?? approvalStore;

  const terminalProcessPort = options.terminalProcessPort ?? new TerminalProcessPort();
  const terminal = new TerminalService({
    port: terminalProcessPort,
    inheritedEnvironment: options.inheritedEnvironment ?? process.env,
    credentials: {
      resolve: async (reference) => {
        const value = await options.credentialResolver.resolve(reference);
        if (value === undefined) throw new Error("Credential is unavailable.");
        return value;
      },
    },
  });
  const testProcess = options.repositoryTestProcessPort ?? new RepositoryTestProcessPort();
  const testRunner = new RepositoryTestRunner({
    execute: (input, signal) => testProcess.execute(input, signal),
    readArtifact: (input) => testProcess.readArtifact(input),
    now: options.clock,
    newId: options.uuid,
  });
  const activeTests = new Map<
    string,
    Readonly<{
      threadId: string;
      checkoutId: string;
      controller: AbortController;
      done: Promise<void>;
    }>
  >();
  const testDiscovery = options.repositoryTestDiscovery ?? new RepositoryTestDiscoveryService();
  const repositoryTests = {
    discover: (input: { readonly checkoutId: string; readonly rootPath: string }) =>
      testDiscovery.discover(input),
    run: async (input: Parameters<CodeOperationServiceOptions["repositoryTests"]["run"]>[0]) => {
      if (activeTests.has(input.runId)) throw new Error("Repository test is already running.");
      const controller = new AbortController();
      let markDone!: () => void;
      const done = new Promise<void>((resolve) => {
        markDone = resolve;
      });
      activeTests.set(input.runId, {
        threadId: input.threadId,
        checkoutId: input.checkoutId,
        controller,
        done,
      });
      try {
        return await testRunner.run({ ...input, signal: controller.signal });
      } finally {
        activeTests.delete(input.runId);
        markDone();
      }
    },
    cancel: async (input: { testRunId: string; threadId: string; checkoutId: string }) => {
      const active = activeTests.get(input.testRunId);
      if (
        active === undefined ||
        active.threadId !== input.threadId ||
        active.checkoutId !== input.checkoutId
      ) {
        return false;
      }
      active.controller.abort();
      return true;
    },
  };
  const observation = options.gitObservationPort ?? new GitObservationPort();
  const mutation = options.gitMutationPort ?? new GitMutationPort();
  const gitService = new GitService(observation, mutation);
  const git = codeOperationGitPort(gitService);
  const pullRequests = options.pullRequestPort ?? createPullRequestPort(options);
  const reviewFindings = new ReviewFindingService({
    persistence: options.persistence,
    access: options.windowAccess,
    files: options.reviewFiles,
    uuid: options.uuid,
    clock: options.clock,
  });
  const turns = new RuntimeTurnController({ options, events, roots, gitService });
  const service = new CodeOperationService({
    authority,
    ...(approvalValidator === undefined ? {} : { approvals: approvalValidator }),
    terminals: terminal,
    repositoryTests,
    git,
    pullRequests,
    reviewFindings: {
      create: (windowId, input) => reviewFindings.create(windowId, input),
      changeState: (windowId, input) =>
        reviewFindings.changeState(windowId, {
          ...input,
          findingId: decodeCodeReviewFindingId(input.findingId),
        }),
    },
    turns,
    evidence: options.evidence,
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
    ...(options.supportsAttachments === undefined
      ? {}
      : { supportsAttachments: options.supportsAttachments }),
    events,
    ...(options.resolveThreadMentionContext === undefined
      ? {}
      : { resolveThreadMentionContext: options.resolveThreadMentionContext }),
  });
  turns.bindService(service);

  return {
    prepareApproval: async (windowId, rawRequest) => {
      if (approvalStore === undefined) return undefined;
      const request = decodeCodeOperationApprovalRequest(rawRequest);
      let thread: CodeThread | undefined;
      let checkout: CodeCheckoutIdentity | undefined;
      if (request.effect.kind === "operation") {
        const { command } = request.effect;
        thread = options.persistence.readCodeThread(command.threadId);
        checkout = options.persistence.readCodeCheckout(command.checkoutId);
        if (
          thread === undefined ||
          checkout === undefined ||
          thread.checkoutId !== checkout.id ||
          thread.repositoryId !== checkout.repositoryId ||
          thread.lifecycle !== "active" ||
          !decidesCodeEffectsByApproval(thread.executionPolicy) ||
          checkout.availability !== "available" ||
          !(await options.windowAccess.canAccessProject(windowId, thread.projectId))
        ) {
          return undefined;
        }
      } else if (request.effect.kind === "apple-action") {
        const resolved = await resolveAppleApprovalScope(options, windowId, request.effect.request);
        thread = resolved?.thread;
        checkout = resolved?.checkout;
      } else if (request.effect.kind === "create-thread-full-access") {
        thread = request.effect.thread;
        checkout = options.persistence.readCodeCheckout(thread.checkoutId);
        if (
          checkout === undefined ||
          checkout.repositoryId !== thread.repositoryId ||
          checkout.availability !== "available" ||
          thread.version !== 1 ||
          !(await options.windowAccess.canAccessProject(windowId, thread.projectId))
        ) {
          return undefined;
        }
      } else {
        thread = options.persistence.readCodeThread(request.effect.threadId);
        checkout =
          thread === undefined
            ? undefined
            : options.persistence.readCodeCheckout(thread.checkoutId);
        if (
          thread === undefined ||
          checkout === undefined ||
          checkout.repositoryId !== thread.repositoryId ||
          checkout.availability !== "available" ||
          thread.lifecycle !== "active" ||
          thread.version !== request.effect.expectedVersion ||
          !(await options.windowAccess.canAccessProject(windowId, thread.projectId))
        ) {
          return undefined;
        }
      }
      if (thread === undefined || checkout === undefined) return undefined;
      const command = request.effect.kind === "operation" ? request.effect.command : undefined;
      const context = await approvalContext(options, command, thread, checkout);
      if (context === undefined) return undefined;
      const prompt = approvalPrompt(request.effect, thread, checkout, context.pullRequestTarget);
      return approvalStore.prepare({
        windowId,
        effect: request.effect,
        contextDigest: approvalContextDigest(context),
        projectId: thread.projectId,
        threadId: thread.id,
        threadTitle: thread.title,
        checkoutId: checkout.id,
        repositoryId: checkout.repositoryId,
        checkoutHead: checkout.head,
        ...(context.pullRequestTarget === undefined
          ? {}
          : { pullRequestTarget: context.pullRequestTarget }),
        ...prompt,
      });
    },
    confirmApproval: async (windowId, rawConfirmation) => {
      if (approvalStore === undefined) return undefined;
      const confirmation = decodeCodeOperationApprovalConfirmation(rawConfirmation);
      return approvalStore.confirm({ windowId, challengeId: confirmation.challengeId });
    },
    validateAppleApproval: async (windowId, request) => {
      if (approvalValidator === undefined || request.approval.kind !== "approved") return false;
      const resolved = await resolveAppleApprovalScope(options, windowId, request);
      if (resolved === undefined) return false;
      const context = await approvalContext(options, undefined, resolved.thread, resolved.checkout);
      if (context === undefined) return false;
      return await approvalValidator.validate({
        windowId,
        effect: { kind: "apple-action", request },
        contextDigest: approvalContextDigest(context),
        approvalId: request.approval.approvalId,
      });
    },
    revokeApprovals: (windowId) => approvalStore?.revokeWindow(windowId),
    execute: async (windowId, rawCommand) => {
      const command = decodeCodeOperationCommand(rawCommand);
      if (command.kind === "start-provider-turn") turns.noteStart(command);
      try {
        const result = await service.execute(windowId, command);
        if (
          command.kind === "start-provider-turn" &&
          result.kind === "provider-turn-state" &&
          result.state === "running"
        ) {
          turns.launch(command.threadId);
        }
        return result;
      } finally {
        if (command.kind === "start-provider-turn") turns.clearStart(command.threadId);
      }
    },
    inspectTerminal: async (windowId, input) => {
      const snapshot = await service.readTerminal(windowId, input);
      return { terminalId: input.terminalId, state: snapshot.status };
    },
    subscribe: (windowId, threadId, operationId, afterCursor, limit) =>
      service.subscribe(windowId, threadId, operationId, afterCursor, limit),
    conversation: async (windowId, threadId, afterCursor, limit) => {
      const thread = options.persistence.readCodeThread(threadId);
      if (thread === undefined || thread.id !== threadId) {
        throw new CodeOperationServiceError("invalid");
      }
      if (!(await options.windowAccess.canAccessProject(windowId, thread.projectId))) {
        throw new CodeOperationServiceError("unauthorized");
      }
      return events.conversation({ threadId, afterCursor, limit });
    },
    readEvidence: async (windowId, threadId, operationId, contentId) => {
      try {
        const evidence = await service.readEvidence(windowId, threadId, operationId, contentId);
        const bytes = new TextEncoder().encode(evidence.text);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (
          bytes.byteLength !== evidence.reference.byteLength ||
          digest !== evidence.reference.digest
        ) {
          throw new Error("verification failed");
        }
        return { bytes, digest, byteLength: bytes.byteLength };
      } catch (error) {
        const category =
          error instanceof CodeOperationServiceError ? error.category : ("unavailable" as const);
        throw Object.assign(new Error("Code operation evidence is unavailable."), {
          failure: {
            category,
            message:
              category === "unauthorized"
                ? "Code operation evidence is unauthorized."
                : "Code operation evidence is unavailable.",
          },
        });
      }
    },
    close: async () => {
      const tests = [...activeTests.values()];
      for (const test of tests) test.controller.abort();
      await Promise.allSettled(tests.map((test) => test.done));
      await turns.closeAll();
      await terminal.closeAll();
    },
    reconcile: async () => {
      await Promise.all([
        terminalProcessPort.reconcile?.() ?? Promise.resolve(),
        testProcess.reconcile?.() ?? Promise.resolve(),
      ]);
    },
  };
}

interface ApprovalContext {
  readonly projectId: CodeThread["projectId"];
  readonly threadId: CodeThread["id"];
  readonly checkoutId: CodeCheckoutIdentity["id"];
  readonly repositoryId: CodeCheckoutIdentity["repositoryId"];
  readonly checkoutHead: CodeCheckoutIdentity["head"];
  readonly pullRequestTarget?: Readonly<{
    baseRepository: string;
    baseBranch: string;
    head: string;
  }>;
}

async function approvalContext(
  options: CodeOperationRuntimeOptions,
  command: CodeOperationCommand | undefined,
  thread: CodeThread,
  checkout: CodeCheckoutIdentity,
): Promise<ApprovalContext | undefined> {
  const pullRequestTarget =
    command?.kind === "create-pull-request"
      ? await options.resolvePullRequestTarget(thread.id)
      : undefined;
  if (command?.kind === "create-pull-request" && pullRequestTarget === undefined) return undefined;
  return {
    projectId: thread.projectId,
    threadId: thread.id,
    checkoutId: checkout.id,
    repositoryId: checkout.repositoryId,
    checkoutHead: checkout.head,
    ...(pullRequestTarget === undefined
      ? {}
      : {
          pullRequestTarget: {
            baseRepository: pullRequestTarget.baseRepository,
            baseBranch: pullRequestTarget.baseBranch,
            head: pullRequestTarget.head,
          },
        }),
  };
}

async function resolveAppleApprovalScope(
  options: CodeOperationRuntimeOptions,
  windowId: WindowId,
  request: AppleActionRequest,
): Promise<{ readonly thread: CodeThread; readonly checkout: CodeCheckoutIdentity } | undefined> {
  const thread = options.persistence.readCodeThread(request.threadId);
  const checkout = options.persistence.readCodeCheckout(request.checkoutId);
  if (
    thread === undefined ||
    checkout === undefined ||
    thread.checkoutId !== checkout.id ||
    thread.repositoryId !== checkout.repositoryId ||
    thread.projectId !== request.authority.projectId ||
    thread.providerInstanceId !== request.authority.providerInstanceId ||
    thread.lifecycle !== "active" ||
    !decidesCodeEffectsByApproval(thread.executionPolicy) ||
    checkout.availability !== "available" ||
    request.authority.mode !== "code" ||
    request.authority.extension.kind !== "core" ||
    !(await options.windowAccess.canAccessProject(windowId, thread.projectId))
  ) {
    return undefined;
  }
  return { thread, checkout };
}

function approvalPrompt(
  effect: CodeOperationApprovalRequest["effect"],
  thread: CodeThread,
  checkout: CodeCheckoutIdentity,
  pullRequestTarget: ApprovalContext["pullRequestTarget"],
): { readonly message: string; readonly detail: string } {
  const head =
    checkout.head.kind === "branch"
      ? `${checkout.head.name} @ ${checkout.head.oid}`
      : `detached @ ${checkout.head.oid}`;
  const scope = [
    `Project: ${thread.projectId}`,
    `Thread: ${thread.title} (${thread.id})`,
    `Repository: ${checkout.repositoryId}`,
    `Checkout: ${checkout.id}`,
    `HEAD: ${head}`,
  ].join("\n");
  let message: string;
  let effectDetail: string;
  if (effect.kind === "create-thread-full-access") {
    message = "Allow full access for this Code thread?";
    effectDetail = `Full repository and shell access · ${persistenceLabel(effect.thread.permissionPersistence)}`;
  } else if (effect.kind === "change-thread-full-access") {
    message = "Elevate this Code thread to full access?";
    effectDetail = `Full repository and shell access · ${persistenceLabel(effect.permissionPersistence)}`;
  } else if (effect.kind === "apple-action") {
    message = `Allow Apple ${effect.request.kind}?`;
    effectDetail = [
      `Action: ${effect.request.kind}`,
      `Platform: ${"platform" in effect.request ? effect.request.platform : "Simulator"}`,
      ...(effect.request.simulatorId === undefined
        ? []
        : [`Simulator: ${effect.request.simulatorId}`]),
      ...("projectPath" in effect.request ? [`Project: ${effect.request.projectPath}`] : []),
      ...("scheme" in effect.request && effect.request.scheme !== undefined
        ? [`Scheme: ${effect.request.scheme}`]
        : []),
    ].join("\n");
  } else {
    const command = effect.command;
    switch (command.kind) {
      case "start-terminal":
        message = "Allow terminal access?";
        effectDetail = `Start repository terminal (${command.columns} × ${command.rows})${command.credentialRefs.length === 0 ? "" : ` with credentials: ${command.credentialRefs.join(", ")}`}`;
        break;
      case "run-repository-test":
        message = "Allow repository test execution?";
        effectDetail = `${command.definition.name}\n${command.definition.argv.join(" ")}\nWorking directory: ${command.definition.cwd}`;
        break;
      case "cancel-repository-test":
        message = "Allow repository test cancellation?";
        effectDetail = `Cancel test run ${command.testRunId}`;
        break;
      case "stage-git":
        message = "Allow Code stage operation?";
        effectDetail = command.paths.join("\n");
        break;
      case "discard-git-changes":
        message = "Discard uncommitted changes?";
        effectDetail = `These files lose their uncommitted changes:\n${command.paths.join("\n")}`;
        break;
      case "commit-git":
        message = "Allow Code commit operation?";
        effectDetail = `${command.message}\n\n${command.stagedSummary.map(({ path }) => path).join("\n")}`;
        break;
      case "push-git":
        message = "Allow Code push operation?";
        effectDetail = `${command.remote}: ${command.localRef} → ${command.remoteRef}\nHEAD ${command.expectedHeadOid}`;
        break;
      case "create-pull-request":
        message = "Allow pull request creation?";
        effectDetail = [
          `Target: ${pullRequestTarget?.baseRepository}:${pullRequestTarget?.baseBranch}`,
          `Head: ${pullRequestTarget?.head}`,
          `Title: ${command.title}`,
          "Body:",
          command.body,
        ].join("\n");
        break;
      case "create-review-finding":
        message = "Allow local review update?";
        effectDetail = `${command.path} · ${command.severity}\n${command.summary}`;
        break;
      case "update-review-finding":
        message = "Allow local review update?";
        effectDetail = `${command.state} finding ${command.findingId}`;
        break;
      default:
        throw new TypeError("Unsupported Code approval effect.");
    }
  }
  return { message, detail: boundApprovalDetail(`${scope}\n\n${effectDetail}`) };
}

const APPROVAL_DETAIL_SUFFIX =
  "\n[Additional approval detail omitted; the exact effect remains digest-bound.]";

function boundApprovalDetail(detail: string): string {
  const maximumBytes = MAX_CODE_OPERATION_TEXT_BYTES + 4_096;
  const bytes = new TextEncoder().encode(detail);
  if (bytes.byteLength <= maximumBytes) return detail;
  const suffixBytes = new TextEncoder().encode(APPROVAL_DETAIL_SUFFIX).byteLength;
  const prefixBytes = Math.max(0, maximumBytes - suffixBytes);
  return `${new TextDecoder().decode(bytes.slice(0, prefixBytes))}${APPROVAL_DETAIL_SUFFIX}`;
}

function persistenceLabel(value: "current-session" | "project-default"): string {
  return value === "current-session" ? "current session only" : "remember for this Project";
}

interface ActiveTurn {
  readonly windowId: WindowId;
  readonly thread: CodeThread;
  readonly operationId: CodeOperationId;
  readonly sessionId: string;
  readonly checkoutRoot: string;
  readonly driver: ProviderDriver;
  readonly secrets: readonly string[];
  readonly abort: AbortController;
  readonly approvals: Map<string, string>;
  readonly questions: Set<string>;
  connection?: ProviderConnection;
  cursor: number;
  state: "running" | "waiting" | "completed" | "interrupted" | "failed";
  lastPersistedState?: CodeTurnOutcome;
  launch?: () => void;
}

class RuntimeTurnController implements CodeOperationTurnPort {
  readonly #options: CodeOperationRuntimeOptions;
  readonly #events: CodeOperationEventStore;
  readonly #roots: Map<
    string,
    Awaited<ReturnType<CodeOperationAuthorityPort["resolveCheckoutRoot"]>>
  >;
  readonly #git: GitService;
  #service: CodeOperationService | undefined;
  readonly #runner = new CodeTurnRunner();
  readonly #pending = new Map<
    string,
    Extract<CodeOperationCommand, { kind: "start-provider-turn" }>
  >();
  readonly #active = new Map<string, ActiveTurn>();

  constructor(input: {
    options: CodeOperationRuntimeOptions;
    events: CodeOperationEventStore;
    roots: Map<string, Awaited<ReturnType<CodeOperationAuthorityPort["resolveCheckoutRoot"]>>>;
    gitService: GitService;
  }) {
    this.#options = input.options;
    this.#events = input.events;
    this.#roots = input.roots;
    this.#git = input.gitService;
  }

  bindService(service: CodeOperationService): void {
    this.#service = service;
  }

  noteStart(command: Extract<CodeOperationCommand, { kind: "start-provider-turn" }>): void {
    this.#pending.set(String(command.threadId), command);
  }

  clearStart(threadId: CodeThreadId): void {
    this.#pending.delete(String(threadId));
  }

  launch(threadId: CodeThreadId): void {
    const active = this.#active.get(String(threadId));
    const launch = active?.launch;
    if (active !== undefined) delete active.launch;
    launch?.();
  }

  async start(input: Parameters<CodeOperationTurnPort["start"]>[0]) {
    const key = String(input.thread.id);
    const existing = this.#active.get(key);
    if (
      existing !== undefined &&
      existing.sessionId === input.sessionId &&
      existing.checkoutRoot === input.checkoutRoot
    ) {
      // Idempotent recovery: a prior start that returned `running` before
      // launch()/stream evidence may still own the in-memory controller.
      return turnState(existing.state);
    }
    const command = this.#pending.get(key);
    const root = this.#roots.get(key);
    if (
      command === undefined ||
      root === undefined ||
      root === null ||
      root.checkoutRoot !== input.checkoutRoot ||
      this.#active.has(key)
    )
      return turnState("failed");
    const driver = await this.#options.resolveProviderDriver(input.thread);
    if (driver === undefined) return turnState("failed");
    const secrets: string[] = [];
    for (const credential of root.credentialReferences) {
      const value = await this.#options.credentialResolver.resolve(credential.reference);
      if (value === undefined) return turnState("failed");
      if (value.length > 0) secrets.push(value);
    }
    const active: ActiveTurn = {
      windowId: input.windowId,
      thread: input.thread,
      operationId: command.operationId,
      sessionId: input.sessionId,
      checkoutRoot: input.checkoutRoot,
      driver,
      secrets,
      abort: new AbortController(),
      approvals: new Map(),
      questions: new Set(),
      cursor: 0,
      state: "running",
    };
    active.launch = () => this.#launch(active, input.prompt, input.context, input.attachments);
    this.#active.set(key, active);
    return turnState("running");
  }

  async answerInput(input: Parameters<CodeOperationTurnPort["answerInput"]>[0]) {
    const active = this.#owned(input.thread, input.checkoutRoot);
    if (
      active === undefined ||
      active.connection === undefined ||
      !active.questions.has(input.requestId)
    )
      return turnState("failed");
    active.questions.delete(input.requestId);
    await Effect.runPromise(
      active.connection.answerUserInput({
        sessionId: active.sessionId as never,
        requestId: input.requestId,
        answer: input.response,
      }),
    );
    return turnState(active.state);
  }

  async answerApproval(input: Parameters<CodeOperationTurnPort["answerApproval"]>[0]) {
    const active = this.#owned(input.thread, input.checkoutRoot);
    const providerRequestId = active?.approvals.get(input.approvalId);
    if (
      active === undefined ||
      active.connection === undefined ||
      providerRequestId === undefined ||
      active.thread.executionPolicy === "plan" ||
      active.thread.executionPolicy !== input.thread.executionPolicy ||
      active.thread.permissionPersistence !== input.thread.permissionPersistence
    )
      return turnState("failed");
    active.approvals.delete(input.approvalId);
    await Effect.runPromise(
      active.connection.answerApproval({
        sessionId: active.sessionId as never,
        requestId: providerRequestId,
        approved: input.decision === "approved",
      }),
    );
    return turnState(active.state);
  }

  async cancel(input: Parameters<CodeOperationTurnPort["cancel"]>[0]) {
    const active = this.#owned(input.thread, input.checkoutRoot);
    if (active === undefined) return turnState("failed");
    active.state = "interrupted";
    active.abort.abort();
    if (active.connection !== undefined) {
      await Effect.runPromise(
        active.connection
          .interrupt(active.sessionId as never)
          .pipe(Effect.catchAll(() => Effect.void)),
      );
    }
    return turnState("interrupted");
  }

  async closeAll(): Promise<void> {
    const activeTurns = [...this.#active.values()];
    this.#active.clear();
    this.#pending.clear();
    await Promise.all(
      activeTurns.map(async (active) => {
        active.state = "interrupted";
        active.abort.abort();
        if (active.connection === undefined) return;
        await Effect.runPromise(
          active.connection
            .interrupt(active.sessionId as never)
            .pipe(Effect.catchAll(() => Effect.void)),
        );
        await Effect.runPromise(
          active.connection
            .stop(active.sessionId as never)
            .pipe(Effect.catchAll(() => Effect.void)),
        );
      }),
    );
  }

  #owned(thread: CodeThread, checkoutRoot: string): ActiveTurn | undefined {
    const active = this.#active.get(String(thread.id));
    return active !== undefined &&
      active.checkoutRoot === checkoutRoot &&
      active.thread.checkoutId === thread.checkoutId &&
      active.thread.projectId === thread.projectId
      ? active
      : undefined;
  }

  #launch(
    active: ActiveTurn,
    prompt: string,
    context: Parameters<CodeOperationTurnPort["start"]>[0]["context"],
    attachments: Parameters<CodeOperationTurnPort["start"]>[0]["attachments"],
  ): void {
    const replay = this.#events.replay({
      threadId: active.thread.id,
      operationId: active.operationId,
      afterCursor: 0,
      limit: 256,
    });
    if (replay.status !== "ok") {
      active.state = "waiting";
      return;
    }
    active.cursor = replay.nextCursor;
    void Effect.runPromise(
      Effect.scoped(
        this.#runner.run({
          thread: active.thread,
          sessionId: active.sessionId as never,
          checkoutRoot: active.checkoutRoot,
          prompt,
          ...(context === undefined ? {} : { context }),
          ...(attachments === undefined ? {} : { attachments }),
          signal: active.abort.signal,
          provider: {
            acquire: (acquireInput) => {
              if (
                acquireInput.projectRoot !== active.checkoutRoot ||
                acquireInput.permissionPersistence !== active.thread.permissionPersistence
              )
                return Effect.fail({
                  category: "unauthorized",
                  message: "Provider authority mismatch.",
                });
              return active.driver.acquire(acquireInput).pipe(
                Effect.tap((connection) =>
                  Effect.sync(() => {
                    active.connection = connection;
                  }),
                ),
              );
            },
          },
          sanitizeProviderEvent: ({ event }) =>
            Effect.try({
              try: () => sanitizeProviderEvent(event, active.checkoutRoot, active.secrets),
              catch: () => ({
                category: "failed" as const,
                message: "Provider event sanitization failed.",
              }),
            }),
          reconcileObservation: ({ claim }) =>
            Effect.promise(async () => {
              if (claim.kind === "file-change" || claim.kind === "diff") {
                const observation = await this.#git.observe(active.checkoutRoot);
                return observation.status === "ready"
                  ? { status: "confirmed" as const, summary: "Checkout observation completed." }
                  : { status: "waiting" as const, summary: "Checkout observation unavailable." };
              }
              return {
                status: "not-confirmed" as const,
                summary: "Provider tool claim is observational.",
              };
            }),
          ...(this.#service !== undefined &&
          this.#options.supportsAppManagedTools?.(active.thread) === true
            ? {
                appManagedTools: combineAppManagedToolSets(
                  createCodeAppManagedTools({
                    windowId: active.windowId,
                    thread: active.thread,
                    readThread: (windowId, threadId) => this.#effectiveThread(windowId, threadId),
                    uuid: this.#options.uuid,
                    executeOperation: (windowId, command) =>
                      this.#service!.execute(windowId, command),
                    terminal: {
                      read: (windowId, input) => this.#service!.readTerminal(windowId, input),
                      interrupt: (windowId, input) =>
                        this.#service!.interruptTerminal(windowId, input),
                      terminate: (windowId, input) =>
                        this.#service!.terminateTerminal(windowId, input),
                    },
                    ...(this.#options.browserAutomation === undefined
                      ? {}
                      : { browser: this.#options.browserAutomation }),
                  }),
                  this.#options.githubReadTools?.({
                    windowId: active.windowId,
                    thread: active.thread,
                    readThread: (windowId, threadId) => this.#effectiveThread(windowId, threadId),
                  }),
                ),
              }
            : {}),
          persistEvent: (event) => Effect.sync(() => this.#persistNormalized(active, event)),
          persistOutcome: (outcome) => Effect.sync(() => this.#persistOutcome(active, outcome)),
        }),
      ),
    )
      .catch((error: unknown) => {
        if (active.state !== "running") return;
        try {
          this.#persistOutcome(active, "failed", evidenceCapacityFailure(error));
        } catch {
          active.state = "failed";
        }
      })
      .finally(() => {
        if (this.#active.get(String(active.thread.id)) === active)
          this.#active.delete(String(active.thread.id));
      });
  }

  #effectiveThread(windowId: WindowId, threadId: CodeThreadId): CodeThread | undefined {
    const stored = this.#options.persistence.readCodeThread(threadId);
    return stored === undefined
      ? undefined
      : (this.#options.sessionAuthority?.effectiveThread(windowId, stored) ?? stored);
  }

  #persistNormalized(active: ActiveTurn, event: CodeTurnEvent): void {
    const operationEvent = normalizedOperationEvent(
      event,
      active,
      this.#options.evidence,
      this.#options.uuid,
    );
    if (operationEvent === undefined) return;
    const frame = this.#events.append({
      threadId: active.thread.id,
      operationId: active.operationId,
      expectedCursor: active.cursor,
      event: operationEvent,
    });
    active.cursor = frame.cursor;
  }

  #persistOutcome(
    active: ActiveTurn,
    outcome: CodeTurnOutcome,
    failure?: CodeOperationFailure,
  ): void {
    active.state = outcome;
    if (active.lastPersistedState === outcome && failure === undefined) return;
    active.lastPersistedState = outcome;
    const frame = this.#events.append({
      threadId: active.thread.id,
      operationId: active.operationId,
      expectedCursor: active.cursor,
      event: {
        kind: "operation-state",
        state: outcome,
        ...(failure === undefined ? {} : { failure }),
      },
    });
    active.cursor = frame.cursor;
  }
}

function evidenceCapacityFailure(error: unknown): CodeOperationFailure | undefined {
  const capacityExceeded =
    error instanceof CodeEvidenceCapacityExceeded ||
    (error instanceof Error &&
      (error.name.includes("CodeEvidenceCapacityExceeded") ||
        error.message.includes("Code evidence storage capacity is exhausted") ||
        error.stack?.includes("CodeEvidenceCapacityExceeded") === true));
  if (!capacityExceeded) return undefined;
  return {
    category: "unavailable",
    message:
      "Local Code evidence storage is full. Back up this Octant profile and clear its local application data before retrying.",
  };
}

function normalizedOperationEvent(
  event: CodeTurnEvent,
  active: ActiveTurn,
  evidence: CodeOperationEvidencePort,
  uuid: () => string,
): CodeOperationEvent | undefined {
  if (event.category === "message" || event.category === "reasoning") {
    return {
      kind: "provider-content",
      channel: event.category,
      content: evidence.put(event.text ?? " "),
    };
  }
  if (event.category === "approval" && event.requestId !== undefined) {
    const approvalId = CodeApprovalId.make(uuid());
    active.approvals.set(String(approvalId), event.requestId);
    return {
      kind: "approval-requested",
      approvalId,
      action: "provider-tool",
      summary: event.text ?? "Provider approval requested.",
    };
  }
  if (event.category === "question" && event.requestId !== undefined) {
    active.questions.add(event.requestId);
    return {
      kind: "input-requested",
      requestId: event.requestId,
      prompt: event.text ?? "Provider input requested.",
      options: [],
    };
  }
  if (
    event.category === "observation" &&
    event.providerKind === "file-change" &&
    event.path !== undefined
  ) {
    return {
      kind: "file-change",
      path: decodeCodeRelativePath(event.path),
      change: (event.change ?? "modified") as "created" | "modified" | "deleted",
      reconciled: event.reconciliation?.status === "confirmed",
    };
  }
  if (event.category === "observation" && event.providerKind === "diff") {
    return {
      kind: "diff",
      content: evidence.put(event.text ?? " "),
      reconciled: event.reconciliation?.status === "confirmed",
    };
  }
  if (event.category === "usage")
    return {
      kind: "usage",
      inputTokens: event.inputTokens ?? 0,
      outputTokens: event.outputTokens ?? 0,
    };
  if (event.category === "task-progress")
    return {
      kind: "task-progress",
      taskId: event.requestId ?? "provider-task",
      state: event.status === "in-progress" ? "running" : ((event.status ?? "waiting") as never),
      summary: event.text ?? "Provider task progress.",
    };
  if (event.category === "child-activity")
    return {
      kind: "child-activity",
      childId: event.requestId ?? "provider-child",
      state: (event.status ?? "waiting") as never,
      summary: event.text ?? "Provider child activity.",
    };
  if (event.category === "tool")
    return {
      kind: "tool-activity",
      toolCallId: event.toolCallId ?? event.requestId ?? "provider-tool",
      toolName: event.toolName ?? "provider-tool",
      state:
        event.status === "provider-claimed-failure"
          ? "failed"
          : event.status === "completed"
            ? "completed"
            : event.status === "started"
              ? "started"
              : "running",
      ...(event.text === undefined ? {} : { summary: event.text }),
    };
  if (event.category === "completion") return { kind: "operation-state", state: "completed" };
  if (event.category === "waiting") return { kind: "operation-state", state: "waiting" };
  if (event.category === "interruption") return { kind: "operation-state", state: "interrupted" };
  if (event.category === "failure") return { kind: "operation-state", state: "failed" };
  return undefined;
}

function sanitizeProviderEvent(
  event: ProviderRuntimeEvent,
  checkoutRoot: string,
  secrets: readonly string[],
): ProviderRuntimeEvent {
  const sanitize = (value: unknown): unknown => {
    if (typeof value === "string") {
      let sanitized = value.replaceAll(checkoutRoot, "[CHECKOUT]");
      for (const secret of secrets) sanitized = sanitized.replaceAll(secret, "[REDACTED]");
      return sanitized;
    }
    if (Array.isArray(value)) return value.map(sanitize);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitize(child)]));
  };
  if (event.kind === "file-change") {
    if (!isAbsolute(event.path)) return sanitize(event) as ProviderRuntimeEvent;
    const relativePath = relative(checkoutRoot, event.path);
    if (relativePath.startsWith("..") || relativePath === "" || relativePath.includes(`..${sep}`))
      throw new Error("Provider path is outside checkout.");
    return sanitize({ ...event, path: relativePath.split(sep).join("/") }) as ProviderRuntimeEvent;
  }
  return sanitize(event) as ProviderRuntimeEvent;
}

function turnState(state: ActiveTurn["state"]): { state: ActiveTurn["state"] } {
  return { state };
}

function createPullRequestPort(options: CodeOperationRuntimeOptions): CodeOperationPullRequestPort {
  const unavailable: CodeOperationPullRequestPort = {
    ensure: async () => ({ status: "unavailable" as const }),
    observeReview: async () => ({ status: "unavailable" as const }),
    merge: async () => ({ status: "unavailable" as const }),
  };
  if (options.ghExecutable === undefined) return unavailable;
  try {
    return new GhPullRequestPort({
      command: createGhCommandPort({ ghPath: options.ghExecutable }),
      resolveTarget: options.resolvePullRequestTarget,
      ...(options.inheritedEnvironment === undefined
        ? {}
        : { inheritedEnvironment: options.inheritedEnvironment }),
    });
  } catch {
    return unavailable;
  }
}

function codeOperationGitPort(git: GitService): CodeOperationGitPort {
  return {
    observe: async ({ checkoutRoot, maxDiffBytes }) =>
      mapGitObservation(await git.observe(checkoutRoot), maxDiffBytes),
    stage: (input) => git.stage(input),
    discard: (input) => git.discard(input),
    commit: (input) =>
      git.commit({
        ...input,
        stagedSummary: input.stagedSummary.map((entry) => ({
          path: entry.path,
          index: entry.index,
          worktree: entry.worktree,
          ...(entry.originalPath === undefined ? {} : { originalPath: entry.originalPath }),
        })),
      }),
    push: (input) => git.push(input),
    checkpoint: (input) => git.checkpoint(input),
    restoreCheckpoint: (input) => git.restoreCheckpoint(input),
  } as CodeOperationGitPort;
}

function mapGitObservation(
  result: GitObservationResult,
  maxDiffBytes: number,
): Awaited<ReturnType<CodeOperationGitPort["observe"]>> {
  if (result.status !== "ready") return result;
  const diff = Buffer.from(result.diff.text, "utf8").subarray(0, maxDiffBytes).toString("utf8");
  return {
    status: "ready",
    head:
      result.head.branch.kind === "named"
        ? { kind: "branch", name: result.head.branch.name, oid: result.head.oid }
        : { kind: "detached", oid: result.head.oid },
    stateToken: result.stateToken,
    statusEntries: result.statusEntries,
    changedPaths: result.changedPaths,
    diff,
    diffTruncated: result.diff.truncated || diff !== result.diff.text,
    remotes: result.remotes.map((remote) => ({
      name: remote.name,
      fetch: mapRemoteEndpoint(remote.fetchUrl),
      push: mapRemoteEndpoint(remote.pushUrl),
    })),
    upstream: result.upstream,
    worktrees: result.worktrees.flatMap((worktree) => {
      if (worktree.head === null) return [];
      const branch = worktree.branch?.startsWith("refs/heads/")
        ? worktree.branch.slice("refs/heads/".length)
        : undefined;
      return [
        {
          checkoutId: checkoutIdForPath(worktree.path),
          head:
            branch === undefined
              ? { kind: "detached" as const, oid: worktree.head }
              : { kind: "branch" as const, name: branch, oid: worktree.head },
          state: worktree.locked
            ? ("locked" as const)
            : worktree.prunable
              ? ("prunable" as const)
              : worktree.bare
                ? ("unavailable" as const)
                : ("active" as const),
        },
      ];
    }),
  };
}

function mapRemoteEndpoint(value: string) {
  if (isAbsolute(value) || value.startsWith("./") || value.startsWith("../"))
    return { kind: "local" as const };
  const scp = /^(?<authority>[^/:\s]+@[^/:\s]+):(?<path>\S+)$/.exec(value);
  const authority = scp?.groups?.authority;
  const path = scp?.groups?.path;
  if (authority !== undefined && path !== undefined)
    return {
      kind: "network" as const,
      url: `ssh://${authority}/${path.replace(/^\/+/, "")}`,
    };
  try {
    const url = new URL(value);
    if (url.protocol === "ssh:" || url.protocol === "https:")
      return { kind: "network" as const, url: url.toString() };
  } catch {
    // Git accepts relative filesystem remotes as well as URLs.
  }
  return { kind: "local" as const };
}

function checkoutIdForPath(path: string) {
  const digest = createHash("sha256").update("octant-code-checkout\0").update(path).digest("hex");
  return decodeCodeCheckoutId(
    `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
  );
}
