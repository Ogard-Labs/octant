import { createHash } from "node:crypto";
import {
  ActorId,
  AggregateId,
  CorrelationId,
  type CodeAttachmentId,
  type CodeAttachmentMediaType,
  type CodeAttachmentReference,
  EventId,
  UtcTimestamp,
  decodeCodeCommand,
  decodeCodeCheckoutHead,
  decodeCodeCheckoutIdentity,
  decodeCodeWorktreeSourceProvenance,
  decodeCodeEventFrame,
  decodeCodeEvidenceReference,
  decodeCodeFailure,
  decodeCodeFileReference,
  decodeCodeRelativePath,
  decodeCodeSettings,
  decodeCodeFileOpenResultEnvelope,
  decodeCodeFileSaveResultEnvelope,
  decodeCodeThread,
  decodeCodeRepositoryTestListing,
  decodeCodeThreadCreated,
  decodeCodeThreadUpdated,
  type AggregateVersion,
  type BindingRevisionId,
  type CodeBootstrap,
  type CodeNavigation,
  type CodeApprovalEffect,
  type CodeCheckoutId,
  type CodeCheckoutIdentity,
  type CodeCommandResult,
  type CodeThreadCheckoutRebindRefusal,
  type CodeRepositoryId,
  type CodeWorktreeSourcePreview,
  type CodeWorktreeRef,
  type CodeWorktreeRemoteFacts,
  type CodeEvidenceContentId,
  type CodeEvidenceReference,
  type CodeEventFrame,
  type CodeFailure,
  type CodeFileId,
  type CodeFileChangeNotice,
  type CodeSearchResult,
  type CodeSearchScope,
  type CodeFileListingResult,
  type CodeFileOpenResultEnvelope,
  type CodeFileReference,
  type CodeFileSaveResultEnvelope,
  type CodeRelativePath,
  type CodeRepositoryTestListing,
  type CodeSettings,
  type CodeThread,
  type CodeThreadActivity,
  type CodeThreadId,
  type CodeThreadView,
  type Project,
  type EventEnvelope,
  type PermissionPersistence,
  type ProjectId,
  type ProviderExecutionPolicy,
  type ProviderModelId,
  type ProviderProbeResult,
  type WindowId,
  type ThreadWorkingDirectory,
  type GithubIssueContextRequest,
} from "@octant/contracts";
import type {
  AgentProfile,
  AgentProfileId,
  AgentProfileScope,
} from "@octant/contracts/agent-profile";
import {
  applyProfileToThread,
  profileScopeApplies,
  snapshotProfileThreadContext,
  type ProfileThreadContextSnapshot,
} from "@octant/domain/agent-profile-policy";
import { authorizeCodeOperation } from "@octant/domain/code-policy";
import { evaluateCodeDeliveryOutcomeProposal } from "@octant/domain/delivery-target-policy";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict, JournalWriteFailed } from "../persistence/journalErrors";
import { ProjectionApplicationFailed } from "../persistence/projection";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import {
  issueContextFailureCategory,
  prepareOptionalIssueContext,
  type GithubIssueContextResult,
  type GithubIssueContextService,
} from "../github/githubIssueContextService";

type GithubIssueContextPort = Pick<
  GithubIssueContextService,
  "prepare" | "bindCreatedThread" | "takeFramedForFirstTurn"
>;
import {
  CodeContentStore,
  CodeContentStoreError,
  type CodeContentReference,
} from "./codeContentStore";
import {
  CodeAttachmentInvalid,
  CodeAttachmentStore,
  CodeAttachmentTooLarge,
} from "./codeAttachmentStore";
import type { CodeFileService, CodeFileOpenResult, CodeFileSaveResult } from "./codeFileService";
import type { CodeFileWatchService } from "./codeFileWatchService";
import type { CodeSearchService } from "./codeSearchService";
import type { FileIdentity } from "./fileOperationPort";
import {
  approvalContextDigest,
  type CodeApprovalValidationPort,
} from "./codeOperationApprovalStore";
import { CodeSessionAuthorityStore } from "./codeSessionAuthorityStore";

const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const CODE_SETTINGS_AGGREGATE_ID = decodeAggregateId("00000000-0000-4000-8000-000000000020");
const CODE_CHECKOUT_RECOVERY_PROBE_PATH = decodeCodeRelativePath("package.json");

/**
 * Credential-safe, actionable user-facing messages for managed-worktree
 * creation refusals. Raw Git stderr is never surfaced.
 */
const MANAGED_CREATION_REFUSAL_MESSAGES: Record<string, string> = {
  "branch-collision":
    "The delivery branch already exists. Choose a different delivery branch and retry.",
  "path-collision": "A managed worktree already exists for this thread.",
  "ref-ambiguous": "The source ref is ambiguous. Choose an exact source branch and retry.",
  "ref-unavailable": "The source branch does not exist. Choose another source branch and retry.",
  "remote-unavailable":
    "No usable remote is configured for this branch. Choose a local source or add a remote.",
  "fetch-rejected":
    "The remote fetch failed. Check connectivity, credentials, and the remote, then retry.",
  "repository-mismatch": "The bound repository is unavailable or stale.",
  "invalid-intent": "Managed Code worktree creation is invalid.",
  "invalid-grant": "Managed Code worktree creation is invalid.",
};

function stripProposedOutcome(
  deliveryTarget: CodeThread["deliveryTarget"],
): Omit<CodeThread["deliveryTarget"], "proposedOutcome"> {
  const { proposedOutcome: _resolved, ...rest } = deliveryTarget;
  return rest;
}

/**
 * Map the file helper's open answer into the public envelope. Every variant
 * carries the server-resolved file identity and the helper's `too-large`
 * boundary becomes the public `oversized` reason.
 */
function publicOpenResult(fileId: CodeFileId, opened: CodeFileOpenResult) {
  switch (opened.status) {
    case "editable":
      return { status: "editable", fileId, metadata: opened.metadata, content: opened.content };
    case "read-only":
      return {
        status: "read-only",
        fileId,
        metadata: opened.metadata,
        reason: opened.reason === "too-large" ? "oversized" : "binary",
      };
    case "interrupted":
      return { status: "interrupted", fileId, rescanRequired: true };
    case "failed":
      return { status: "failed", fileId, failure: opened.failure };
  }
}

function sameAvailableCheckout(
  current: CodeCheckoutIdentity | undefined,
  observed: CodeCheckoutIdentity,
): boolean {
  if (
    current === undefined ||
    current.availability !== "available" ||
    current.kind !== observed.kind ||
    current.repositoryId !== observed.repositoryId ||
    current.head.kind !== observed.head.kind
  ) {
    return false;
  }
  return current.head.kind === "detached"
    ? current.head.oid === observed.head.oid
    : observed.head.kind === "branch" &&
        current.head.name === observed.head.name &&
        current.head.oid === observed.head.oid;
}

/**
 * True when an observation restates what the journal already recorded for this
 * checkout — every fact equal, only `observedAt` fresher. The journal records
 * changes of state, and observations arrive from paths that repeat freely
 * (bootstrap runs on every navigation refresh and stream reconnect, prepare on
 * every composer open and retry). Journaling each repeat grew one dogfooding
 * host's journal by ~21k identical "unavailable" observations of a single
 * checkout in days, enough to exhaust the bounded conversation replay scan.
 */
function repeatsJournaledCheckout(
  current: CodeCheckoutIdentity | undefined,
  observed: CodeCheckoutIdentity,
): boolean {
  if (
    current === undefined ||
    String(current.id) !== String(observed.id) ||
    current.kind !== observed.kind ||
    current.repositoryId !== observed.repositoryId ||
    current.availability !== observed.availability
  ) {
    return false;
  }
  if (
    current.kind === "managed-worktree" &&
    observed.kind === "managed-worktree" &&
    String(current.ownershipReceiptId) !== String(observed.ownershipReceiptId)
  ) {
    return false;
  }
  return current.head.kind === "detached"
    ? observed.head.kind === "detached" && current.head.oid === observed.head.oid
    : observed.head.kind === "branch" &&
        current.head.name === observed.head.name &&
        current.head.oid === observed.head.oid;
}

function currentCheckoutDigest(
  checkout: CodeCheckoutIdentity | undefined,
  thread: CodeThread,
): string | undefined {
  if (checkout === undefined || checkout.availability !== "available") return undefined;
  return approvalContextDigest({
    projectId: thread.projectId,
    threadId: thread.id,
    checkoutId: checkout.id,
    repositoryId: checkout.repositoryId,
    checkoutHead: checkout.head,
  });
}

/** The broader of two postures, by the authority each one carries. */
function highestPolicy(
  left: ProviderExecutionPolicy,
  right: ProviderExecutionPolicy,
): ProviderExecutionPolicy {
  const rank = { plan: 0, "approval-gated": 1, "auto-accept-edits": 2, "full-access": 3 } as const;
  return rank[left] >= rank[right] ? left : right;
}

type ProfiledThreadAuthority = {
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly permissionPersistence: PermissionPersistence;
  readonly toolConstraints: ReadonlyArray<string>;
  readonly profileDisplayName?: string;
  readonly profileContext?: ProfileThreadContextSnapshot;
};

function profileToolSnapshot(profiled: ProfiledThreadAuthority): {
  readonly toolConstraints?: ReadonlyArray<string>;
  readonly profileDisplayName?: string;
} {
  if (profiled.profileDisplayName === undefined) return {};
  return {
    toolConstraints: profiled.toolConstraints,
    profileDisplayName: profiled.profileDisplayName,
  };
}

function profileContextSnapshot(profiled: ProfiledThreadAuthority): {
  readonly profileContext?: ProfileThreadContextSnapshot;
} {
  if (profiled.profileContext === undefined) return {};
  return { profileContext: profiled.profileContext };
}

export interface CodePersistencePort {
  readonly journal: Pick<Journal, "append" | "replay" | "replayAggregate">;
  readonly readCodeSettings: () => { readonly settings: CodeSettings } | undefined;
  readonly readCodeThread: (threadId: CodeThreadId) => CodeThread | undefined;
  readonly readCodeThreads: () => ReadonlyArray<CodeThread>;
  readonly readCodeThreadActivity: () => ReadonlyArray<CodeThreadActivity>;
  readonly readCodeCheckout: (checkoutId: CodeCheckoutId) => CodeCheckoutIdentity | undefined;
  readonly readCodeCheckoutAggregateVersion: (checkoutId: CodeCheckoutId) => number;
  readonly readCodeCheckouts: () => ReadonlyArray<CodeCheckoutIdentity>;
  readonly readCodeFileReference: (fileId: CodeFileId) => CodeFileReference | undefined;
  readonly readCodeFileReferences: (threadId: CodeThreadId) => ReadonlyArray<CodeFileReference>;
  readonly readCodeThreadView: (threadId: CodeThreadId) => CodeThreadView | undefined;
  readonly readProject?: (projectId: ProjectId) => Project | undefined;
  readonly readAgentProfileBinding?: (
    profileId: AgentProfileId,
  ) => { readonly profile: AgentProfile; readonly scope: AgentProfileScope } | undefined;
}

export interface CodeWindowAccessPort {
  readonly canAccessProject: (
    authenticatedWindowId: WindowId,
    projectId: ProjectId,
  ) => boolean | Promise<boolean>;
}

export interface CodeCheckoutObservationPort {
  readonly observe: (
    authenticatedWindowId: WindowId,
    projectId: ProjectId,
  ) => Promise<{
    readonly bindingRevisionId: BindingRevisionId;
    readonly checkout: CodeCheckoutIdentity;
    readonly worktreeRemoteFacts?: CodeWorktreeRemoteFacts;
  }>;
}

export interface CodeWorktreeSourcePreviewInput {
  readonly authenticatedWindowId: WindowId;
  readonly projectId: ProjectId;
  readonly bindingRevisionId: BindingRevisionId;
  readonly repositoryId: CodeRepositoryId;
  readonly refIntent: string;
  readonly startFromOrigin: boolean;
  readonly remoteName?: string;
}

export interface CodeWorktreeSourcePreviewPort {
  readonly preview: (
    input: CodeWorktreeSourcePreviewInput,
    signal: AbortSignal,
  ) => Promise<CodeWorktreeSourcePreview>;
}

export interface CodeWorktreeRefsPort {
  readonly list: (
    input: { readonly projectId: ProjectId },
    signal: AbortSignal,
  ) => Promise<ReadonlyArray<CodeWorktreeRef>>;
}

export interface ManagedCodeThreadCreationInput {
  readonly authenticatedWindowId: WindowId;
  readonly projectId: ProjectId;
  readonly bindingRevisionId: BindingRevisionId;
  readonly threadId: CodeThreadId;
  readonly branchIntent: string;
  readonly sourceBranch: string;
  readonly startFromOrigin: boolean;
  readonly remoteName?: string;
  /** An exact revision to start from, in place of the tip of `sourceBranch`. */
  readonly sourceRevision?: string;
}

/**
 * The resolved source context for a managed creation, produced before any
 * worktree mutation so every decidable authorization can run first. The
 * checkout head binds the confirmed delivery branch to the exact resolved
 * object ID; the receipt id is only known after commit.
 */
export interface ManagedCodeThreadPreparation {
  readonly repositoryId: CodeRepositoryId;
  readonly checkoutId: CodeCheckoutId;
  readonly branchIntent: string;
  readonly resolvedHead: string;
  readonly mode: "origin" | "local";
  readonly sourceBranch: string;
  readonly remoteName?: string;
  readonly fetchedAt?: string;
}

export type ManagedCodeThreadPrepareOutcome =
  | Readonly<{ status: "prepared"; preparation: ManagedCodeThreadPreparation }>
  | Readonly<{ status: "refused"; reason: string }>
  | Readonly<{ status: "waiting" | "interrupted" }>;

export type ManagedCodeThreadCommitOutcome =
  | Readonly<{ status: "created"; receiptId: string; expectedHead: string }>
  | Readonly<{ status: "refused"; reason: string }>
  | Readonly<{ status: "waiting" | "interrupted" }>;

export type ManagedCodeThreadCleanupOutcome =
  | Readonly<{ status: "removed" }>
  | Readonly<{ status: "waiting" | "interrupted" | "refused" }>;

export interface ManagedCodeThreadCreationPort {
  readonly prepare: (
    input: ManagedCodeThreadCreationInput,
    signal: AbortSignal,
  ) => Promise<ManagedCodeThreadPrepareOutcome>;
  readonly commit: (
    input: ManagedCodeThreadCreationInput,
    preparation: ManagedCodeThreadPreparation,
    signal: AbortSignal,
  ) => Promise<ManagedCodeThreadCommitOutcome>;
  readonly cleanup: (
    input: Readonly<{ receiptId: string }>,
    signal: AbortSignal,
  ) => Promise<ManagedCodeThreadCleanupOutcome>;
}

export interface CodeFileRootResolution {
  readonly fileId: CodeFileId;
  readonly rootPath: string;
  readonly rootIdentity: FileIdentity;
  readonly expectedFileVersion?: number;
}

export interface CodeFileRootAuthorityPort {
  readonly resolve: (
    authenticatedWindowId: WindowId,
    thread: CodeThread,
    checkout: CodeCheckoutIdentity,
    relativePath: CodeRelativePath,
  ) => CodeFileRootResolution | undefined | Promise<CodeFileRootResolution | undefined>;
}

export interface CodeRepositoryTestDiscoveryPort {
  readonly discover: (input: {
    readonly checkoutId: string;
    readonly rootPath: string;
  }) => Promise<ReadonlyArray<CodeRepositoryTestListing["definitions"][number]>>;
}

export interface CodeServiceOptions {
  readonly persistence: CodePersistencePort;
  readonly access: CodeWindowAccessPort;
  readonly checkouts: CodeCheckoutObservationPort;
  readonly roots: CodeFileRootAuthorityPort;
  /**
   * `list` is optional so a host that never wired a listing capability keeps
   * compiling and answers `unavailable` rather than pretending the repository
   * is empty.
   */
  readonly files: Pick<CodeFileService, "open" | "save"> & Partial<Pick<CodeFileService, "list">>;
  /**
   * Discovery of the repository tests a thread's checkout offers. Optional for
   * the same reason as `files.list`: a host that wired no discovery answers an
   * empty list instead of pretending the repository has tests it cannot name.
   */
  readonly tests?: CodeRepositoryTestDiscoveryPort;
  /**
   * Live observation of the bound checkout. Optional for the same reason as
   * `files.list`: a host that wired no watcher ends the stream immediately, so
   * the renderer keeps its manual refresh instead of waiting on notices that
   * will never come.
   */
  readonly watcher?: Pick<CodeFileWatchService, "watch">;
  /**
   * Bounded search of the bound checkout. Optional for the same reason as
   * `files.list`: a host that wired no searcher answers `unavailable` rather
   * than an empty result, which would read as "the repository has no match".
   */
  readonly searcher?: Pick<CodeSearchService, "search">;
  readonly content: CodeContentStore;
  readonly evidence?: {
    readonly put: (
      content: string,
      metadata?: { readonly truncated?: boolean },
    ) => CodeEvidenceReference;
  };
  /**
   * Where a thread's attached images live. Optional: a host that wired no
   * attachment store answers `unavailable` rather than pretending an upload
   * succeeded.
   */
  readonly attachments?: CodeAttachmentStore;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly approvals?: CodeApprovalValidationPort;
  readonly sessionAuthority?: CodeSessionAuthorityStore;
  readonly worktreeSourcePreview?: CodeWorktreeSourcePreviewPort;
  readonly worktreeRefs?: CodeWorktreeRefsPort;
  readonly managedThreadCreation?: ManagedCodeThreadCreationPort;
  readonly probeProvider?: (
    providerInstanceId: CodeThread["providerInstanceId"],
  ) => Promise<ProviderProbeResult>;
  readonly workingDirectories: {
    readonly resolve: (
      authenticatedWindowId: WindowId,
      thread: CodeThread,
      checkout: CodeCheckoutIdentity,
      workingDirectory: ThreadWorkingDirectory,
    ) => Promise<string | undefined>;
  };
  readonly onWorkingDirectoryChanged: (scope: {
    readonly mode: "code";
    readonly projectId: ProjectId;
    readonly threadId: CodeThreadId;
  }) => Promise<void>;
  readonly issueContext?: GithubIssueContextPort;
}

/**
 * Path handed to the file root authority when a listing starts at the checkout
 * root. The authority derives a per-file id from it and otherwise ignores it;
 * listing never opens this file, it only needs the authority's root decision.
 */
const CODE_LISTING_ROOT_PROBE_PATH = decodeCodeRelativePath("package.json");

/**
 * The slice of the shared content store that opened-file staging may hold.
 *
 * Browsing stages bytes the editor reads once, while saving stages bytes the
 * checkout is about to receive. Both use the same store, so the browsing cache
 * is bounded well inside the store's own limits: at most this many opened
 * references and this many bytes stay staged, and one incoming open of at most
 * `MAX_EDITABLE_CODE_FILE_BYTES` is the only overshoot. The remainder of the
 * store's default 128 entries and 32 MiB therefore stays available to saves no
 * matter how many files a window opens.
 */
export const MAXIMUM_OPENED_CODE_FILE_ENTRIES = 16;
export const MAXIMUM_OPENED_CODE_FILE_BYTES = 8 * 1024 * 1024;

export interface CodeListFilesInput {
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  /** Subdirectory relative to the checkout root. Absent lists the root. */
  readonly directory?: CodeRelativePath | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** One thread with its pin removed, so unpinning erases the field entirely. */
function withoutPinned(thread: CodeThread): Omit<CodeThread, "pinned"> {
  const { pinned: _pinned, ...rest } = thread;
  return rest;
}

export interface CodeSearchFilesInput {
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly scope: CodeSearchScope;
  readonly query: string;
  readonly signal?: AbortSignal | undefined;
}

export interface CodeWatchFilesInput {
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly signal?: AbortSignal | undefined;
}

export interface CodeListTestsInput {
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
}

export interface CodeOpenFileInput {
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly relativePath: CodeRelativePath;
  readonly signal?: AbortSignal | undefined;
}

export interface CodeSaveFileInput {
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly relativePath: CodeRelativePath;
  readonly expectedIdentity: FileIdentity;
  readonly expectedDigest: string;
  readonly text: string;
}

export class CodeServiceError extends Error {
  override readonly name = "CodeServiceError";

  constructor(readonly failure: CodeFailure) {
    super(failure.message);
  }
}

export class CodeService {
  readonly #persistence: CodePersistencePort;
  readonly #access: CodeWindowAccessPort;
  readonly #checkouts: CodeCheckoutObservationPort;
  readonly #roots: CodeFileRootAuthorityPort;
  readonly #files: Pick<CodeFileService, "open" | "save"> & Partial<Pick<CodeFileService, "list">>;
  readonly #tests: CodeRepositoryTestDiscoveryPort | undefined;
  readonly #watcher: Pick<CodeFileWatchService, "watch"> | undefined;
  /**
   * Open file watches, by the window that opened them. A watch is the one Code
   * read that outlives the request that authorized it, so revoking a window has
   * to reach the streams it left running rather than only the next reconnect.
   */
  readonly #openWatches = new Map<string, Set<AbortController>>();
  readonly #searcher: Pick<CodeSearchService, "search"> | undefined;
  readonly #content: CodeContentStore;
  readonly #evidence: CodeServiceOptions["evidence"];
  readonly #attachments: CodeServiceOptions["attachments"];
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #approvals: CodeApprovalValidationPort | undefined;
  readonly #sessionAuthority: CodeSessionAuthorityStore;
  readonly #worktreeSourcePreview: CodeWorktreeSourcePreviewPort | undefined;
  readonly #worktreeRefs: CodeWorktreeRefsPort | undefined;
  readonly #managedThreadCreation: ManagedCodeThreadCreationPort | undefined;
  readonly #probeProvider: CodeServiceOptions["probeProvider"];
  readonly #workingDirectories: CodeServiceOptions["workingDirectories"];
  readonly #onWorkingDirectoryChanged: CodeServiceOptions["onWorkingDirectoryChanged"];
  readonly #issueContext?: GithubIssueContextPort;
  /**
   * Content staged by `openFile` for the editor, keyed by the staged content
   * id in least-recently-opened order. The reference, not the file, is the
   * unit: an editor holds the reference it was opened with and fetches the
   * bytes separately, so every open keeps its own record and two opens of one
   * file hold two. Process-local like the content store itself: opened bytes
   * are a rebuildable read, never journal state, and `readContent` authorizes
   * them through the owning thread's Project exactly like persisted
   * references.
   */
  readonly #openedFiles = new Map<
    string,
    { readonly threadId: CodeThreadId; readonly content: CodeContentReference }
  >();
  #openedFileBytes = 0;

  constructor(options: CodeServiceOptions) {
    this.#persistence = options.persistence;
    this.#access = options.access;
    this.#checkouts = options.checkouts;
    this.#roots = options.roots;
    this.#files = options.files;
    this.#tests = options.tests;
    this.#watcher = options.watcher;
    this.#searcher = options.searcher;
    this.#content = options.content;
    this.#evidence = options.evidence;
    this.#attachments = options.attachments;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#approvals = options.approvals;
    this.#sessionAuthority = options.sessionAuthority ?? new CodeSessionAuthorityStore();
    this.#worktreeSourcePreview = options.worktreeSourcePreview;
    this.#worktreeRefs = options.worktreeRefs;
    this.#managedThreadCreation = options.managedThreadCreation;
    this.#probeProvider = options.probeProvider;
    this.#workingDirectories = options.workingDirectories;
    this.#onWorkingDirectoryChanged = options.onWorkingDirectoryChanged;
    if (options.issueContext !== undefined) {
      this.#issueContext = options.issueContext;
    }
  }

  async navigation(authenticatedWindowId: WindowId): Promise<CodeNavigation> {
    const threads = await this.#visibleThreads(authenticatedWindowId);
    return { threads, activity: this.#visibleActivity(threads) };
  }

  async bootstrap(authenticatedWindowId: WindowId): Promise<CodeBootstrap> {
    const threads = await this.#visibleThreads(authenticatedWindowId);
    const recoveredCheckouts = new Map<string, CodeCheckoutIdentity>();
    const observedExistingCheckouts = new Map<string, CodeCheckoutIdentity | undefined>();
    const attemptedManagedCheckoutIds = new Set<string>();
    for (const thread of threads) {
      const persisted = this.#persistence.readCodeCheckout(thread.checkoutId);
      if (persisted === undefined) continue;
      if (persisted.kind === "managed-worktree") {
        const checkoutId = String(persisted.id);
        if (attemptedManagedCheckoutIds.has(checkoutId)) continue;
        attemptedManagedCheckoutIds.add(checkoutId);
      }
      // Available and unavailable checkouts already have a recorded answer.
      // Re-probing them on every bootstrap — including the 2s sidebar refresh
      // that used to call this — walks the filesystem while the person is
      // switching threads. Waiting is the only state whose next fact is still
      // on disk.
      if (persisted.availability !== "waiting") {
        recoveredCheckouts.set(String(persisted.id), persisted);
        continue;
      }
      try {
        let recovered: CodeCheckoutIdentity | undefined;
        if (persisted.kind === "managed-worktree") {
          recovered =
            (await this.#roots.resolve(
              authenticatedWindowId,
              thread,
              persisted,
              CODE_CHECKOUT_RECOVERY_PROBE_PATH,
            )) === undefined
              ? undefined
              : decodeCodeCheckoutIdentity({
                  ...persisted,
                  availability: "available",
                  observedAt: this.#clock(),
                });
        } else {
          const projectId = String(thread.projectId);
          if (!observedExistingCheckouts.has(projectId)) {
            observedExistingCheckouts.set(projectId, undefined);
            const prepared = await this.#checkouts.observe(authenticatedWindowId, thread.projectId);
            observedExistingCheckouts.set(projectId, prepared.checkout);
          }
          const observed = observedExistingCheckouts.get(projectId);
          if (observed !== undefined && String(observed.id) !== String(thread.checkoutId)) {
            // The Project binds a checkout this thread is not on. That id is
            // derived from the binding revision the thread was created
            // against, so once the Project is rebound no observation can
            // produce the thread's own id again and Waiting will never end.
            // Say Unavailable, which already tells the reader to relink the
            // Project or start a fresh thread, rather than render a spinner
            // for a reconnection nobody is attempting.
            recovered = decodeCodeCheckoutIdentity({
              ...persisted,
              availability: "unavailable",
              observedAt: this.#clock(),
            });
          } else {
            recovered = observed;
          }
        }
        if (recovered === undefined) continue;
        if (!repeatsJournaledCheckout(persisted, recovered)) {
          this.#append(
            "code-checkout",
            recovered.id,
            this.#persistence.readCodeCheckoutAggregateVersion(recovered.id),
            "code.checkout-observed@1",
            { kind: "checkout-observed", checkout: recovered },
          );
        }
        recoveredCheckouts.set(String(recovered.id), recovered);
      } catch {
        // Restart recovery remains fail-closed at the persisted Waiting checkout.
      }
    }
    const checkoutIds = new Set(threads.map(({ checkoutId }) => String(checkoutId)));
    // D2: Orphan checkout recovery. If a managed thread creation failed after
    // journaling checkout-observed but the compensating checkout-removed append
    // also failed, the projection retains an available checkout with no
    // corresponding thread. On restart, detect these orphans and append
    // checkout-removed events so replay/projections stay clean.
    //
    // CRITICAL: The linkage set must be derived from ALL persisted threads, not
    // the authorization-filtered subset. A window lacking access to another
    // Project must never classify that Project's valid checkout as an orphan
    // and append a global checkout-removed event. Only managed-worktree
    // checkouts with ownership/receipt facts can be orphans from failed managed
    // binding; existing-worktree checkouts are ordinary observations from
    // prepare-code-project-checkout and must survive recovery.
    const allThreadCheckoutIds = new Set(
      this.#persistence.readCodeThreads().map(({ checkoutId }) => String(checkoutId)),
    );
    const allCheckouts = this.#persistence.readCodeCheckouts();
    for (const checkout of allCheckouts) {
      if (checkout.availability !== "available") continue;
      if (checkout.kind !== "managed-worktree") continue;
      if (allThreadCheckoutIds.has(String(checkout.id))) continue;
      // This is a managed-worktree checkout that is available in the projection
      // but has no corresponding thread across ALL persisted threads — it is an
      // orphan from a failed managed thread binding whose compensation append
      // also failed. Append a checkout-removed event to compensate it.
      try {
        this.#append(
          "code-checkout",
          checkout.id,
          this.#persistence.readCodeCheckoutAggregateVersion(checkout.id),
          "code.checkout-removed@1",
          { kind: "checkout-removed", checkoutId: checkout.id },
        );
      } catch {
        // If the recovery append fails (e.g. concurrency), the orphan remains
        // but is filtered out of the bootstrap response below. The next
        // restart will retry the compensation.
      }
    }
    return {
      settings: this.#persistence.readCodeSettings()?.settings ?? this.#defaultSettings(),
      threads,
      checkouts: this.#persistence
        .readCodeCheckouts()
        .filter((checkout) => checkoutIds.has(String(checkout.id)))
        .map((checkout) => recoveredCheckouts.get(String(checkout.id)) ?? checkout),
      activity: this.#visibleActivity(threads),
    };
  }

  async #visibleThreads(authenticatedWindowId: WindowId): Promise<CodeThread[]> {
    const threads: CodeThread[] = [];
    for (const thread of this.#persistence.readCodeThreads()) {
      if (await this.#access.canAccessProject(authenticatedWindowId, thread.projectId)) {
        threads.push(this.#sessionAuthority.effectiveThread(authenticatedWindowId, thread));
      }
    }
    return threads;
  }

  #visibleActivity(threads: ReadonlyArray<CodeThread>): ReadonlyArray<CodeThreadActivity> {
    // Filtered by the same authorization the thread list went through: a
    // window that cannot see a thread must not learn that it is running from
    // its activity sequence either.
    const threadIds = new Set(threads.map((thread) => String(thread.id)));
    return this.#persistence
      .readCodeThreadActivity()
      .filter((entry) => threadIds.has(String(entry.threadId)));
  }

  async read(authenticatedWindowId: WindowId, threadId: CodeThreadId): Promise<CodeThreadView> {
    const thread = this.#persistence.readCodeThread(threadId);
    if (thread === undefined) throw this.#failure("invalid", "Code thread was not found.");
    await this.#authorizeThread(authenticatedWindowId, thread);
    const view = this.#persistence.readCodeThreadView(threadId);
    if (view === undefined) throw this.#failure("unavailable", "Code thread is unavailable.");
    return {
      ...view,
      thread: this.#sessionAuthority.effectiveThread(authenticatedWindowId, view.thread),
    };
  }

  async execute(
    authenticatedWindowId: WindowId,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<CodeCommandResult> {
    try {
      let command;
      try {
        command = decodeCodeCommand(input);
      } catch {
        throw this.#failure("invalid", "Code command is invalid.");
      }
      if (command.kind === "preview-code-worktree-source") {
        if (this.#worktreeSourcePreview === undefined) {
          throw this.#failure(
            "unavailable",
            "Managed Code worktree source preview is unavailable.",
          );
        }
        if (!(await this.#access.canAccessProject(authenticatedWindowId, command.projectId))) {
          throw this.#failure("unauthorized", "Code worktree source preview is unauthorized.");
        }
        const preview = await this.#worktreeSourcePreview.preview(
          {
            authenticatedWindowId,
            projectId: command.projectId,
            bindingRevisionId: command.bindingRevisionId,
            repositoryId: command.repositoryId,
            refIntent: command.refIntent,
            startFromOrigin: command.startFromOrigin,
            ...(command.remoteName === undefined ? {} : { remoteName: command.remoteName }),
          },
          signal ?? new AbortController().signal,
        );
        return { kind: "worktree-source-previewed", preview };
      }
      if (command.kind === "create-managed-code-thread") {
        if (this.#managedThreadCreation === undefined) {
          throw this.#failure("unavailable", "Managed Code worktree creation is unavailable.");
        }
        if (!(await this.#access.canAccessProject(authenticatedWindowId, command.projectId))) {
          throw this.#failure("unauthorized", "Managed Code thread creation is unauthorized.");
        }
        if (this.#persistence.readCodeThread(command.threadId) !== undefined) {
          throw this.#failure("conflict", "Code thread already exists.");
        }
        const preparedIssue = await this.#requireIssueContext(command.issueContext);
        // The profile narrows the posture before any gate reads it, so a
        // profile that pulls the thread below Full access also removes the
        // confirmation Full access would have demanded.
        const managedAuthority = this.#profiledAuthority({
          profileId: command.profileId,
          projectId: command.projectId,
          threadId: command.threadId,
          modelId: command.modelId,
          requestedExecutionPolicy: command.executionPolicy,
          requestedPermissionPersistence: command.permissionPersistence,
        });
        // Authorization that is decidable before any mutation runs first.
        const project = this.#persistence.readProject?.(command.projectId);
        if (
          managedAuthority.executionPolicy === "full-access" &&
          managedAuthority.permissionPersistence === "project-default" &&
          (project?.type !== "code" || project.codeAccessPersistence !== "project-default")
        ) {
          throw this.#failure(
            "unauthorized",
            "Project-default Full access must be enabled for this Code Project first.",
          );
        }
        const creationInput = {
          authenticatedWindowId,
          projectId: command.projectId,
          bindingRevisionId: command.bindingRevisionId,
          threadId: command.threadId,
          branchIntent: command.deliveryTarget.branchIntent,
          sourceBranch: command.sourceBranch,
          startFromOrigin: command.startFromOrigin,
          ...(command.remoteName === undefined ? {} : { remoteName: command.remoteName }),
          ...(command.sourceRevision === undefined
            ? {}
            : { sourceRevision: command.sourceRevision }),
        };
        const creationSignal = signal ?? new AbortController().signal;
        // Prepare resolves the exact source without mutating the user's checkout.
        const prepared = await this.#managedThreadCreation.prepare(creationInput, creationSignal);
        if (prepared.status !== "prepared") {
          throw this.#managedCreationFailure(prepared);
        }
        const preparation = prepared.preparation;
        const checkoutHead = decodeCodeCheckoutHead({
          kind: "branch",
          name: preparation.branchIntent,
          oid: preparation.resolvedHead,
        });
        const timestamp = decodeTimestamp(this.#clock());
        const thread = decodeCodeThread({
          id: command.threadId,
          projectId: command.projectId,
          bindingRevisionId: command.bindingRevisionId,
          repositoryId: preparation.repositoryId,
          checkoutId: preparation.checkoutId,
          title: command.title,
          lifecycle: "active",
          providerInstanceId: command.providerInstanceId,
          modelId: command.modelId,
          executionPolicy: managedAuthority.executionPolicy,
          permissionPersistence: managedAuthority.permissionPersistence,
          deliveryTarget: command.deliveryTarget,
          ...(command.forkedFrom === undefined ? {} : { forkedFrom: command.forkedFrom }),
          ...(command.profileId === undefined ? {} : { profileId: command.profileId }),
          ...profileToolSnapshot(managedAuthority),
          ...profileContextSnapshot(managedAuthority),
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        // Native Full-access approval is validated before mutation, bound to the
        // resolved checkout context.
        //
        // The confirmation was asked for the thread as requested, and the store
        // matches the effect exactly. A profile only narrows, so validating the
        // requested thread checks the very effect the person saw and consented
        // to; hashing the narrowed one would refuse a confirmation that was
        // granted for strictly more than the thread ends up with.
        const approvedThread =
          managedAuthority.permissionPersistence === command.permissionPersistence
            ? thread
            : decodeCodeThread({
                ...thread,
                permissionPersistence: command.permissionPersistence,
              });
        if (
          thread.executionPolicy === "full-access" &&
          !(await this.#approvals?.validate({
            windowId: authenticatedWindowId,
            effect: {
              kind: "create-thread-full-access",
              thread: approvedThread,
            } as CodeApprovalEffect,
            contextDigest: approvalContextDigest({
              projectId: command.projectId,
              threadId: thread.id,
              checkoutId: preparation.checkoutId,
              repositoryId: preparation.repositoryId,
              checkoutHead,
            }),
            ...(command.approvalId === undefined ? {} : { approvalId: command.approvalId }),
          }))
        ) {
          throw this.#failure("unauthorized", "Full access requires native confirmation.");
        }
        // Commit creates the worktree (the only mutation) and confirms the HEAD.
        const committed = await this.#managedThreadCreation.commit(
          creationInput,
          preparation,
          creationSignal,
        );
        if (committed.status !== "created") {
          throw this.#managedCreationFailure(committed);
        }
        // The created HEAD must match the approved/resolved object ID; otherwise
        // the remote moved beneath us and we compensate rather than diverge.
        if (committed.expectedHead !== preparation.resolvedHead) {
          await this.#managedThreadCreation.cleanup(
            { receiptId: committed.receiptId },
            new AbortController().signal,
          );
          throw this.#failure(
            "conflict",
            "The remote moved during creation; retry to start from the updated tip.",
          );
        }
        // Cancellation after creation compensates with a fresh context.
        if (creationSignal.aborted) {
          await this.#managedThreadCreation.cleanup(
            { receiptId: committed.receiptId },
            new AbortController().signal,
          );
          throw this.#failure("interrupted", "Managed Code worktree creation was cancelled.");
        }
        const checkout = decodeCodeCheckoutIdentity({
          id: preparation.checkoutId,
          repositoryId: preparation.repositoryId,
          kind: "managed-worktree",
          availability: "available",
          head: checkoutHead,
          ownershipReceiptId: committed.receiptId,
          observedAt: decodeTimestamp(this.#clock()),
        });
        const provenance = decodeCodeWorktreeSourceProvenance({
          receiptId: committed.receiptId,
          mode: preparation.mode,
          branch: preparation.sourceBranch,
          resolvedHead: preparation.resolvedHead,
          ...(preparation.remoteName === undefined ? {} : { remoteName: preparation.remoteName }),
          ...(preparation.fetchedAt === undefined ? {} : { fetchedAt: preparation.fetchedAt }),
        });
        const durableThread =
          thread.executionPolicy === "full-access" &&
          thread.permissionPersistence === "current-session"
            ? decodeCodeThread({ ...thread, executionPolicy: "approval-gated" })
            : thread;
        // Journal the binding: if the thread append fails after the checkout
        // append succeeds, append a compensating checkout-removed so replay
        // never exposes an orphan available checkout, then roll back the
        // worktree. If the compensation append also fails, the orphan
        // checkout-observed event remains in the journal and must be recovered
        // on restart; we report "waiting" (not "interrupted") so the caller
        // knows recovery is pending. A ready worktree is never orphaned silently.
        let checkoutJournaled = false;
        let compensationFailed = false;
        try {
          this.#append(
            "code-checkout",
            checkout.id,
            this.#persistence.readCodeCheckoutAggregateVersion(checkout.id),
            "code.checkout-observed@1",
            { kind: "checkout-observed", checkout },
          );
          checkoutJournaled = true;
          this.#append("code-thread", thread.id, 0, "code.thread-created@1", {
            kind: "thread-created",
            thread: durableThread,
          });
        } catch {
          if (checkoutJournaled) {
            // Compensate the orphan checkout so replay/projections stay clean.
            try {
              this.#append(
                "code-checkout",
                checkout.id,
                this.#persistence.readCodeCheckoutAggregateVersion(checkout.id),
                "code.checkout-removed@1",
                { kind: "checkout-removed", checkoutId: checkout.id },
              );
            } catch {
              // D2: compensation append failed; the orphan checkout-observed
              // event remains in the journal. We must not swallow this — the
              // restart recovery path will detect and compensate the orphan.
              compensationFailed = true;
            }
          }
          const rollback = await this.#managedThreadCreation.cleanup(
            { receiptId: committed.receiptId },
            new AbortController().signal,
          );
          if (rollback.status !== "removed") {
            throw this.#failure(
              "waiting",
              "Managed Code worktree was created but could not be bound; it is pending recovery.",
            );
          }
          if (compensationFailed) {
            // D2: the worktree was rolled back but the durable checkout-observed
            // event is orphaned. Report "waiting" so the caller knows recovery
            // is pending; the restart recovery path will compensate the orphan.
            throw this.#failure(
              "waiting",
              "Managed Code worktree was rolled back but the checkout journal entry is pending recovery.",
            );
          }
          throw this.#failure(
            "interrupted",
            "Managed Code worktree creation was rolled back after a binding failure.",
          );
        }
        if (
          thread.executionPolicy === "full-access" &&
          thread.permissionPersistence === "current-session"
        ) {
          this.#sessionAuthority.grantFullAccess(authenticatedWindowId, thread.id);
        }
        this.#bindIssueContext(String(thread.id), preparedIssue, command.issueContext);
        return {
          kind: "managed-thread-created",
          thread,
          checkout,
          provenance,
        };
      }
      if (command.kind === "prepare-code-project-checkout") {
        if (!(await this.#access.canAccessProject(authenticatedWindowId, command.projectId))) {
          throw this.#failure("unauthorized", "Code Project checkout is unauthorized.");
        }
        let prepared;
        try {
          prepared = await this.#checkouts.observe(authenticatedWindowId, command.projectId);
        } catch {
          throw this.#failure("unavailable", "The bound Code repository is unavailable.");
        }
        if (
          !repeatsJournaledCheckout(
            this.#persistence.readCodeCheckout(prepared.checkout.id),
            prepared.checkout,
          )
        ) {
          this.#append(
            "code-checkout",
            prepared.checkout.id,
            this.#persistence.readCodeCheckoutAggregateVersion(prepared.checkout.id),
            "code.checkout-observed@1",
            { kind: "checkout-observed", checkout: prepared.checkout },
          );
        }
        return {
          kind: "checkout-prepared",
          bindingRevisionId: prepared.bindingRevisionId,
          checkout: prepared.checkout,
        };
      }
      if (command.kind === "get-worktree-remote-facts") {
        // D3: server-authoritative remote facts. The composer uses these to
        // decide whether "Start from origin" is available and which remote to
        // default to. Fail closed with empty remotes when the repository is
        // unavailable or has no remotes, so the feature is never fabricated.
        if (!(await this.#access.canAccessProject(authenticatedWindowId, command.projectId))) {
          throw this.#failure("unauthorized", "Code Project remote facts are unauthorized.");
        }
        let prepared;
        try {
          prepared = await this.#checkouts.observe(authenticatedWindowId, command.projectId);
        } catch {
          // Fail closed with no remotes so Start from origin is disabled.
          return {
            kind: "worktree-remote-facts-retrieved",
            projectId: command.projectId,
            facts: { remotes: [] },
          };
        }
        return {
          kind: "worktree-remote-facts-retrieved",
          projectId: command.projectId,
          facts: prepared.worktreeRemoteFacts ?? { remotes: [] },
        };
      }
      if (command.kind === "list-code-worktree-refs") {
        // Server-authoritative ref catalog for the composer's branch selector.
        // Fails closed with an empty list when the repository is unavailable.
        if (!(await this.#access.canAccessProject(authenticatedWindowId, command.projectId))) {
          throw this.#failure("unauthorized", "Code Project refs are unauthorized.");
        }
        if (this.#worktreeRefs === undefined) {
          return { kind: "worktree-refs-listed", projectId: command.projectId, refs: [] };
        }
        let refs: ReadonlyArray<CodeWorktreeRef>;
        try {
          refs = await this.#worktreeRefs.list(
            { projectId: command.projectId },
            signal ?? new AbortController().signal,
          );
        } catch {
          refs = [];
        }
        return { kind: "worktree-refs-listed", projectId: command.projectId, refs };
      }
      if (command.kind === "update-code-settings") {
        const current = this.#persistence.readCodeSettings()?.settings ?? this.#defaultSettings();
        if (current.version !== command.expectedVersion) {
          throw this.#failure("stale", "Code settings changed; reload and retry.");
        }
        const settings = decodeCodeSettings({
          defaultExecutionPolicy: command.defaultExecutionPolicy,
          defaultPermissionPersistence: command.defaultPermissionPersistence,
          ...(command.externalEditor === undefined
            ? {}
            : { externalEditor: command.externalEditor }),
          version: command.expectedVersion + 1,
          updatedAt: decodeTimestamp(this.#clock()),
        });
        this.#append(
          "code-settings",
          CODE_SETTINGS_AGGREGATE_ID,
          command.expectedVersion,
          "code.settings-updated@1",
          { kind: "settings-updated", settings },
        );
        return { kind: "settings-updated", settings };
      }
      if (command.kind === "create-code-thread") {
        await this.#authorizeThread(authenticatedWindowId, command.thread);
        if (this.#persistence.readCodeThread(command.thread.id) !== undefined) {
          throw this.#failure("conflict", "Code thread already exists.");
        }
        const preparedIssue = await this.#requireIssueContext(command.issueContext);
        let prepared;
        try {
          prepared = await this.#checkouts.observe(authenticatedWindowId, command.thread.projectId);
        } catch {
          throw this.#failure("unavailable", "The bound Code repository is unavailable.");
        }
        const checkout = this.#persistence.readCodeCheckout(command.thread.checkoutId);
        if (
          checkout === undefined ||
          checkout.repositoryId !== command.thread.repositoryId ||
          checkout.availability !== "available" ||
          command.thread.version !== 1 ||
          prepared.bindingRevisionId !== command.thread.bindingRevisionId ||
          prepared.checkout.id !== command.thread.checkoutId ||
          !sameAvailableCheckout(checkout, prepared.checkout)
        ) {
          throw this.#failure("stale", "Code thread checkout changed; prepare it again.");
        }
        // The profile narrows the posture before any gate reads it; every check
        // below, and the thread that is journaled, sees the narrowed value.
        const profiled = this.#profiledAuthority({
          profileId: command.thread.profileId,
          projectId: command.thread.projectId,
          threadId: command.thread.id,
          modelId: command.thread.modelId,
          requestedExecutionPolicy: command.thread.executionPolicy,
          requestedPermissionPersistence: command.thread.permissionPersistence,
        });
        const thread = this.#threadWithProfiledAuthority(command.thread, profiled);
        const project = this.#persistence.readProject?.(thread.projectId);
        if (
          thread.executionPolicy === "full-access" &&
          thread.permissionPersistence === "project-default" &&
          (project?.type !== "code" || project.codeAccessPersistence !== "project-default")
        ) {
          throw this.#failure(
            "unauthorized",
            "Project-default Full access must be enabled for this Code Project first.",
          );
        }
        if (
          thread.executionPolicy === "full-access" &&
          checkout !== undefined &&
          !(await this.#approvals?.validate({
            windowId: authenticatedWindowId,
            // As in managed creation: the confirmation was granted for the
            // thread as requested, and a profile only narrows what it does.
            effect: {
              kind: "create-thread-full-access",
              thread: command.thread,
            } as CodeApprovalEffect,
            contextDigest: approvalContextDigest({
              projectId: command.thread.projectId,
              threadId: command.thread.id,
              checkoutId: checkout.id,
              repositoryId: checkout.repositoryId,
              checkoutHead: checkout.head,
            }),
            ...(command.approvalId === undefined ? {} : { approvalId: command.approvalId }),
          }))
        ) {
          throw this.#failure("unauthorized", "Full access requires native confirmation.");
        }
        const durableThread =
          thread.executionPolicy === "full-access" &&
          thread.permissionPersistence === "current-session"
            ? decodeCodeThread({ ...thread, executionPolicy: "approval-gated" })
            : thread;
        this.#append("code-thread", thread.id, 0, "code.thread-created@1", {
          kind: "thread-created",
          thread: durableThread,
        });
        if (
          thread.executionPolicy === "full-access" &&
          thread.permissionPersistence === "current-session"
        ) {
          this.#sessionAuthority.grantFullAccess(authenticatedWindowId, thread.id);
        }
        this.#bindIssueContext(String(thread.id), preparedIssue, command.issueContext);
        return { kind: "thread-created", thread };
      }

      const current = this.#persistence.readCodeThread(command.threadId);
      if (current === undefined) throw this.#failure("invalid", "Code thread was not found.");
      await this.#authorizeThread(authenticatedWindowId, current);
      if (current.version !== command.expectedVersion) {
        throw this.#failure("stale", "Code state changed; reload and retry.");
      }
      const effectiveCurrent = this.#sessionAuthority.effectiveThread(
        authenticatedWindowId,
        current,
      );
      const updatedAt = decodeTimestamp(this.#clock());
      if (command.kind === "rebind-code-thread-checkout") {
        // Recovery from a superseded checkout. The thread's id was derived from
        // the binding revision it was created against, so once the Project is
        // rebound the recovery loop can only ever call it unavailable. This is
        // the way back out, and 0032 requires one to exist: explicit, journaled,
        // and never inferred from a filesystem root that happens to match.
        const bound = this.#persistence.readCodeCheckout(current.checkoutId);
        if (bound?.kind === "managed-worktree") {
          return this.#rebindRefused(current.id, "managed-worktree");
        }
        let prepared;
        try {
          prepared = await this.#checkouts.observe(authenticatedWindowId, current.projectId);
        } catch {
          return this.#rebindRefused(current.id, "checkout-unavailable");
        }
        if (prepared.checkout.availability !== "available") {
          return this.#rebindRefused(current.id, "checkout-unavailable");
        }
        if (String(prepared.checkout.id) === String(current.checkoutId)) {
          return this.#rebindRefused(current.id, "already-bound");
        }
        if (
          !repeatsJournaledCheckout(
            this.#persistence.readCodeCheckout(prepared.checkout.id),
            prepared.checkout,
          )
        ) {
          this.#append(
            "code-checkout",
            prepared.checkout.id,
            this.#persistence.readCodeCheckoutAggregateVersion(prepared.checkout.id),
            "code.checkout-observed@1",
            { kind: "checkout-observed", checkout: prepared.checkout },
          );
        }
        const rebound = decodeCodeThread({
          ...current,
          bindingRevisionId: prepared.bindingRevisionId,
          repositoryId: prepared.checkout.repositoryId,
          checkoutId: prepared.checkout.id,
          version: command.expectedVersion + 1,
          updatedAt,
        });
        this.#append("code-thread", current.id, command.expectedVersion, "code.thread-updated@1", {
          kind: "thread-updated",
          thread: rebound,
        });
        // 0032: recovery discards, never revalidates. A session grant of Full
        // access was minted against the checkout the thread just left, so it
        // does not carry onto the new one; the thread returns to its persisted
        // posture and the user re-grants if they still want it. Discard the
        // grant in every window that holds it, not only the acting window —
        // recovery invalidates every capability minted under the old checkout.
        this.#sessionAuthority.revokeThreadEverywhere(current.id);
        return {
          kind: "thread-checkout-rebind",
          threadId: current.id,
          outcome: {
            status: "rebound",
            thread: this.#sessionAuthority.effectiveThread(authenticatedWindowId, rebound),
            checkout: prepared.checkout,
          },
        };
      }
      const currentContextDigest = currentCheckoutDigest(
        this.#persistence.readCodeCheckout(current.checkoutId),
        current,
      );
      const project = this.#persistence.readProject?.(current.projectId);
      if (command.kind === "change-code-thread-working-directory") {
        const checkout = this.#persistence.readCodeCheckout(current.checkoutId);
        if (
          checkout === undefined ||
          checkout.availability !== "available" ||
          checkout.repositoryId !== current.repositoryId
        ) {
          throw this.#failure("unavailable", "Code thread checkout is unavailable.");
        }
        let resolved: string | undefined;
        try {
          resolved = await this.#workingDirectories.resolve(
            authenticatedWindowId,
            current,
            checkout,
            command.workingDirectory,
          );
        } catch {
          resolved = undefined;
        }
        if (resolved === undefined) {
          throw this.#failure("invalid", "Code working directory is unavailable.");
        }
      }
      if (
        command.kind === "change-code-thread-access" &&
        command.executionPolicy === "full-access" &&
        command.permissionPersistence === "project-default" &&
        (project?.type !== "code" || project.codeAccessPersistence !== "project-default")
      ) {
        throw this.#failure(
          "unauthorized",
          "Project-default Full access must be enabled for this Code Project first.",
        );
      }
      if (
        command.kind === "change-code-thread-access" &&
        command.executionPolicy === "full-access" &&
        (effectiveCurrent.executionPolicy !== "full-access" ||
          effectiveCurrent.permissionPersistence !== "project-default") &&
        (currentContextDigest === undefined ||
          !(await this.#approvals?.validate({
            windowId: authenticatedWindowId,
            effect: {
              kind: "change-thread-full-access",
              threadId: command.threadId,
              expectedVersion: command.expectedVersion,
              permissionPersistence: command.permissionPersistence,
            } as CodeApprovalEffect,
            contextDigest: currentContextDigest,
            ...(command.approvalId === undefined ? {} : { approvalId: command.approvalId }),
          })))
      ) {
        throw this.#failure("unauthorized", "Full access requires native confirmation.");
      }
      if (command.kind === "change-code-thread-provider") {
        await this.#requireProviderModel(command.providerInstanceId, command.modelId);
      }
      if (command.kind === "propose-code-delivery-outcome") {
        // An agent proposal is advisory: it records a pending proposal but must
        // never redefine or lower the confirmed outcome. A no-op proposal has
        // nothing to confirm and is rejected.
        const proposal = evaluateCodeDeliveryOutcomeProposal(
          current.deliveryTarget.outcomeKind,
          command.outcomeKind,
        );
        if (!proposal.admissible) {
          throw this.#failure(
            "invalid",
            "The proposed delivery outcome matches the confirmed outcome.",
          );
        }
      }
      const requestedNext = decodeCodeThread(
        command.kind === "rename-code-thread"
          ? { ...current, title: command.title, version: command.expectedVersion + 1, updatedAt }
          : command.kind === "pin-code-thread"
            ? // Unpinning drops the field rather than storing `false`, so a
              // never-pinned thread and an unpinned one are the same record.
              {
                ...withoutPinned(current),
                ...(command.pinned ? { pinned: true } : {}),
                version: command.expectedVersion + 1,
                updatedAt,
              }
            : command.kind === "change-code-thread-lifecycle"
              ? {
                  ...current,
                  lifecycle: command.lifecycle,
                  version: command.expectedVersion + 1,
                  updatedAt,
                }
              : command.kind === "change-code-thread-access"
                ? {
                    ...current,
                    executionPolicy: command.executionPolicy,
                    permissionPersistence: command.permissionPersistence,
                    version: command.expectedVersion + 1,
                    updatedAt,
                  }
                : command.kind === "change-code-thread-provider"
                  ? {
                      ...current,
                      providerInstanceId: command.providerInstanceId,
                      modelId: command.modelId,
                      providerHandoff: {
                        previousProviderInstanceId: current.providerInstanceId,
                        previousModelId: current.modelId,
                        nextProviderInstanceId: command.providerInstanceId,
                        nextModelId: command.modelId,
                        changedAt: updatedAt,
                      },
                      version: command.expectedVersion + 1,
                      updatedAt,
                    }
                  : command.kind === "propose-code-delivery-outcome"
                    ? {
                        ...current,
                        deliveryTarget: {
                          ...current.deliveryTarget,
                          proposedOutcome: {
                            outcomeKind: command.outcomeKind,
                            ...(command.rationale === undefined
                              ? {}
                              : { rationale: command.rationale }),
                            proposedAt: updatedAt,
                          },
                        },
                        version: command.expectedVersion + 1,
                        updatedAt,
                      }
                    : command.kind === "confirm-code-delivery-outcome"
                      ? {
                          ...current,
                          // The user confirms the outcome kind: the Git-level
                          // delivery fields stay immutable and any pending agent
                          // proposal is cleared once resolved.
                          deliveryTarget: {
                            ...stripProposedOutcome(current.deliveryTarget),
                            outcomeKind: command.outcomeKind,
                            confirmedAt: updatedAt,
                          },
                          version: command.expectedVersion + 1,
                          updatedAt,
                        }
                      : {
                          ...current,
                          workingDirectory: command.workingDirectory,
                          version: command.expectedVersion + 1,
                          updatedAt,
                        },
      );
      const next =
        command.kind === "change-code-thread-access" &&
        command.executionPolicy === "full-access" &&
        command.permissionPersistence === "current-session"
          ? decodeCodeThread({ ...requestedNext, executionPolicy: "approval-gated" })
          : requestedNext;
      this.#append("code-thread", current.id, command.expectedVersion, "code.thread-updated@1", {
        kind: "thread-updated",
        thread: next,
      });
      if (command.kind === "change-code-thread-working-directory") {
        await this.#onWorkingDirectoryChanged({
          mode: "code",
          projectId: current.projectId,
          threadId: current.id,
        }).catch(() => undefined);
      }
      if (command.kind === "change-code-thread-access") {
        if (
          command.executionPolicy === "full-access" &&
          command.permissionPersistence === "current-session"
        ) {
          this.#sessionAuthority.grantFullAccess(authenticatedWindowId, current.id);
        } else {
          this.#sessionAuthority.revokeThread(authenticatedWindowId, current.id);
        }
      } else if (
        command.kind === "change-code-thread-lifecycle" &&
        command.lifecycle !== "active"
      ) {
        this.#sessionAuthority.revokeThread(authenticatedWindowId, current.id);
      }
      const publicNext = this.#sessionAuthority.effectiveThread(authenticatedWindowId, next);
      return command.kind === "change-code-thread-lifecycle"
        ? {
            kind: "thread-lifecycle-changed",
            threadId: current.id,
            lifecycle: command.lifecycle,
            version: publicNext.version,
          }
        : { kind: "thread-updated", thread: publicNext };
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  async *subscribe(
    authenticatedWindowId: WindowId,
    threadId: CodeThreadId,
    afterSequence: number,
    signal?: AbortSignal,
  ): AsyncGenerator<CodeEventFrame> {
    const view = await this.read(authenticatedWindowId, threadId);
    if (afterSequence > view.lastSequence || afterSequence > view.thread.version) {
      throw this.#failure("stale", "Code replay requires a snapshot.");
    }
    if (afterSequence === view.thread.version) return;
    let threadCursor = afterSequence;
    while (!signal?.aborted) {
      const events = this.#persistence.journal.replayAggregate({
        aggregateType: "code-thread",
        aggregateId: threadId,
        afterVersion: threadCursor,
        limit: 100,
      });
      if (events.length === 0) break;
      for (const event of events) {
        if (event.aggregateVersion !== threadCursor + 1) {
          throw this.#failure("stale", "Code replay requires a snapshot.");
        }
        const frame = this.#publicFrame(threadId, event);
        if (frame !== undefined) {
          threadCursor = event.aggregateVersion;
          yield frame;
        }
      }
      if (events.length < 100) break;
    }
  }

  async readContent(
    authenticatedWindowId: WindowId,
    contentId: CodeEvidenceContentId | string,
  ): Promise<{ readonly bytes: Uint8Array; readonly digest: string; readonly byteLength: number }> {
    let owner: CodeFileReference | undefined;
    for (const thread of this.#persistence.readCodeThreads()) {
      if (!(await this.#access.canAccessProject(authenticatedWindowId, thread.projectId))) continue;
      owner = this.#persistence
        .readCodeFileReferences(thread.id)
        .find((reference) => String(reference.contentId) === String(contentId));
      if (owner !== undefined) break;
    }
    const expected =
      owner ?? (await this.#openedContentAuthority(authenticatedWindowId, String(contentId)));
    if (expected === undefined) {
      throw this.#failure("unauthorized", "Code content is unauthorized.");
    }
    try {
      const bytes = this.#content.get(String(contentId));
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== expected.byteLength || digest !== expected.digest) {
        throw this.#failure("unavailable", "Code content verification failed.");
      }
      return { bytes, digest, byteLength: bytes.byteLength };
    } catch (error) {
      if (error instanceof CodeServiceError) throw error;
      throw this.#failure(
        error instanceof CodeContentStoreError && error.code === "not-found"
          ? "unavailable"
          : "failed",
        "Code content is unavailable.",
      );
    }
  }

  async stageEvidence(
    authenticatedWindowId: WindowId,
    threadId: CodeThreadId,
    text: string,
  ): Promise<CodeEvidenceReference> {
    const thread = this.#persistence.readCodeThread(threadId);
    if (thread === undefined) throw this.#failure("invalid", "Code thread was not found.");
    await this.#authorizeThread(authenticatedWindowId, thread);
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength === 0) {
      throw this.#failure("invalid", "Code evidence cannot be empty.");
    }
    try {
      return this.#evidence?.put(text) ?? decodeCodeEvidenceReference(this.#content.put(bytes));
    } catch (error) {
      throw this.#failure(
        error instanceof CodeContentStoreError && error.code === "capacity"
          ? "unavailable"
          : "failed",
        "Code evidence could not be staged.",
      );
    }
  }

  /**
   * Accept one image for a thread's next turn.
   *
   * Authority is the thread's own: whoever may send this thread a turn may
   * attach a picture to it. Nothing the renderer claims about the bytes is
   * kept — the store re-derives the name, size, and digest the journal will
   * later record from what it actually wrote.
   */
  async stageAttachment(
    authenticatedWindowId: WindowId,
    input: {
      readonly threadId: CodeThreadId;
      readonly attachmentId: CodeAttachmentId;
      readonly displayName: string;
      readonly mediaType: CodeAttachmentMediaType;
      readonly bytes: Uint8Array;
      readonly signal?: AbortSignal;
    },
  ): Promise<CodeAttachmentReference> {
    const attachments = await this.#authorizeAttachment(authenticatedWindowId, input.threadId);
    try {
      return await attachments.stage(input);
    } catch (error) {
      throw this.#failure(
        error instanceof CodeAttachmentTooLarge || error instanceof CodeAttachmentInvalid
          ? "invalid"
          : "failed",
        error instanceof CodeAttachmentTooLarge || error instanceof CodeAttachmentInvalid
          ? error.message
          : "Code attachment could not be staged.",
      );
    }
  }

  /**
   * Read one attached image back, verified against the size and digest the
   * journal recorded for it rather than trusted for being on disk.
   */
  async readAttachment(
    authenticatedWindowId: WindowId,
    threadId: CodeThreadId,
    input: {
      readonly attachmentId: CodeAttachmentId;
      readonly byteLength: number;
      readonly digest: string;
    },
  ): Promise<Uint8Array> {
    const attachments = await this.#authorizeAttachment(authenticatedWindowId, threadId);
    try {
      return await attachments.read(threadId, input);
    } catch {
      throw this.#failure("unavailable", "Code attachment is unavailable.");
    }
  }

  async discardAttachment(
    authenticatedWindowId: WindowId,
    threadId: CodeThreadId,
    attachmentId: CodeAttachmentId,
  ): Promise<void> {
    const attachments = await this.#authorizeAttachment(authenticatedWindowId, threadId);
    try {
      await attachments.discard(threadId, attachmentId);
    } catch {
      throw this.#failure("failed", "Code attachment could not be discarded.");
    }
  }

  async #authorizeAttachment(
    authenticatedWindowId: WindowId,
    threadId: CodeThreadId,
  ): Promise<CodeAttachmentStore> {
    const thread = this.#persistence.readCodeThread(threadId);
    if (thread === undefined) throw this.#failure("invalid", "Code thread was not found.");
    await this.#authorizeThread(authenticatedWindowId, thread);
    const attachments = this.#attachments;
    if (attachments === undefined) {
      throw this.#failure("unavailable", "Code attachments are unavailable.");
    }
    return attachments;
  }

  /**
   * The expectation for content staged by `openFile`, granted only when the
   * requesting window may access the owning thread's Project. Opened content
   * is process-local, so this is the read-side counterpart of the persisted
   * file-reference ownership check above it.
   */
  async #openedContentAuthority(
    authenticatedWindowId: WindowId,
    contentId: string,
  ): Promise<CodeContentReference | undefined> {
    const record = this.#openedFiles.get(contentId);
    if (record === undefined) return undefined;
    const thread = this.#persistence.readCodeThread(record.threadId);
    if (thread === undefined) return undefined;
    const allowed = await this.#access.canAccessProject(authenticatedWindowId, thread.projectId);
    return allowed ? record.content : undefined;
  }

  /**
   * List the checkout bound to a Code thread.
   *
   * Listing is a read, so every posture including Plan may perform it; the
   * gate that matters is the same root authority the save path uses. Resolving
   * the root re-checks Project lifecycle, binding revision, checkout ownership,
   * and observed HEAD, so a listing can never enumerate a checkout the thread
   * is no longer bound to. Failures are typed rather than thrown because an
   * unavailable helper or a moved root is an ordinary answer for a read.
   */
  async listFiles(
    authenticatedWindowId: WindowId,
    input: CodeListFilesInput,
  ): Promise<CodeFileListingResult> {
    const authorized = await this.#authorizeCheckoutRead(
      authenticatedWindowId,
      input.threadId,
      input.checkoutId,
      "Code file listing is unauthorized.",
    );
    const thread = authorized.thread;
    const checkout = authorized.checkout;
    const list = this.#files.list?.bind(this.#files);
    if (list === undefined) {
      return {
        status: "failed",
        failure: { category: "unavailable", message: "Code file listing is unavailable." },
      };
    }
    const root = await this.#roots.resolve(
      authenticatedWindowId,
      authorized.effectiveThread,
      checkout,
      input.directory ?? CODE_LISTING_ROOT_PROBE_PATH,
    );
    if (root === undefined) {
      return {
        status: "failed",
        failure: { category: "unavailable", message: "Code file authority is unavailable." },
      };
    }
    return await list({
      threadId: thread.id,
      checkoutId: checkout.id,
      rootPath: root.rootPath,
      ...(input.directory === undefined ? {} : { directory: input.directory }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  /**
   * Search the checkout bound to a Code thread by path or by content.
   *
   * Search is a read under the same checkout authority the listing uses, so
   * every posture including Plan may run one. The searcher owns confinement
   * and every bound; this method owns only the authority and the root.
   */
  async searchFiles(
    authenticatedWindowId: WindowId,
    input: CodeSearchFilesInput,
  ): Promise<CodeSearchResult> {
    const authorized = await this.#authorizeCheckoutRead(
      authenticatedWindowId,
      input.threadId,
      input.checkoutId,
      "Code search is unauthorized.",
    );
    const searcher = this.#searcher;
    if (searcher === undefined) {
      return {
        status: "failed",
        failure: { category: "unavailable", message: "Code search is unavailable." },
      };
    }
    const root = await this.#roots.resolve(
      authenticatedWindowId,
      authorized.effectiveThread,
      authorized.checkout,
      CODE_LISTING_ROOT_PROBE_PATH,
    );
    if (root === undefined) {
      return {
        status: "failed",
        failure: { category: "unavailable", message: "Code file authority is unavailable." },
      };
    }
    return await searcher.search({
      threadId: authorized.thread.id,
      checkoutId: authorized.checkout.id,
      rootPath: root.rootPath,
      scope: input.scope,
      query: input.query,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  /**
   * Watch the checkout bound to a Code thread for changes.
   *
   * Authority is resolved once, before the subscription exists, through the
   * same checkout read the listing uses, and the stream is then registered
   * against the window that opened it so `revokeWindow` ends it. A watch
   * therefore cannot outlive its grant, rather than only being refused on the
   * next reconnect. The notices carry paths only; every refetch they provoke is
   * authorized again.
   *
   * The authorization is awaited before the stream exists rather than inside a
   * generator body, which does not run until its first `next()`. A refusal or
   * missing capability has to reach the caller while it can still become a
   * status code; deferred, it would arrive as a stream that opened and
   * immediately closed, which reads as a dropped watch and gets retried
   * instead of shown.
   */
  async watchFiles(
    authenticatedWindowId: WindowId,
    input: CodeWatchFilesInput,
  ): Promise<AsyncIterable<CodeFileChangeNotice>> {
    const authorized = await this.#authorizeCheckoutRead(
      authenticatedWindowId,
      input.threadId,
      input.checkoutId,
      "Code file watching is unauthorized.",
    );
    const watcher = this.#watcher;
    if (watcher === undefined) {
      throw this.#failure("unavailable", "Code file watching is unavailable.");
    }
    const root = await this.#roots.resolve(
      authenticatedWindowId,
      authorized.effectiveThread,
      authorized.checkout,
      CODE_LISTING_ROOT_PROBE_PATH,
    );
    if (root === undefined) {
      throw this.#failure("unavailable", "Code file authority is unavailable.");
    }
    const revocation = new AbortController();
    const abort = () => revocation.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted === true) revocation.abort();
    const open = this.#openWatches.get(String(authenticatedWindowId)) ?? new Set();
    open.add(revocation);
    this.#openWatches.set(String(authenticatedWindowId), open);
    const notices = watcher.watch({
      threadId: authorized.thread.id,
      checkoutId: authorized.checkout.id,
      rootPath: root.rootPath,
      signal: revocation.signal,
    });
    const openWatches = this.#openWatches;
    const windowKey = String(authenticatedWindowId);
    return (async function* () {
      try {
        yield* notices;
      } finally {
        input.signal?.removeEventListener("abort", abort);
        const remaining = openWatches.get(windowKey);
        remaining?.delete(revocation);
        if (remaining?.size === 0) openWatches.delete(windowKey);
      }
    })();
  }

  /**
   * End every file watch a window left open. Called when its capability is
   * revoked, so a retained connection cannot keep reporting repository paths
   * after the authority that opened it is gone.
   */
  revokeWindow(windowId: WindowId): void {
    const open = this.#openWatches.get(String(windowId));
    if (open === undefined) return;
    this.#openWatches.delete(String(windowId));
    for (const controller of open) controller.abort();
  }

  /**
   * Open the confined file bound to a Code thread for the editor surface.
   *
   * Opening is a read: every posture including Plan may perform it through the
   * same checkout authority as the file listing, and no journal event is
   * appended. The bytes are staged process-locally; the strict envelope hands
   * back only the resolved file identity, metadata, and a content reference
   * that `readContent` serves under the same thread authority.
   */
  async openFile(
    authenticatedWindowId: WindowId,
    input: CodeOpenFileInput,
  ): Promise<CodeFileOpenResultEnvelope> {
    const authorized = await this.#authorizeCheckoutRead(
      authenticatedWindowId,
      input.threadId,
      input.checkoutId,
      "Code file open is unauthorized.",
    );
    const root = await this.#roots.resolve(
      authenticatedWindowId,
      authorized.effectiveThread,
      authorized.checkout,
      input.relativePath,
    );
    if (root === undefined) {
      throw this.#failure("unavailable", "Code file authority is unavailable.");
    }
    const opened = await this.#files.open({
      rootPath: root.rootPath,
      rootIdentity: root.rootIdentity,
      path: input.relativePath,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (opened.status === "editable") {
      // An open never invalidates an earlier open's reference, not even for the
      // same file: the editor that opened first may not have fetched its bytes
      // yet, and releasing them under it would report an existing file as
      // unavailable. So the store does need room for two copies of one file,
      // and the entry and byte ceilings, not one entry per file, are what bound
      // it. The same holds when an open fails or answers read-only: the earlier
      // staging stays readable until the ceilings reclaim it, because the
      // server cannot tell a stale tab from one still fetching.
      this.#stageOpenedFile(authorized.thread.id, opened.content);
    }
    return decodeCodeFileOpenResultEnvelope({
      kind: "code-file-open-result",
      result: publicOpenResult(root.fileId, opened),
    });
  }

  /**
   * Stage an opened file's bytes and release the least recently opened ones
   * until the browsing cache is back inside its reserved slice.
   *
   * Closing an editor tab reaches no server, and a renderer that dies never
   * reports anything, so opened staging has to reclaim itself. These ceilings
   * are the whole bound, and every staged reference counts against them, so
   * repeatedly re-opening one file reclaims itself like browsing many files
   * does. Recency is the only signal the server has: the editor reads a file's
   * content right after opening it and re-opens whenever it needs the bytes
   * again, so releasing the oldest staging costs a re-open at worst. The
   * reference just staged is never released, which also terminates the loop
   * when one file exceeds the byte slice on its own. The store issues a fresh
   * id for every open and a staged reference stays stored until it is released,
   * so a staged key is never reused and the byte total stays exact.
   */
  #stageOpenedFile(threadId: CodeThreadId, content: CodeContentReference): void {
    this.#openedFiles.set(content.contentId, { threadId, content });
    this.#openedFileBytes += content.byteLength;
    for (const staged of this.#openedFiles.keys()) {
      if (
        staged === content.contentId ||
        (this.#openedFiles.size <= MAXIMUM_OPENED_CODE_FILE_ENTRIES &&
          this.#openedFileBytes <= MAXIMUM_OPENED_CODE_FILE_BYTES)
      ) {
        break;
      }
      this.#releaseOpenedFile(staged);
    }
  }

  /**
   * Release one staged reference and its bytes. The record goes with the bytes:
   * keeping it would leak a smaller unbounded map, and a reference the server
   * has no record of is refused by `readContent` as unauthorized rather than
   * served, which is exactly what the server then knows about it.
   */
  #releaseOpenedFile(contentId: string): void {
    const staged = this.#openedFiles.get(contentId);
    if (staged === undefined) return;
    this.#openedFiles.delete(contentId);
    this.#openedFileBytes -= staged.content.byteLength;
    this.#content.purge(staged.content.contentId);
  }

  /**
   * The repository tests the thread's bound checkout offers.
   *
   * Discovery is a read and runs the same checkout authority as the file
   * listing, so Plan may list what it may not run. The definitions are the
   * host's: a renderer selects one and submits it back, and the run path
   * re-derives this same list before it will execute anything.
   */
  async listTests(
    authenticatedWindowId: WindowId,
    input: CodeListTestsInput,
  ): Promise<CodeRepositoryTestListing> {
    const authorized = await this.#authorizeCheckoutRead(
      authenticatedWindowId,
      input.threadId,
      input.checkoutId,
      "Code repository test listing is unauthorized.",
    );
    const root =
      this.#tests === undefined
        ? undefined
        : await this.#roots.resolve(
            authenticatedWindowId,
            authorized.effectiveThread,
            authorized.checkout,
            CODE_LISTING_ROOT_PROBE_PATH,
          );
    // An unwired discovery or an unresolvable root offers nothing to run. That
    // is an empty list, not a failure that takes the Code workspace down.
    const definitions =
      this.#tests === undefined || root === undefined
        ? []
        : await this.#tests.discover({
            checkoutId: String(authorized.checkout.id),
            rootPath: root.rootPath,
          });
    return decodeCodeRepositoryTestListing({
      kind: "code-repository-test-listing",
      threadId: authorized.thread.id,
      checkoutId: authorized.checkout.id,
      definitions,
      observedAt: this.#clock(),
    });
  }

  /**
   * The checkout authority every confined Code read shares.
   *
   * Reading is allowed in every posture including Plan; the gate that matters
   * is the thread's own binding. Re-reading the checkout here re-checks Project
   * lifecycle, binding revision, checkout ownership, and observed HEAD, so no
   * read can reach a checkout the thread is no longer bound to.
   */
  async #authorizeCheckoutRead(
    authenticatedWindowId: WindowId,
    threadId: CodeThreadId,
    checkoutId: CodeCheckoutId,
    unauthorizedMessage: string,
  ): Promise<{
    readonly thread: CodeThread;
    readonly effectiveThread: CodeThread;
    readonly checkout: CodeCheckoutIdentity;
  }> {
    const thread = this.#persistence.readCodeThread(threadId);
    if (thread === undefined) throw this.#failure("invalid", "Code thread was not found.");
    await this.#authorizeThread(authenticatedWindowId, thread);
    const effectiveThread = this.#sessionAuthority.effectiveThread(authenticatedWindowId, thread);
    if (effectiveThread.checkoutId !== checkoutId) {
      throw this.#failure("invalid", "Code file checkout is invalid.");
    }
    const checkout = this.#persistence.readCodeCheckout(checkoutId);
    if (
      checkout === undefined ||
      checkout.repositoryId !== thread.repositoryId ||
      checkout.availability !== "available"
    ) {
      throw this.#failure("waiting", "Code checkout is unavailable.");
    }
    const policy = authorizeCodeOperation({
      actor: "local-user",
      posture: effectiveThread.executionPolicy,
      operation: "read",
    });
    if (policy.decision !== "allow") {
      throw this.#failure("unauthorized", unauthorizedMessage);
    }
    return { thread, effectiveThread, checkout };
  }

  async saveFile(
    authenticatedWindowId: WindowId,
    input: CodeSaveFileInput,
  ): Promise<CodeFileSaveResultEnvelope> {
    const thread = this.#persistence.readCodeThread(input.threadId);
    if (thread === undefined) throw this.#failure("invalid", "Code thread was not found.");
    await this.#authorizeThread(authenticatedWindowId, thread);
    const effectiveThread = this.#sessionAuthority.effectiveThread(authenticatedWindowId, thread);
    if (effectiveThread.lifecycle !== "active" || effectiveThread.checkoutId !== input.checkoutId) {
      throw this.#failure("invalid", "Code file checkout is invalid.");
    }
    const checkout = this.#persistence.readCodeCheckout(input.checkoutId);
    if (
      checkout === undefined ||
      checkout.repositoryId !== thread.repositoryId ||
      checkout.availability !== "available"
    ) {
      throw this.#failure("waiting", "Code checkout is unavailable.");
    }
    // A manual editor save is the user's own action, not an agent mutation:
    // approval-gated does not prompt for it. Plan mode still denies.
    const policy = authorizeCodeOperation({
      actor: "local-user",
      posture: effectiveThread.executionPolicy,
      operation: "edit",
      initiator: "user",
    });
    if (policy.decision !== "allow") {
      throw this.#failure(
        policy.decision === "prompt" ? "waiting" : "unauthorized",
        policy.decision === "prompt"
          ? "Code file save requires approval."
          : "Code file save is unauthorized.",
      );
    }
    const root = await this.#roots.resolve(
      authenticatedWindowId,
      effectiveThread,
      checkout,
      input.relativePath,
    );
    if (root === undefined)
      throw this.#failure("unavailable", "Code file authority is unavailable.");
    const existingFile = this.#persistence.readCodeFileReference(root.fileId);
    if (
      existingFile !== undefined &&
      (existingFile.threadId !== thread.id || existingFile.checkoutId !== checkout.id)
    ) {
      throw this.#failure("invalid", "Code file identity is invalid.");
    }
    if (existingFile?.state === "saving") {
      throw this.#failure("waiting", "Code file save is already in progress.");
    }
    const expectedFileVersion = existingFile?.version ?? root.expectedFileVersion ?? 0;
    const attemptedBytes = new TextEncoder().encode(input.text);
    const attemptedDigest = createHash("sha256").update(attemptedBytes).digest("hex");
    const saving = decodeCodeFileReference({
      id: root.fileId,
      threadId: thread.id,
      checkoutId: checkout.id,
      relativePath: input.relativePath,
      digest: attemptedDigest,
      byteLength: attemptedBytes.byteLength,
      state: "saving",
      version: expectedFileVersion + 1,
      updatedAt: decodeTimestamp(this.#clock()),
    });
    try {
      this.#append("code-file", root.fileId, expectedFileVersion, "code.file-reference-updated@1", {
        kind: "file-reference-updated",
        file: saving,
      });
    } catch (error) {
      throw this.#mapFailure(error);
    }

    let saved: CodeFileSaveResult;
    try {
      saved = await this.#files.save({
        rootPath: root.rootPath,
        rootIdentity: root.rootIdentity,
        path: input.relativePath,
        expectedIdentity: input.expectedIdentity,
        expectedDigest: input.expectedDigest,
        text: input.text,
      });
      decodeCodeFileSaveResultEnvelope({ kind: "code-file-save-result", result: saved });
    } catch {
      saved = { status: "interrupted", rescanRequired: true };
    }

    const terminal = decodeCodeFileReference({
      ...saving,
      ...(saved.status === "completed"
        ? { digest: saved.metadata.digest, byteLength: saved.metadata.byteLength }
        : existingFile === undefined
          ? {}
          : {
              ...(existingFile.contentId === undefined
                ? {}
                : { contentId: existingFile.contentId }),
              digest: existingFile.digest,
              byteLength: existingFile.byteLength,
            }),
      state:
        saved.status === "completed"
          ? "completed"
          : saved.status === "conflict"
            ? "conflict"
            : saved.status === "failed"
              ? "failed"
              : "interrupted",
      version: saving.version + 1,
      updatedAt: decodeTimestamp(this.#clock()),
    });
    try {
      this.#append("code-file", root.fileId, saving.version, "code.file-reference-updated@1", {
        kind: "file-reference-updated",
        file: terminal,
      });
    } catch {
      return decodeCodeFileSaveResultEnvelope({
        kind: "code-file-save-result",
        result: { status: "interrupted", rescanRequired: true },
      });
    }
    return decodeCodeFileSaveResultEnvelope({ kind: "code-file-save-result", result: saved });
  }

  #defaultSettings(): CodeSettings {
    return {
      defaultExecutionPolicy: "approval-gated",
      defaultPermissionPersistence: "current-session",
      version: 0 as AggregateVersion,
      updatedAt: decodeTimestamp(this.#clock()),
    };
  }

  #rebindRefused(
    threadId: CodeThreadId,
    reason: CodeThreadCheckoutRebindRefusal,
  ): CodeCommandResult {
    return { kind: "thread-checkout-rebind", threadId, outcome: { status: "refused", reason } };
  }

  async #authorizeThread(authenticatedWindowId: WindowId, thread: CodeThread): Promise<void> {
    if (!(await this.#access.canAccessProject(authenticatedWindowId, thread.projectId))) {
      throw this.#failure("unauthorized", "Code thread is unauthorized.");
    }
  }

  #append(
    aggregateType: string,
    aggregateId: string,
    expectedVersion: number,
    eventName: string,
    payload: unknown,
  ): void {
    this.#persistence.journal.append({
      aggregate: { aggregateType, aggregateId },
      expectedVersion,
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: { kind: "local-user", actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
          occurredAt: decodeTimestamp(this.#clock()),
          payload,
        },
      ],
    });
  }

  #publicFrame(threadId: CodeThreadId, event: EventEnvelope): CodeEventFrame | undefined {
    if (event.aggregateType !== "code-thread" || String(event.aggregateId) !== String(threadId)) {
      return undefined;
    }
    if (event.eventName === "code.thread-created@1") {
      return decodeCodeEventFrame({
        threadId,
        sequence: event.aggregateVersion,
        event: decodeCodeThreadCreated(event.payload),
      });
    }
    if (event.eventName === "code.thread-updated@1") {
      return decodeCodeEventFrame({
        threadId,
        sequence: event.aggregateVersion,
        event: decodeCodeThreadUpdated(event.payload),
      });
    }
    return undefined;
  }

  #managedCreationFailure(
    outcome:
      | Readonly<{ status: "refused"; reason: string }>
      | Readonly<{ status: "waiting" | "interrupted" }>,
  ): CodeServiceError {
    if (outcome.status !== "refused") {
      return outcome.status === "interrupted"
        ? this.#failure("interrupted", "Managed Code worktree creation was interrupted.")
        : this.#failure("unavailable", "Managed Code worktree creation is waiting; retry.");
    }
    const message =
      MANAGED_CREATION_REFUSAL_MESSAGES[outcome.reason] ??
      `Managed Code worktree creation was refused: ${outcome.reason}.`;
    const category: CodeFailure["category"] =
      outcome.reason === "branch-collision" ||
      outcome.reason === "path-collision" ||
      outcome.reason === "ref-ambiguous"
        ? "conflict"
        : "unavailable";
    return this.#failure(category, message);
  }

  #mapFailure(error: unknown): CodeServiceError {
    if (error instanceof CodeServiceError) return error;
    if (error instanceof ConcurrencyConflict) {
      return this.#failure("stale", "Code state changed; reload and retry.");
    }
    if (error instanceof JournalWriteFailed || error instanceof ProjectionApplicationFailed) {
      return this.#failure("unavailable", "Code storage is unavailable.");
    }
    return this.#failure("failed", "Octant Code service failed.");
  }

  async #requireProviderModel(
    providerInstanceId: CodeThread["providerInstanceId"],
    modelId: ProviderModelId,
  ): Promise<void> {
    if (this.#probeProvider === undefined) return;
    let probe: ProviderProbeResult;
    try {
      probe = await this.#probeProvider(providerInstanceId);
    } catch {
      throw this.#failure("unavailable", "Selected Code provider is unavailable.");
    }
    const modelAvailable = probe.models.some((model) => String(model.id) === String(modelId));
    if (probe.readiness !== "ready" && !(probe.readiness === "degraded" && modelAvailable)) {
      throw this.#failure(
        probe.readiness === "unauthenticated"
          ? "unauthorized"
          : probe.readiness === "incompatible"
            ? "unsupported"
            : "unavailable",
        "Selected Code provider is not ready.",
      );
    }
    if (!modelAvailable) {
      throw this.#failure("invalid", "Selected Code model is unavailable.");
    }
  }

  /**
   * The most authority a Code Project hands out on its own. Full access above
   * this line is granted per thread by a native confirmation that a profile
   * cannot supply, so a profile asserting it is refused rather than quietly
   * reduced — the person picked a working mode they cannot actually have here,
   * and silently downgrading it would hide that.
   */
  #projectProfileCeiling(
    projectId: ProjectId,
    requestedExecutionPolicy: ProviderExecutionPolicy,
  ): ProviderExecutionPolicy {
    const project = this.#persistence.readProject?.(projectId);
    const standing: ProviderExecutionPolicy =
      project?.type === "code" && project.codeAccessPersistence === "project-default"
        ? "full-access"
        : "auto-accept-edits";
    // A profile that only matches what the person already asked for is not
    // granting anything — the request is, and the request answers to its own
    // gate, including the native confirmation session-only Full access needs.
    // The check is here to stop a profile reaching past the request, not to
    // refuse one for agreeing with it.
    return highestPolicy(standing, requestedExecutionPolicy);
  }

  /**
   * Narrow a starting thread to the profile it was started under. Runs before
   * every authority gate so a profile that pulls the thread below Full access
   * also removes the native confirmation it would otherwise demand, and returns
   * the permission duration too — a profile written to hold Full access for one
   * session must not produce a thread the Project remembers.
   */
  #profiledAuthority(input: {
    readonly profileId: AgentProfileId | undefined;
    readonly projectId: ProjectId;
    readonly threadId: CodeThreadId;
    readonly modelId: ProviderModelId;
    readonly requestedExecutionPolicy: ProviderExecutionPolicy;
    readonly requestedPermissionPersistence: PermissionPersistence;
  }): ProfiledThreadAuthority {
    if (input.profileId === undefined) {
      return {
        executionPolicy: input.requestedExecutionPolicy,
        permissionPersistence: input.requestedPermissionPersistence,
        toolConstraints: [],
      };
    }
    const binding = this.#persistence.readAgentProfileBinding?.(input.profileId);
    if (binding === undefined) {
      throw this.#failure("invalid", "The selected agent profile was not found.");
    }
    // An identifier alone says nothing about who owns the profile. A stale
    // multi-Project selection, or a crafted command, could otherwise attach
    // another Project's profile — or another thread's one-off — to this thread.
    if (
      !profileScopeApplies({
        scope: binding.scope,
        mode: "code",
        projectId: String(input.projectId),
        threadId: String(input.threadId),
      })
    ) {
      throw this.#failure(
        "unauthorized",
        `Profile "${binding.profile.displayName}" belongs to another Project, mode, or thread.`,
      );
    }
    const applied = applyProfileToThread({
      profile: binding.profile,
      mode: "code",
      modelId: input.modelId,
      requestedExecutionPolicy: input.requestedExecutionPolicy,
      requestedPermissionPersistence: input.requestedPermissionPersistence,
      projectExecutionPolicy: this.#projectProfileCeiling(
        input.projectId,
        input.requestedExecutionPolicy,
      ),
    });
    if (applied.status === "refused") {
      throw this.#failure(
        applied.code === "authority-escalation" ? "unauthorized" : "invalid",
        applied.reason,
      );
    }
    return {
      executionPolicy: applied.executionPolicy,
      permissionPersistence: applied.permissionPersistence,
      toolConstraints: applied.toolConstraints,
      profileDisplayName: applied.profileDisplayName,
      profileContext: snapshotProfileThreadContext(binding.profile),
    };
  }

  /**
   * Overlay the profile's snapshotted posture, tool allowlist, and context onto
   * a starting thread. Client-supplied snapshot fields are stripped: only the
   * profile the server loaded may write them.
   */
  #threadWithProfiledAuthority(thread: CodeThread, profiled: ProfiledThreadAuthority): CodeThread {
    const {
      toolConstraints: _clientTools,
      profileDisplayName: _clientName,
      profileContext: _clientContext,
      ...rest
    } = thread;
    return decodeCodeThread({
      ...rest,
      executionPolicy: profiled.executionPolicy,
      permissionPersistence: profiled.permissionPersistence,
      ...profileToolSnapshot(profiled),
      ...profileContextSnapshot(profiled),
    });
  }

  async #requireIssueContext(
    request: GithubIssueContextRequest | undefined,
  ): Promise<GithubIssueContextResult | { readonly status: "absent" }> {
    const prepared = await prepareOptionalIssueContext(
      this.#issueContext,
      request,
      new AbortController().signal,
    );
    if (prepared.status === "refused") {
      throw this.#failure(issueContextFailureCategory(prepared.reason), prepared.message);
    }
    return prepared;
  }

  #bindIssueContext(
    threadId: string,
    prepared: GithubIssueContextResult | { readonly status: "absent" },
    request: GithubIssueContextRequest | undefined,
  ): void {
    if (prepared.status !== "ready" || request === undefined) return;
    this.#issueContext?.bindCreatedThread({
      threadId,
      framed: prepared.framed,
      request,
    });
  }

  #failure(category: CodeFailure["category"], message: string): CodeServiceError {
    return new CodeServiceError(decodeCodeFailure({ category, message }));
  }
}

export type { CodeFileSaveResult };
