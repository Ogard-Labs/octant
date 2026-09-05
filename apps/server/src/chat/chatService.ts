import { createHash } from "node:crypto";
import {
  ActorId,
  CorrelationId,
  EventId,
  ReplayCursor,
  UtcTimestamp,
  decodeChatAttachment,
  decodeChatAttachmentId,
  decodeChatAttempt,
  decodeChatCitation,
  decodeChatCitationId,
  decodeChatCommand,
  decodeChatContentBody,
  decodeDiagnosticFailureCode,
  decodeChatEventFrame,
  decodeChatFailure,
  decodeChatPublicEvent,
  decodeCapacityReservationId,
  decodeContextEntry,
  decodeContextSubjectRef,
  decodeProviderAttachmentInput,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderSessionId,
  MAX_PROVIDER_TOOLS,
  decodeChatThreadId,
  decodeChatThread,
  decodeChatTurn,
  type ChatAttachment,
  type ChatAttempt,
  type ChatBootstrap,
  type ChatNavigation,
  MAX_CHAT_NAVIGATION_THREADS,
  MAX_CHAT_TRANSCRIPT_SEARCH_QUERY_LENGTH,
  type ChatCommandResult,
  type ChatContentReference,
  type ChatEventFrame,
  type ChatFailure,
  type ChatHandoffWarning,
  type ChatSettings,
  type ChatThread,
  type ChatThreadId,
  type ChatThreadView,
  type ChatTranscriptSearch,
  type ChatTurn,
  type ChatTurnRouteDecision,
  type AggregateVersion,
  type ChatAttachmentId,
  type ContextInspectorSnapshot,
  type ContextEntry,
  type ContextEntryId,
  type ContextPlan,
  type ContextSourceRef,
  type ContextSubjectRef,
  type ContextSummaryId,
  type ModelContextLimits,
  type ProviderAttachmentInput,
  type ProviderCapabilitySupport,
  type ProviderContextBlock,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderObservedState,
  type ProviderProbeResult,
  type MentionableThreadId,
  type ProviderServiceLimits,
  type WindowId,
} from "@octant/contracts";
import type { ExtensionSelection } from "@octant/contracts/extensions";
import {
  issueContextFailureCategory,
  prepareOptionalIssueContext,
  type GithubIssueContextService,
} from "../github/githubIssueContextService";
import {
  linearIssueContextFailureCategory,
  prepareOptionalLinearIssueContext,
  type LinearIssueContextService,
} from "../plugins/linear/linearIssueContextService";

type GithubIssueContextPort = Pick<
  GithubIssueContextService,
  | "prepare"
  | "bindCreatedThread"
  | "peekFramedForFirstTurn"
  | "consumeFramedForFirstTurn"
  | "takeFramedForFirstTurn"
>;

type LinearIssueContextPort = Pick<
  LinearIssueContextService,
  | "prepare"
  | "bindCreatedThread"
  | "peekFramedForFirstTurn"
  | "consumeFramedForFirstTurn"
  | "takeFramedForFirstTurn"
>;
import { LOCAL_HOST_ID, type HostId } from "@octant/contracts/host";
import type { CanvasContextSelection } from "@octant/contracts/canvasContext";
import type { PreviewContextSelection } from "@octant/contracts/previews";
import type { OctantMode } from "@octant/contracts/modes";
import {
  decodeMultiModelRoutingVendorId,
  type MultiModelPool,
  type MultiModelPoolCandidate,
} from "@octant/contracts/multi-model-pool";
import type { MultiModelCandidateRuntimeFacts } from "@octant/domain/multi-model-pool-policy";
import {
  ChatPolicyRejected,
  activeChatTurns,
  archiveChatThread,
  beginChatTurn,
  chatAttemptAnswered,
  chatTurnsThrough,
  changeChatProvider,
  changeChatResearch,
  createChatThread,
  requestChatThreadDeletion,
  retryChatTurn,
  resumeChatTurn,
  transitionChatAttempt,
  unsupportedModelOptionValues,
} from "@octant/domain/chat-policy";
import {
  chatProviderServesTurn,
  selectChatProviderFallback,
  type ChatProviderCapabilityName,
  type ChatProviderTurnFacts,
} from "@octant/domain/chat-provider-fallback-policy";
import {
  defaultShellSettings,
  reapsStaleProviderSession,
  THREAD_MENTION_UNREADABLE_CONTEXT,
} from "@octant/domain";
import { Schema } from "effect";
import { Effect } from "effect";
import {
  normalizeModelLimitEvidence,
  unavailableProviderServiceLimits,
  type ProviderModelLimitEvidence,
} from "@octant/provider-sdk/context-facts";
import {
  attachmentMediaTypeToModality,
  validateChatTurnInput,
} from "@octant/provider-sdk/chat-conformance";
import {
  contextSourceKey,
  ContextHarnessError,
  ContextHarnessService,
} from "../context/contextHarnessService";
import { makeContextSummaryGenerator } from "../context/contextSummaryGenerator";
import { deriveCatalogEpoch, type CapabilityCatalogEntry } from "../context/capabilityCatalog";
import type { ProviderCapacityScheduler } from "../context/providerCapacityScheduler";
import { ConcurrencyConflict, JournalWriteFailed } from "../persistence/journalErrors";
import type { PersistenceService } from "../persistence/persistenceService";
import type { SqliteConnection } from "../persistence/sqlitePort";
import { ProjectionApplicationFailed } from "../persistence/projection";
import {
  CHAT_SETTINGS_AGGREGATE_ID,
  readAggregateVersion,
  readThreadWorkState,
  purgeThreadContent,
  writeChatContent,
} from "../persistence/chatProjection";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { modelEvidenceFromObservedState } from "../providers/providerContextFacts";
import type { ReviewedModelManifest } from "../providers/reviewedModelManifest";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { createDiagnosticsFailureIncidentEvent } from "../diagnosticsExportService";
import { ChatAttachmentStore } from "./chatAttachmentStore";
import { ChatScratchStore } from "./chatScratchStore";
import { ChatTurnRunner, type AppManagedToolSet } from "./chatTurnRunner";
import type {
  NativeHarnessTurnAdmission,
  NativeHarnessTurnScope,
} from "../harness/nativeHarnessTurnObserver";
import type { ResearchRouteDecision, ResearchRouter } from "./research/researchRouter";
import { SearxngEndpointRejected, validateSearxngEndpoint } from "./research/searxngEndpoint";
import {
  ThreadWorkService,
  ThreadWorkServiceError,
  type ThreadWorkCommandResult,
} from "./threadWorkService";
import { MultiModelRouteService } from "./multiModelRouteService";

const RESEARCH_TOOL_NAME = "octant_web_research";
const DEFAULT_CHAT_PERSONALITY_INSTRUCTIONS = "Be calm, direct, and useful.";
const FALLBACK_CHAT_CONTEXT_WINDOW = 4_096;
const FALLBACK_CHAT_MAX_OUTPUT = 1_024;

type ConfiguredChatSettings = ChatSettings & {
  readonly defaultProviderInstanceId: ProviderInstanceId;
  readonly defaultModelId: ProviderModelId;
};

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
/** Shared empty set so the default hidden-thread lookup allocates nothing per read. */
const EMPTY_HIDDEN_THREAD_IDS: ReadonlySet<string> = new Set();
/**
 * Said to the user when a Side Chat's source thread can no longer be read.
 * The sidecar refuses the turn instead of answering about a thread it cannot
 * see, so a deleted or newly unauthorized source is never mistaken for an
 * empty conversation.
 */
const SIDE_CHAT_SOURCE_UNREADABLE =
  "The thread this Side Chat is about can no longer be read, so this Side Chat cannot answer about it.";
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursor);

const CHAT_EVENT_NAMES = new Set([
  "chat.settings-updated@1",
  "chat.thread-created@1",
  "chat.thread-updated@1",
  "chat.turn-created@1",
  "chat.attempt-updated@1",
  "chat.turn-route-decided@1",
  "chat.attachment-updated@1",
  "chat.citation-recorded@1",
  "thread.work-updated@1",
  "thread.follow-up-updated@1",
  "chat.deletion-requested@1",
  "chat.deleted@1",
]);

/**
 * The thread as one route actually runs it.
 *
 * Multi-model pool routing can send a turn to a different provider instance or
 * model than the thread selected. Model option values belong to the selected
 * model and are validated against its declared options, so an alternate
 * candidate runs on provider defaults instead of inheriting settings it never
 * declared. Every derivation of a routed thread — the turn's execution thread
 * and each attempt's run — goes through here, so preflight and the driver
 * agree on which options this route carries.
 */
function threadAsRoutedFor(
  thread: ChatThread,
  route: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  },
): ChatThread {
  const routed: ChatThread = {
    ...thread,
    providerInstanceId: route.providerInstanceId,
    modelId: route.modelId,
  };
  // Model options are declared against one provider instance's model. Two
  // compatible endpoints commonly expose the same model id, so the whole
  // routing identity has to match before the selected options travel with it.
  if (
    String(route.modelId) === String(thread.modelId) &&
    String(route.providerInstanceId) === String(thread.providerInstanceId)
  ) {
    return routed;
  }
  const { modelOptionValues: _selectedModelOptions, ...withoutOptions } = routed;
  return withoutOptions;
}

/**
 * What a provider reports about serving one turn, for the selected model.
 *
 * `appManagedTools` is the effective support for that model rather than the
 * provider-wide flag: an endpoint whose deployments are verified one at a time
 * reports the provider as unsupported while the selected model does accept the
 * app's tools, and the turn runs against the model.
 */
function providerTurnFacts(
  probe: ProviderProbeResult,
  appManagedTools: ProviderCapabilitySupport,
): ChatProviderTurnFacts {
  return {
    readiness: probe.readiness,
    models: probe.models.map((model) => model.id),
    capabilities: { ...probe.capabilities, appManagedTools },
  };
}

/**
 * Streaming is what a Chat turn is: an instance that does not report it cannot
 * serve the conversation. Research capability is not listed here because the
 * research router already decides which backend a thread's routing resolves to
 * — including `automatic`, which may land on either — so the route decision is
 * the single check a candidate has to pass.
 */
const CHAT_TURN_REQUIRED_CAPABILITIES: ReadonlyArray<ChatProviderCapabilityName> = ["streaming"];

function poolCandidateKey(candidate: MultiModelPoolCandidate): string {
  return `${candidate.hostId}:${candidate.providerInstanceId}:${candidate.modelId}`;
}

/** The `summary` source-key prefix {@link contextSourceKey} produces. */
const SUMMARY_SOURCE_KEY_PREFIX = contextSourceKey({ kind: "summary", referenceId: "" });

/**
 * The journaled summaries a turn may send, given the conversation it selected.
 *
 * A summary's material is the set of conversation sources it replaced — the
 * ones the projection's manifest still records as `summarized` against it — so
 * it may only stand in when every one of those sources is part of this turn's
 * history. A summary that replaced an earlier summary is in range only when
 * that earlier one is too, because it carries the same conversation forward.
 *
 * A summary that is only partly in range is not partly trusted: it is dropped
 * whole, and the material it covered is sent as the real turns instead (which
 * this turn compacts again if it does not fit). Reusing it would put back
 * exactly the superseded conversation an edit exists to exclude.
 */
function reusableContextSummaryIds(
  summarizedSourceKeys: ReadonlyMap<string, ContextSummaryId>,
  historySourceKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  const replacedBySummary = new Map<string, Array<string>>();
  for (const [sourceKey, summaryId] of summarizedSourceKeys) {
    const replaced = replacedBySummary.get(String(summaryId));
    if (replaced === undefined) replacedBySummary.set(String(summaryId), [sourceKey]);
    else replaced.push(sourceKey);
  }
  const reusable = new Set<string>();
  const inRange = (summaryId: string, visiting: Set<string>): boolean => {
    if (reusable.has(summaryId)) return true;
    // A summary that (transitively) replaced itself records no history this
    // turn can check, so it fails closed rather than looping.
    if (visiting.has(summaryId)) return false;
    visiting.add(summaryId);
    const replaced = replacedBySummary.get(summaryId) ?? [];
    const covered =
      replaced.length > 0 &&
      replaced.every(
        (sourceKey) =>
          historySourceKeys.has(sourceKey) ||
          (sourceKey.startsWith(SUMMARY_SOURCE_KEY_PREFIX) &&
            inRange(sourceKey.slice(SUMMARY_SOURCE_KEY_PREFIX.length), visiting)),
      );
    visiting.delete(summaryId);
    if (covered) reusable.add(summaryId);
    return covered;
  };
  for (const summaryId of replacedBySummary.keys()) inRange(summaryId, new Set());
  return reusable;
}

/**
 * The blocks a plan actually sends, in request order.
 *
 * The plan is what this turn is journaled under, so the request has to be
 * derived from it rather than assembled beside it. An entry the plan omitted or
 * reserved is not part of this request, and a `summarized` one costs nothing
 * because the summary that replaced it carries the material instead — sending
 * either would put text in the request that the journaled plan says is not
 * there, and spend budget the plan did not account for.
 */
function dispatchedProviderContext(
  blocks: ReadonlyArray<{
    readonly entryId: ContextEntryId;
    readonly block: ProviderContextBlock;
  }>,
  plan: ContextPlan,
): ReadonlyArray<ProviderContextBlock> {
  const sent = new Set(
    plan.entries.flatMap((entry) =>
      entry.state === "omitted" || entry.state === "reserved" || entry.state === "summarized"
        ? []
        : [String(entry.entryId)],
    ),
  );
  return blocks.flatMap(({ entryId, block }) => (sent.has(String(entryId)) ? [block] : []));
}

export interface ChatAttachmentUploadInput {
  readonly threadId: ChatThreadId;
  readonly attachmentId: ChatAttachmentId;
  readonly displayName: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly signal?: AbortSignal;
}

interface ChatTurnContextPlan {
  readonly subject: ContextSubjectRef;
  readonly snapshot: ContextInspectorSnapshot;
  /**
   * Every block this turn could send, in request order and keyed by the context
   * entry it came from. Compaction replans the turn, so the dispatch has to be
   * rebuildable from a plan that is not the one these blocks were first
   * filtered by.
   */
  readonly providerBlocks: ReadonlyArray<{
    readonly entryId: ContextEntryId;
    readonly block: ProviderContextBlock;
  }>;
  readonly providerContext: ReadonlyArray<ProviderContextBlock>;
  /**
   * Canonical transcript text keyed by context entry, so context maintenance
   * can summarize exactly the conversation material the plan dropped without
   * re-reading the thread through a second path.
   */
  readonly conversationMaterial: ReadonlyArray<{
    readonly entryId: ContextEntryId;
    readonly content: string;
  }>;
}

interface PreparedChatTurn {
  /**
   * The thread as this turn actually runs it. Preparation can move a turn onto
   * the user's fallback route, and the attempt has to record the provider and
   * model the turn ran on rather than the one the thread selected.
   */
  readonly executionThread: ChatThread;
  readonly context: ChatTurnContextPlan;
  readonly attachments: ReadonlyArray<ProviderAttachmentInput>;
  readonly researchRoute: ResearchRouteDecision;
  readonly serviceLimits: ProviderServiceLimits;
  readonly appManagedTools?: AppManagedToolSet;
  readonly extensionSelections: ReadonlyArray<ExtensionSelection>;
}

export interface ChatServiceExecutionContext {
  readonly windowId: WindowId;
  /** One-hop coordination calls cannot expose the coordination tool again. */
  readonly coordinationDepth?: number;
}

interface PreparedChatContent {
  readonly reference: ChatContentReference;
  readonly input: {
    readonly contentId: string;
    readonly threadId: string;
    readonly role: "user" | "assistant" | "research" | "snippet";
    readonly body: string;
    readonly digest: string;
    readonly byteLength: number;
  };
}

export interface ChatServiceOptions {
  readonly persistence: PersistenceService;
  readonly dataDirectory: string;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly driver: (
    providerInstanceId: ReturnType<typeof decodeProviderInstanceId>,
  ) => ProviderDriver;
  readonly contextHarness: ContextHarnessService;
  readonly capacityScheduler: ProviderCapacityScheduler;
  readonly researchRouter: ResearchRouter;
  readonly threadWork: ThreadWorkService;
  readonly turnTimeoutMs?: number;
  /**
   * Deadline for the maintenance request that compacts a turn's dropped
   * conversation. The turn awaits it before dispatching the user's own
   * message, so it is bounded separately from the turn itself.
   */
  readonly contextMaintenanceTimeoutMs?: number;
  /**
   * Bound on the maintenance request's teardown, separate from the deadline on
   * the request itself. The user's send waits behind both.
   */
  readonly contextMaintenanceShutdownTimeoutMs?: number;
  readonly providerRuntimeRegistry?: ProviderRuntimeRegistryLike;
  readonly resolveAppManagedTools?: (input: {
    readonly windowId: WindowId;
    readonly thread: ChatThread;
    readonly threadMentionIds?: ReadonlyArray<MentionableThreadId>;
    readonly coordinationDepth?: number;
  }) => AppManagedToolSet | undefined;
  readonly resolveExtensionSelectionContext?: ChatExtensionSelectionContextResolver;
  /**
   * The native harness around a turn on a provider it drives: stable
   * instructions in front of the context, and the completed reply observed
   * for follow-ups and the advisor. Absent means turns run without it.
   */
  readonly nativeHarness?: {
    readonly contextFor: (scope: NativeHarnessTurnScope) => ReadonlyArray<ProviderContextBlock>;
    /** Absent means every turn is admitted. */
    readonly admitTurn?: (scope: NativeHarnessTurnScope) => NativeHarnessTurnAdmission;
    readonly turnStarted: (scope: NativeHarnessTurnScope) => void;
    readonly turnCompleted: (
      input: NativeHarnessTurnScope & {
        readonly text: string;
        readonly toolCalls: number;
        readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
        readonly contextSubject?: ContextSubjectRef;
      },
    ) => Promise<void>;
  };
  /**
   * Chat threads that are hidden sidecars. A Side Chat sidecar is an
   * ordinary Chat thread that must not appear in Recents, Unfiled, or Project
   * nesting; hiding it here rather than in the renderer means every client of
   * this host sees the same list, and the sidecar is still fully readable by
   * id from its Side Chat tab. Absent means nothing is hidden.
   */
  readonly hiddenThreadIds?: () => ReadonlySet<string>;
  /**
   * Resolves the source-thread context a Side Chat sidecar's turn runs with.
   *
   * A sidecar is a lane *about* another thread, so the thread it is about is
   * part of every one of its turns whether or not the user added a `#thread`
   * chip. The host owns that link and re-derives the principal's Open
   * authority over the source thread on every send, so the renderer can
   * neither name a different source nor widen what the sidecar may read.
   *
   * `undefined` means this thread is not a sidecar and the turn is ordinary
   * Chat. Absent option means this host records no sidecars at all.
   */
  readonly resolveSideChatSourceContext?: (input: {
    readonly sidecarThreadId: ChatThreadId;
    readonly windowId?: WindowId;
  }) => Promise<SideChatSourceContext | undefined>;
  /**
   * Resolves the `#thread` mentions a turn names.
   *
   * The command carries ids only. The host re-derives this send's principal
   * Open authority over each named thread and reads its bounded transcript
   * itself, so a mention contributes exactly what the sender may still read at
   * the moment they send — never a transcript the renderer resolved earlier,
   * and never one it composed. Resolution happens per turn, so nothing a
   * mention contributed is stored on the turn or replayed by the next one.
   */
  readonly resolveThreadMentionContext?: (input: {
    readonly threadMentionIds: ReadonlyArray<MentionableThreadId>;
    readonly windowId?: WindowId;
    readonly dialogueEnabled?: boolean;
  }) => Promise<ReadonlyArray<ChatThreadMentionContext>>;
  /**
   * Gathers per-candidate runtime facts for multi-model pool routing.
   * Injectable so tests can supply synthetic facts directly; the production
   * default probes each candidate's configured provider instance. Composer
   * capability selection is not yet supported, so `requiredCapabilities`
   * is always empty and `supportedCapabilities`/`costRank` are not yet
   * wired to real catalogs or accounting.
   */
  readonly issueContext?: GithubIssueContextPort;
  readonly linearIssueContext?: LinearIssueContextPort;
  readonly gatherMultiModelRuntimeFacts?: (input: {
    readonly pool: MultiModelPool;
    readonly mode: OctantMode;
    readonly activeHostId: HostId;
  }) => Promise<ReadonlyArray<MultiModelCandidateRuntimeFacts>>;
  /**
   * Reviewed context limits for models no provider reports limits for. Absent,
   * or empty, leaves the conservative built-in limits in place.
   */
  readonly reviewedModelManifest?: ReviewedModelManifest;
}

/**
 * What the host could resolve about a sidecar's source thread at send time.
 *
 * `unreadable` is deliberately not "no context": a Side Chat whose source
 * thread was deleted or is no longer openable by this principal must say so
 * rather than answer a question about that thread from nothing.
 */
export type SideChatSourceContext =
  | {
      readonly kind: "resolved";
      /** Framed, bounded, read-only transcript of the source thread. */
      readonly text: string;
    }
  | { readonly kind: "unreadable" };

/**
 * What the host could resolve about one `#thread` mention this turn names.
 *
 * `unreadable` is reported rather than dropped: the user's own message still
 * shows the chip they typed, so a mention the host refused must be stated as
 * unread instead of leaving the model to treat an absent thread as one it was
 * shown. It carries no title, mode, or placement, so a refused Open leaks
 * nothing beyond the opaque id the sender already had.
 */
export type ChatThreadMentionContext =
  | {
      readonly kind: "resolved";
      readonly threadId: MentionableThreadId;
      /** Framed, bounded, read-only transcript of the mentioned thread. */
      readonly text: string;
    }
  | { readonly kind: "unreadable"; readonly threadId: MentionableThreadId };

export interface ResolvedChatExtensionContextEntry {
  readonly contextEntry: ContextEntry;
  readonly providerContext?: ProviderContextBlock;
}

export type ChatExtensionSelectionContextResolver = (input: {
  readonly phase: "send" | "replay" | "resume" | "provider-handoff";
  readonly thread: ChatThread;
  readonly selections: ReadonlyArray<ExtensionSelection>;
  readonly windowId?: WindowId;
}) => Promise<{
  readonly selections: ReadonlyArray<ExtensionSelection>;
  readonly entries: ReadonlyArray<ResolvedChatExtensionContextEntry>;
  readonly toolSet?: AppManagedToolSet;
}>;

interface ProviderRuntimeRegistryLike {
  readonly setObservedState: (value: unknown) => ProviderObservedState;
}

export class ChatServiceError extends Error {
  override readonly name = "ChatServiceError";

  constructor(readonly failure: ChatFailure) {
    super(failure.message);
  }
}

export class ChatService {
  readonly #persistence: PersistenceService;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #driver: ChatServiceOptions["driver"];
  readonly #contextHarness: ContextHarnessService;
  readonly #capacityScheduler: ProviderCapacityScheduler;
  readonly #threadWork: ThreadWorkService;
  readonly #multiModelRoute: MultiModelRouteService;
  readonly #gatherMultiModelRuntimeFacts: NonNullable<
    ChatServiceOptions["gatherMultiModelRuntimeFacts"]
  >;
  readonly #attachmentStore: ChatAttachmentStore;
  readonly #scratchStore: ChatScratchStore;
  readonly #turnRunner: ChatTurnRunner;
  readonly #researchRouter: ResearchRouter;
  readonly #contextMaintenanceTimeoutMs?: number;
  readonly #contextMaintenanceShutdownTimeoutMs?: number;
  readonly #providerRuntimeRegistry?: ProviderRuntimeRegistryLike;
  readonly #resolveAppManagedTools?: ChatServiceOptions["resolveAppManagedTools"];
  readonly #nativeHarness?: ChatServiceOptions["nativeHarness"];
  readonly #resolveExtensionSelectionContext?: ChatExtensionSelectionContextResolver;
  readonly #hiddenThreadIds: () => ReadonlySet<string>;
  readonly #resolveSideChatSourceContext?: ChatServiceOptions["resolveSideChatSourceContext"];
  readonly #resolveThreadMentionContext?: ChatServiceOptions["resolveThreadMentionContext"];
  readonly #issueContext?: GithubIssueContextPort;
  readonly #linearIssueContext?: LinearIssueContextPort;
  readonly #reviewedModelManifest?: ReviewedModelManifest;
  readonly #activeAttempts = new Map<string, AbortController>();
  readonly #activeThreadExecutions = new Set<string>();
  readonly #threadAdmissions = new Map<string, Promise<void>>();

  constructor(options: ChatServiceOptions) {
    this.#persistence = options.persistence;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#driver = options.driver;
    this.#contextHarness = options.contextHarness;
    this.#capacityScheduler = options.capacityScheduler;
    this.#threadWork = options.threadWork;
    this.#multiModelRoute = new MultiModelRouteService({
      persistence: options.persistence,
      uuid: options.uuid,
      clock: options.clock,
    });
    this.#gatherMultiModelRuntimeFacts =
      options.gatherMultiModelRuntimeFacts ??
      ((input) => this.#probeMultiModelRuntimeFacts(input.pool));
    this.#attachmentStore = new ChatAttachmentStore(options.dataDirectory);
    this.#scratchStore = new ChatScratchStore(options.dataDirectory);
    this.#researchRouter = options.researchRouter;
    if (options.providerRuntimeRegistry !== undefined) {
      this.#providerRuntimeRegistry = options.providerRuntimeRegistry;
    }
    if (options.reviewedModelManifest !== undefined) {
      this.#reviewedModelManifest = options.reviewedModelManifest;
    }
    if (options.resolveAppManagedTools !== undefined) {
      this.#resolveAppManagedTools = options.resolveAppManagedTools;
    }
    this.#nativeHarness = options.nativeHarness;
    if (options.resolveExtensionSelectionContext !== undefined) {
      this.#resolveExtensionSelectionContext = options.resolveExtensionSelectionContext;
    }
    if (options.contextMaintenanceTimeoutMs !== undefined) {
      this.#contextMaintenanceTimeoutMs = options.contextMaintenanceTimeoutMs;
    }
    if (options.contextMaintenanceShutdownTimeoutMs !== undefined) {
      this.#contextMaintenanceShutdownTimeoutMs = options.contextMaintenanceShutdownTimeoutMs;
    }
    this.#hiddenThreadIds = options.hiddenThreadIds ?? (() => EMPTY_HIDDEN_THREAD_IDS);
    if (options.resolveSideChatSourceContext !== undefined) {
      this.#resolveSideChatSourceContext = options.resolveSideChatSourceContext;
    }
    if (options.resolveThreadMentionContext !== undefined) {
      this.#resolveThreadMentionContext = options.resolveThreadMentionContext;
    }
    if (options.issueContext !== undefined) {
      this.#issueContext = options.issueContext;
    }
    if (options.linearIssueContext !== undefined) {
      this.#linearIssueContext = options.linearIssueContext;
    }
    this.#turnRunner = new ChatTurnRunner({
      capacityScheduler: options.capacityScheduler,
      contextHarness: options.contextHarness,
      researchRouter: options.researchRouter,
      ...(options.turnTimeoutMs === undefined ? {} : { timeoutMs: options.turnTimeoutMs }),
    });
  }

  /**
   * Server-authoritative parent-turn multi-model pool routing. Returns
   * `undefined` when the thread has no opt-in pool (the ordinary
   * single-provider path is unaffected). When a pool is set, computes exactly
   * one route decision for `turnId` WITHOUT persisting it, and — only for a
   * "selected" decision — returns an `executionThread` with
   * `providerInstanceId`/`modelId` overridden to the selected candidate,
   * mirroring the existing retry/resume provider-handoff pattern. The
   * decision is durably committed by `#sendTurn` only when its parent turn is
   * accepted; a "waiting" decision is persisted as the actionable reason
   * before the command rejects. The thread's own persisted
   * provider/model are never mutated by routing, so a later pool change only
   * ever affects the next turn's resolution (the next safe execution
   * boundary).
   */
  async #computeTurnRouting(
    thread: ChatThread,
    turnId: ChatTurn["id"],
  ): Promise<
    undefined | { readonly decision: ChatTurnRouteDecision; readonly executionThread: ChatThread }
  > {
    const pool = thread.multiModelPool;
    if (pool === undefined) return undefined;

    const activeHostId = LOCAL_HOST_ID;
    const mode: OctantMode = "chat";
    // A disabled mixed-vendor pool remains bound to the thread's persisted
    // route.  Do not let the pool's arbitrary first candidate silently
    // become that route: a pool which omits it is invalid rather than an
    // authorization to hand the conversation to another provider.
    const inheritedCandidate = pool.candidates.find(
      (candidate) =>
        candidate.hostId === activeHostId &&
        String(candidate.providerInstanceId) === String(thread.providerInstanceId) &&
        String(candidate.modelId) === String(thread.modelId),
    );
    if (!pool.mixedVendorEnabled && inheritedCandidate === undefined) {
      throw new ChatServiceError(
        decodeChatFailure({
          category: "invalid",
          message:
            "A mixed-vendor-disabled pool must include the thread's current provider and model.",
        }),
      );
    }
    // The pool's first candidate is the request only where mixed routing is
    // enabled.  With it disabled, the persisted thread route is the parent.
    const parentCandidate = inheritedCandidate ?? pool.candidates[0];
    if (parentCandidate === undefined) {
      throw new ChatServiceError(
        decodeChatFailure({
          category: "invalid",
          message: "A multi-model pool must include at least one candidate.",
        }),
      );
    }
    const runtimeFacts = await this.#gatherMultiModelRuntimeFacts({ pool, mode, activeHostId });
    const parentFacts = runtimeFacts.find(
      (entry) => poolCandidateKey(entry.candidate) === poolCandidateKey(parentCandidate),
    );
    const parentRoutingVendorId =
      parentFacts?.routingVendorId ?? decodeMultiModelRoutingVendorId("unresolved-vendor");

    const decision = await this.#multiModelRoute.computeTurnRoute({
      threadId: thread.id,
      turnId,
      request: { pool, requiredCapabilities: [] },
      activeHostId,
      mode,
      parentRoutingVendorId,
      parentCandidate,
      runtimeFacts,
    });

    const executionThread: ChatThread =
      decision.decision.kind === "selected"
        ? threadAsRoutedFor(thread, decision.decision.selectedCandidate)
        : thread;

    return { decision, executionThread };
  }

  /**
   * Production per-candidate runtime-fact gatherer for multi-model pool
   * routing. Probes each candidate's configured provider instance the
   * same way single-provider Chat does, but never throws: an unconfigured,
   * disabled, or unreachable candidate is reported as ineligible runtime
   * facts rather than failing the whole resolution, so the pure policy
   * (`resolveMultiModelRoute`) can fail closed per-candidate. Composer
   * capability/cost selection is not yet supported, so
   * `supportedCapabilities` is always empty and `costRank` is always
   * undefined (documented residual — see the PR description).
   */
  async #probeMultiModelRuntimeFacts(
    pool: MultiModelPool,
  ): Promise<ReadonlyArray<MultiModelCandidateRuntimeFacts>> {
    const probes = new Map<string, Promise<ProviderProbeResult | undefined>>();
    const facts: Array<MultiModelCandidateRuntimeFacts> = [];
    for (const candidate of pool.candidates) {
      facts.push(await this.#probeOneMultiModelCandidate(candidate, probes));
    }
    return facts;
  }

  async #probeOneMultiModelCandidate(
    candidate: MultiModelPoolCandidate,
    probes: Map<string, Promise<ProviderProbeResult | undefined>>,
  ): Promise<MultiModelCandidateRuntimeFacts> {
    // Host authority is known from the candidate itself.  Never resolve a
    // local provider or call its probe for a candidate owned by another host.
    if (candidate.hostId !== LOCAL_HOST_ID) {
      return this.#ineligibleMultiModelCandidate(candidate, "foreign-host");
    }
    const providerInstanceId = decodeProviderInstanceId(candidate.providerInstanceId);
    const instance = this.#persistence.readProviderInstance(providerInstanceId);
    if (instance === undefined) {
      return {
        candidate,
        routingVendorId: decodeMultiModelRoutingVendorId("unconfigured"),
        configured: false,
        readiness: "unavailable",
        modelAvailable: false,
        compatibleModes: [],
        projectAllowed: true,
        profileAllowed: true,
        supportedCapabilities: [],
        authorityAllowed: false,
      };
    }
    const routingVendorId = decodeMultiModelRoutingVendorId(instance.driverKind);
    if (!instance.enabled) {
      // A disabled instance is ineligible without constructing its driver or
      // invoking probe(), which could spawn a CLI, touch credentials, or make
      // network requests before the authority failure is recorded.
      return {
        candidate,
        routingVendorId,
        configured: true,
        readiness: "unavailable",
        modelAvailable: false,
        compatibleModes: [],
        projectAllowed: true,
        profileAllowed: true,
        supportedCapabilities: [],
        authorityAllowed: false,
      };
    }
    try {
      let probePromise = probes.get(String(providerInstanceId));
      if (probePromise === undefined) {
        probePromise = this.#probeProvider(
          this.#driver(providerInstanceId),
          providerInstanceId,
        ).catch(() => undefined);
        probes.set(String(providerInstanceId), probePromise);
      }
      const probe = await probePromise;
      if (probe === undefined) throw new Error("Provider probe failed.");
      return {
        candidate,
        routingVendorId,
        configured: true,
        readiness: probe.readiness,
        modelAvailable: probe.models.some(
          (model) => String(model.id) === String(candidate.modelId),
        ),
        compatibleModes: ["chat"],
        projectAllowed: true,
        profileAllowed: true,
        supportedCapabilities: [],
        authorityAllowed: instance.enabled,
      };
    } catch {
      return {
        candidate,
        routingVendorId,
        configured: true,
        readiness: "unavailable",
        modelAvailable: false,
        compatibleModes: [],
        projectAllowed: true,
        profileAllowed: true,
        supportedCapabilities: [],
        authorityAllowed: instance.enabled,
      };
    }
  }

  #ineligibleMultiModelCandidate(
    candidate: MultiModelPoolCandidate,
    reason: "foreign-host",
  ): MultiModelCandidateRuntimeFacts {
    return {
      candidate,
      routingVendorId: decodeMultiModelRoutingVendorId(reason),
      configured: false,
      readiness: "unavailable",
      modelAvailable: false,
      compatibleModes: [],
      projectAllowed: true,
      profileAllowed: true,
      supportedCapabilities: [],
      authorityAllowed: false,
    };
  }

  async bootstrap(): Promise<ChatBootstrap> {
    this.#assertReady();
    const projected = this.#persistence.readChatSettings();
    const hidden = this.#hiddenThreadIds();
    return {
      settings: projected?.settings ?? this.#defaultChatSettings(),
      threads: this.#persistence
        .readChatThreads()
        .filter((thread) => thread.lifecycle === "active" && !hidden.has(String(thread.id)))
        .map((thread) => this.#withAggregateHeadVersion(thread)),
    };
  }

  navigation(): ChatNavigation {
    this.#assertReady();
    const hidden = this.#hiddenThreadIds();
    return {
      threads: this.#persistence
        .readChatNavigation()
        .filter((thread) => !hidden.has(String(thread.id)))
        .slice(0, MAX_CHAT_NAVIGATION_THREADS),
    };
  }

  search(query: string): ReadonlyArray<ChatThread> {
    this.#assertReady();
    const hidden = this.#hiddenThreadIds();
    return this.#persistence
      .searchChatThreads(query)
      .filter((thread) => !hidden.has(String(thread.id)))
      .map((thread) => this.#withAggregateHeadVersion(thread));
  }

  /**
   * Message-body search. Same listing authority as title search and bootstrap:
   * deleted threads stay out of the projection query, and hidden sidecars are
   * filtered here so a caller never learns they exist.
   */
  searchTranscript(query: string): ChatTranscriptSearch {
    this.#assertReady();
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return { query: "", hits: [], truncated: false };
    }
    if (trimmed.length > MAX_CHAT_TRANSCRIPT_SEARCH_QUERY_LENGTH) {
      throw new ChatServiceError({
        category: "invalid",
        message: "Chat transcript search query is too long.",
      });
    }
    const hidden = this.#hiddenThreadIds();
    return {
      query: trimmed,
      ...this.#persistence.searchChatTranscript(trimmed, hidden),
    };
  }

  read(threadId: ChatThreadId): ChatThreadView {
    this.#assertReadableThread(threadId);
    const view = this.#persistence.readChatThreadView(threadId);
    if (view === undefined) {
      throw new ChatServiceError({
        category: "invalid",
        message: "Chat thread was not found.",
      });
    }
    return {
      ...view,
      thread: this.#withAggregateHeadVersion(view.thread),
    };
  }

  async execute(
    input: unknown,
    executionContext?: ChatServiceExecutionContext,
  ): Promise<ChatCommandResult | ThreadWorkCommandResult> {
    try {
      this.#assertChatEnabled();
      if (this.#isThreadWorkCommand(input)) {
        return await this.#threadWork.execute(input);
      }
      const command = decodeChatCommand(input);
      switch (command.kind) {
        case "create-chat-thread":
          return await this.#createThread(command);
        case "rename-chat-thread":
        case "move-chat-thread":
        case "change-chat-thread-lifecycle":
        case "change-chat-provider":
        case "select-chat-multi-model-pool":
        case "change-chat-research":
        case "change-chat-instructions":
          return await this.#withThreadAdmission(command.threadId, () =>
            this.#updateThread(command),
          );
        case "update-chat-settings":
          return await this.#updateThread(command);
        case "send-chat-turn":
          return await this.#sendTurn(command, executionContext);
        case "edit-chat-turn":
          return await this.#editTurn(command, executionContext);
        case "branch-chat-thread":
          return await this.#withThreadAdmission(command.threadId, () =>
            this.#branchThread(command),
          );
        case "retry-chat-turn":
          return await this.#retryTurn(command, executionContext);
        case "resume-chat-turn":
          return await this.#resumeTurn(command, executionContext);
        case "interrupt-chat-turn":
          return await this.#interruptTurn(command);
        case "delete-chat-thread":
          return await this.#withThreadAdmission(command.threadId, () =>
            this.#requestDeletion(command),
          );
        default:
          throw new ChatServiceError({
            category: "invalid",
            message: "Chat command is not supported.",
          });
      }
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  async uploadAttachment(input: ChatAttachmentUploadInput): Promise<ChatAttachment> {
    this.#assertChatEnabled();
    const threadId = decodeChatThreadId(input.threadId);
    return await this.#withThreadAdmission(threadId, () => this.#uploadAttachment(input, threadId));
  }

  async #uploadAttachment(
    input: ChatAttachmentUploadInput,
    threadId: ChatThreadId,
  ): Promise<ChatAttachment> {
    this.#requireActiveThread(threadId);
    if (input.bytes.byteLength === 0) {
      throw new ChatServiceError({
        category: "invalid",
        message: "Attachment must not be empty.",
      });
    }
    const existing = this.#persistence.connection
      .prepare("SELECT thread_id FROM chat_attachment_projection WHERE attachment_id = ?")
      .get(String(input.attachmentId)) as { readonly thread_id: string } | undefined;
    if (existing !== undefined && String(existing.thread_id) !== String(threadId)) {
      throw new ChatServiceError({
        category: "invalid",
        message: "Chat attachment ID is already owned by another thread.",
      });
    }
    const staged = await this.#attachmentStore.stage({
      chatThreadId: threadId,
      chatAttachmentId: input.attachmentId,
      displayName: input.displayName,
      bytes: input.bytes,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const finalized = await this.#attachmentStore.finalize(staged);
    const attachment = decodeChatAttachment({
      id: finalized.chatAttachmentId,
      threadId,
      displayName: finalized.displayName,
      mediaType: input.mediaType,
      byteLength: finalized.size,
      digest: finalized.hash,
      status: "finalized",
      createdAt: decodeTimestamp(this.#clock()),
    });
    const version = readAggregateVersion(this.#persistence.connection, "chat-thread", threadId);
    try {
      this.#persistence.journal.append({
        aggregate: { aggregateType: "chat-thread", aggregateId: threadId },
        expectedVersion: version,
        events: [
          this.#pending("chat.attachment-updated@1", {
            kind: "attachment-updated",
            attachment,
          }),
        ],
      });
    } catch (error) {
      await this.#attachmentStore
        .remove(threadId, finalized.chatAttachmentId)
        .catch(() => undefined);
      throw error;
    }
    return attachment;
  }

  async readAttachment(
    threadId: ChatThreadId,
    attachmentId: ChatAttachmentId,
  ): Promise<Uint8Array> {
    this.#assertReadableThread(threadId);
    const row = this.#persistence.connection
      .prepare("SELECT attachment_json FROM chat_attachment_projection WHERE attachment_id = ?")
      .get(attachmentId) as { readonly attachment_json: string } | undefined;
    if (row === undefined) {
      throw new ChatServiceError({
        category: "invalid",
        message: "Chat attachment was not found.",
      });
    }
    const metadata = decodeChatAttachment(JSON.parse(row.attachment_json));
    if (String(metadata.threadId) !== String(threadId) || metadata.status !== "finalized") {
      throw new ChatServiceError({
        category: "invalid",
        message: "Chat attachment is not available.",
      });
    }
    return this.#attachmentStore.read({
      chatThreadId: threadId,
      chatAttachmentId: attachmentId,
      displayName: metadata.displayName,
      size: metadata.byteLength,
      hash: metadata.digest,
      finalizedAt: metadata.createdAt,
    });
  }

  async discardAttachment(
    rawThreadId: ChatThreadId,
    rawAttachmentId: ChatAttachmentId,
  ): Promise<ChatAttachment> {
    this.#assertChatEnabled();
    const threadId = decodeChatThreadId(rawThreadId);
    const attachmentId = decodeChatAttachmentId(rawAttachmentId);
    return await this.#withThreadAdmission(threadId, async () => {
      this.#requireActiveThread(threadId);
      const row = this.#persistence.connection
        .prepare("SELECT attachment_json FROM chat_attachment_projection WHERE attachment_id = ?")
        .get(String(attachmentId)) as { readonly attachment_json: string } | undefined;
      if (row === undefined) {
        throw new ChatServiceError({
          category: "invalid",
          message: "Chat attachment was not found.",
        });
      }
      const attachment = decodeChatAttachment(JSON.parse(row.attachment_json));
      if (String(attachment.threadId) !== String(threadId)) {
        throw new ChatServiceError({
          category: "invalid",
          message: "Chat attachment is not available.",
        });
      }
      if (attachment.status === "purged") return attachment;
      const referenced =
        this.#persistence
          .readChatThreadView(threadId)
          ?.turns.some((turn) =>
            turn.attachmentIds.some((id) => String(id) === String(attachmentId)),
          ) ?? false;
      if (referenced || attachment.turnId !== undefined) {
        throw new ChatServiceError({
          category: "invalid",
          message:
            "Sent Chat attachments are durable conversation evidence and cannot be discarded.",
        });
      }
      const purged = decodeChatAttachment({ ...attachment, status: "purged" });
      const version = readAggregateVersion(this.#persistence.connection, "chat-thread", threadId);
      this.#persistence.journal.append({
        aggregate: { aggregateType: "chat-thread", aggregateId: threadId },
        expectedVersion: version,
        events: [
          this.#pending("chat.attachment-updated@1", {
            kind: "attachment-updated",
            attachment: purged,
          }),
        ],
      });
      await this.#attachmentStore.remove(threadId, attachmentId).catch(() => undefined);
      return purged;
    });
  }

  async *subscribe(
    threadId: ChatThreadId,
    afterSequence: number,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEventFrame, number> {
    this.#assertReadableThread(threadId);
    let cursor = afterSequence;
    while (!signal?.aborted) {
      const events = this.#persistence.journal.replay(
        decodeReplayCursor({ afterSequence: cursor, limit: 100 }),
      );
      if (events.length === 0) break;
      for (const envelope of events) {
        cursor = envelope.globalSequence;
        if (!CHAT_EVENT_NAMES.has(envelope.eventName)) continue;
        const frame = this.#toEventFrame(threadId, envelope);
        if (frame === undefined) continue;
        yield frame;
      }
      if (events.length < 100) break;
    }
    // The last journal entry scanned, which is past any entries that belong to
    // other threads. A held stream that resumed from the last frame it sent
    // would otherwise re-read that unrelated tail on every wake.
    return cursor;
  }

  async finalizePendingDeletion(threadId: ChatThreadId): Promise<ChatCommandResult> {
    this.#assertReady();
    const thread = this.#persistence.readChatThread(threadId);
    if (thread === undefined) {
      throw new ChatServiceError({
        category: "invalid",
        message: "Chat thread was not found.",
      });
    }
    if (thread.lifecycle === "deleted") {
      return { kind: "deleted", threadId, deletedAt: thread.updatedAt };
    }
    if (thread.lifecycle !== "deleting") {
      throw new ChatServiceError({
        category: "invalid",
        message: "Chat thread is not awaiting purge.",
      });
    }
    const pending = this.#persistence.readPendingChatPurges();
    if (!pending.some((entry) => String(entry.threadId) === String(threadId))) {
      const existing = this.#persistence.readChatThread(threadId);
      if (existing?.lifecycle === "deleted") {
        return decodeChatPublicEvent({
          kind: "deleted",
          threadId,
          deletedAt: decodeTimestamp(this.#clock()),
        });
      }
    }
    await this.#attachmentStore.purgeThread(threadId);
    await this.#scratchStore.purge(threadId);
    purgeThreadContent(this.#persistence.connection, String(threadId));
    const deletedAt = decodeTimestamp(this.#clock());
    const version = readAggregateVersion(this.#persistence.connection, "chat-thread", threadId);
    this.#persistence.journal.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: threadId },
      expectedVersion: version,
      events: [
        this.#pending("chat.deleted@1", {
          kind: "deleted",
          threadId,
          deletedAt,
        }),
      ],
    });
    return { kind: "deleted", threadId, deletedAt };
  }

  async recoverPendingDeletions(): Promise<void> {
    for (const pending of this.#persistence.readPendingChatPurges()) {
      try {
        await this.finalizePendingDeletion(pending.threadId);
      } catch {
        // The durable deleting state keeps the thread inaccessible and retryable on next startup.
      }
    }
  }

  async reapStaleProviderSessions(input?: {
    readonly staleAfterMs?: number;
  }): Promise<{ readonly reaped: number; readonly resumable: number }> {
    const staleAfterMs = input?.staleAfterMs ?? 10 * 60 * 1_000;
    const now = Date.parse(this.#clock());
    let reaped = 0;
    let resumable = 0;
    for (const thread of this.#persistence.readChatThreads()) {
      let view: ChatThreadView | undefined;
      try {
        view = this.#persistence.readChatThreadView(thread.id);
      } catch {
        // One unreadable thread must not stop recovery of the others.
        continue;
      }
      if (view === undefined) continue;
      let version = readAggregateVersion(this.#persistence.connection, "chat-thread", thread.id);
      const reapAttempt = (attempt: ChatAttempt): void => {
        const disposition = reapsStaleProviderSession({
          attempt,
          ownedByThisProcess: this.#activeAttempts.has(String(attempt.id)),
          now,
          staleAfterMs,
        });
        if (disposition.kind === "retain") return;
        const interrupted = transitionChatAttempt(attempt, {
          outcome: "interrupted",
          updatedAt: decodeTimestamp(this.#clock()),
        });
        this.#persistence.journal.append({
          aggregate: { aggregateType: "chat-thread", aggregateId: thread.id },
          expectedVersion: version,
          events: [
            this.#pending("chat.attempt-updated@1", {
              kind: "attempt-updated",
              attempt: interrupted,
            }),
          ],
        });
        version = readAggregateVersion(this.#persistence.connection, "chat-thread", thread.id);
        reaped += 1;
        if (disposition.resumable) resumable += 1;
      };
      for (const turn of view.turns) {
        for (const attempt of turn.attempts) {
          try {
            reapAttempt(attempt);
          } catch (error) {
            if (!(error instanceof ConcurrencyConflict)) {
              // One unreapable attempt must not abort startup recovery.
              try {
                version = readAggregateVersion(
                  this.#persistence.connection,
                  "chat-thread",
                  thread.id,
                );
              } catch {
                // Keep the last known version for later attempts on this thread.
              }
              continue;
            }
            // Reread once in-process. A leftover streaming attempt otherwise
            // blocks new sends, and there is no later sweep.
            try {
              version = readAggregateVersion(
                this.#persistence.connection,
                "chat-thread",
                thread.id,
              );
              const latest = this.#persistence
                .readChatThreadView(thread.id)
                ?.turns.flatMap((candidateTurn) => candidateTurn.attempts)
                .find((candidate) => String(candidate.id) === String(attempt.id));
              if (latest === undefined) continue;
              reapAttempt(latest);
            } catch {
              // The next startup sweeps this attempt again.
            }
          }
        }
      }
    }
    return { reaped, resumable };
  }

  async recoverManagedAttachments(): Promise<void> {
    const rows = this.#persistence.connection
      .prepare("SELECT attachment_json FROM chat_attachment_projection")
      .all() as ReadonlyArray<{ readonly attachment_json: string }>;
    const attachments = rows.map((row) => decodeChatAttachment(JSON.parse(row.attachment_json)));
    const attachmentById = new Map(
      attachments.map((attachment) => [String(attachment.id), attachment] as const),
    );
    const referencedByThread = new Map<string, ReadonlySet<string>>();
    for (const attachment of attachments) {
      const key = String(attachment.threadId);
      if (referencedByThread.has(key)) continue;
      const referenced = new Set<string>();
      for (const turn of this.#persistence.readChatThreadView(attachment.threadId)?.turns ?? []) {
        for (const attachmentId of turn.attachmentIds) referenced.add(String(attachmentId));
      }
      referencedByThread.set(key, referenced);
    }
    const abandoned = attachments.filter(
      (attachment) =>
        attachment.status === "finalized" &&
        attachment.turnId === undefined &&
        !referencedByThread.get(String(attachment.threadId))?.has(String(attachment.id)),
    );
    await this.#attachmentStore.recover({
      isFinalizedAttachmentReferenced: (threadId, attachmentId) => {
        const attachment = attachmentById.get(String(attachmentId));
        return (
          attachment !== undefined &&
          String(attachment.threadId) === String(threadId) &&
          attachment.status === "finalized" &&
          (attachment.turnId !== undefined ||
            referencedByThread.get(String(threadId))?.has(String(attachmentId)) === true)
        );
      },
    });
    const abandonedByThread = new Map<string, ChatAttachment[]>();
    for (const attachment of abandoned) {
      const key = String(attachment.threadId);
      abandonedByThread.set(key, [...(abandonedByThread.get(key) ?? []), attachment]);
    }
    for (const grouped of abandonedByThread.values()) {
      const first = grouped[0];
      if (first === undefined || this.#persistence.readChatThread(first.threadId) === undefined) {
        continue;
      }
      const version = readAggregateVersion(
        this.#persistence.connection,
        "chat-thread",
        first.threadId,
      );
      this.#persistence.journal.append({
        aggregate: { aggregateType: "chat-thread", aggregateId: first.threadId },
        expectedVersion: version,
        events: grouped.map((attachment) =>
          this.#pending("chat.attachment-updated@1", {
            kind: "attachment-updated",
            attachment: decodeChatAttachment({ ...attachment, status: "purged" }),
          }),
        ),
      });
    }
  }

  async #createThread(
    command: Extract<ReturnType<typeof decodeChatCommand>, { kind: "create-chat-thread" }>,
  ): Promise<ChatCommandResult> {
    this.#assertReady();
    if (command.projectId !== undefined) {
      this.#assertActiveChatProject(command.projectId);
    }
    if (command.issueContext !== undefined && command.linearIssueContext !== undefined) {
      throw new ChatServiceError({
        category: "invalid",
        message: "Choose either a GitHub issue or a Linear issue, not both.",
      });
    }
    const preparedIssue = await prepareOptionalIssueContext(
      this.#issueContext,
      command.issueContext,
      new AbortController().signal,
    );
    if (preparedIssue.status === "refused") {
      throw new ChatServiceError({
        category: issueContextFailureCategory(preparedIssue.reason),
        message: preparedIssue.message,
      });
    }
    const preparedLinearIssue = await prepareOptionalLinearIssueContext(
      this.#linearIssueContext,
      command.linearIssueContext,
      new AbortController().signal,
    );
    if (preparedLinearIssue.status === "refused") {
      throw new ChatServiceError({
        category: linearIssueContextFailureCategory(preparedLinearIssue.reason),
        message: preparedLinearIssue.message,
      });
    }
    const settings = this.#requireChatSettings();
    const timestamp = decodeTimestamp(this.#clock());
    const thread = createChatThread({
      id: command.threadId ?? decodeChatThreadId(this.#uuid()),
      title: command.title,
      ...(command.projectId === undefined ? {} : { projectId: command.projectId }),
      providerInstanceId: settings.defaultProviderInstanceId,
      modelId: settings.defaultModelId,
      researchEnabled: settings.defaultResearchEnabled,
      researchRouting: settings.defaultResearchRouting,
      personalityInstructions: settings.defaultPersonalityInstructions,
      createdAt: timestamp,
    });
    await this.#scratchStore.acquire(thread.id);
    this.#persistence.journal.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: thread.id },
      expectedVersion: 0,
      events: [this.#pending("chat.thread-created@1", { kind: "thread-created", thread })],
    });
    if (preparedIssue.status === "ready" && command.issueContext !== undefined) {
      try {
        this.#issueContext?.bindCreatedThread({
          threadId: String(thread.id),
          framed: preparedIssue.framed,
          request: command.issueContext,
        });
      } catch {
        // The thread is already journaled; taint recording must not invert create.
      }
    }
    if (preparedLinearIssue.status === "ready" && command.linearIssueContext !== undefined) {
      try {
        this.#linearIssueContext?.bindCreatedThread({
          threadId: String(thread.id),
          framed: preparedLinearIssue.framed,
          request: command.linearIssueContext,
        });
      } catch {
        // The thread is already journaled; taint recording must not invert create.
      }
    }
    return { kind: "thread-created", thread };
  }

  async #updateThread(command: ReturnType<typeof decodeChatCommand>): Promise<ChatCommandResult> {
    this.#assertReady();
    const threadId = decodeChatThreadId(
      "threadId" in command ? command.threadId : CHAT_SETTINGS_AGGREGATE_ID,
    );
    if (command.kind === "update-chat-settings") {
      const timestamp = decodeTimestamp(this.#clock());
      let searxngBaseUrl: string | undefined;
      if (command.searxngBaseUrl !== undefined) {
        try {
          searxngBaseUrl = validateSearxngEndpoint(command.searxngBaseUrl).toString();
        } catch (error) {
          if (error instanceof SearxngEndpointRejected) {
            throw new ChatServiceError({ category: "invalid", message: error.message });
          }
          throw error;
        }
      }
      const selectedProviderInstanceId = command.defaultProviderInstanceId;
      const selectedModelId = command.defaultModelId;
      let selectedProbe: ProviderProbeResult | undefined;
      if (selectedProviderInstanceId !== undefined && selectedModelId !== undefined) {
        const instance = this.#persistence.readProviderInstance(selectedProviderInstanceId);
        if (instance === undefined || !instance.enabled) {
          throw new ChatServiceError({
            category: "unavailable",
            message: "The default Chat provider is unavailable.",
          });
        }
        const probe = await this.#probeProvider(
          this.#driver(selectedProviderInstanceId),
          selectedProviderInstanceId,
        );
        if (probe.readiness !== "ready") {
          // Allow degraded Foundry providers when the selected model is in the
          // catalog (manual deployment IDs remain available).
          const modelAvailable =
            probe.readiness === "degraded" &&
            probe.models.some((model) => String(model.id) === String(selectedModelId));
          if (!modelAvailable) {
            throw new ChatServiceError({
              category: probe.readiness === "unauthenticated" ? "unauthorized" : "unavailable",
              message: "The default Chat provider is not ready.",
            });
          }
        }
        if (!probe.models.some((model) => model.id === selectedModelId)) {
          throw new ChatServiceError({
            category: "invalid",
            message: "The default Chat model is unavailable.",
          });
        }
        selectedProbe = probe;
      }
      if (command.defaultResearchEnabled && selectedProbe === undefined) {
        throw new ChatServiceError({
          category: "unavailable",
          message: "Configure a default Chat provider and model before enabling research.",
        });
      }
      if (command.defaultResearchEnabled && selectedProbe !== undefined) {
        const route = this.#researchRouter.resolve({
          researchEnabled: true,
          routing: command.defaultResearchRouting,
          searxngConfigured: searxngBaseUrl !== undefined && searxngBaseUrl.trim().length > 0,
          appManagedTools:
            selectedModelId !== undefined
              ? this.#effectiveAppManagedTools(selectedProbe, selectedModelId)
              : selectedProbe.capabilities.appManagedTools,
          nativeResearch: selectedProbe.capabilities.nativeWebResearch,
        });
        if (route.kind === "unavailable") {
          throw new ChatServiceError(
            decodeChatFailure({
              category:
                route.reason === "app-managed-tools-unsupported" ||
                route.reason === "native-research-unsupported"
                  ? "unsupported"
                  : "unavailable",
              message: "Default Chat research is unavailable for the selected routing.",
            }),
          );
        }
      }
      const providerFallback = command.providerFallback;
      if (providerFallback !== undefined) {
        const fallbackInstance = this.#persistence.readProviderInstance(
          providerFallback.providerInstanceId,
        );
        if (fallbackInstance === undefined || !fallbackInstance.enabled) {
          throw new ChatServiceError({
            category: "unavailable",
            message: "The Chat fallback provider is unavailable.",
          });
        }
        // Reuse a probe already taken for this instance (the default provider)
        // rather than constructing a second driver. Exists and enabled is the
        // required gate; model presence is only checked when those facts are
        // already in hand.
        if (
          selectedProbe !== undefined &&
          selectedProviderInstanceId !== undefined &&
          String(selectedProviderInstanceId) === String(providerFallback.providerInstanceId) &&
          !selectedProbe.models.some(
            (model) => String(model.id) === String(providerFallback.modelId),
          )
        ) {
          throw new ChatServiceError({
            category: "invalid",
            message: "The Chat fallback model is unavailable.",
          });
        }
      }
      const settings = {
        ...(command.defaultProviderInstanceId === undefined
          ? {}
          : { defaultProviderInstanceId: command.defaultProviderInstanceId }),
        ...(command.defaultModelId === undefined ? {} : { defaultModelId: command.defaultModelId }),
        defaultResearchEnabled: command.defaultResearchEnabled,
        defaultResearchRouting: command.defaultResearchRouting,
        ...(searxngBaseUrl === undefined ? {} : { searxngBaseUrl }),
        defaultPersonalityInstructions: command.defaultPersonalityInstructions,
        ...(providerFallback === undefined ? {} : { providerFallback }),
        version: (command.expectedVersion + 1) as AggregateVersion,
        updatedAt: timestamp,
      } satisfies ChatSettings;
      this.#persistence.journal.append({
        aggregate: { aggregateType: "chat-settings", aggregateId: CHAT_SETTINGS_AGGREGATE_ID },
        expectedVersion: command.expectedVersion,
        events: [this.#pending("chat.settings-updated@1", { kind: "settings-updated", settings })],
      });
      return { kind: "settings-updated", settings };
    }

    const current =
      command.kind === "change-chat-thread-lifecycle"
        ? this.#requireLifecycleMutableThread(threadId)
        : this.#requireActiveThread(threadId);
    const timestamp = decodeTimestamp(this.#clock());
    let next = current;
    if (command.kind === "rename-chat-thread") {
      next = {
        ...current,
        title: command.title,
        version: (command.expectedVersion + 1) as AggregateVersion,
        updatedAt: timestamp,
      };
    } else if (command.kind === "move-chat-thread") {
      if (command.projectId !== undefined) {
        this.#assertActiveChatProject(command.projectId);
      }
      next = {
        ...current,
        projectId: command.projectId,
        version: (command.expectedVersion + 1) as AggregateVersion,
        updatedAt: timestamp,
      };
    } else if (command.kind === "change-chat-thread-lifecycle") {
      next =
        command.lifecycle === "archived"
          ? archiveChatThread(current, {
              expectedVersion: command.expectedVersion,
              updatedAt: timestamp,
            })
          : {
              ...current,
              lifecycle: command.lifecycle,
              version: (command.expectedVersion + 1) as AggregateVersion,
              updatedAt: timestamp,
            };
    } else if (command.kind === "change-chat-provider") {
      const providerInstanceId = decodeProviderInstanceId(command.providerInstanceId);
      const targetProbe = await this.#probeProvider(
        this.#driver(providerInstanceId),
        providerInstanceId,
      );
      if (targetProbe.readiness !== "ready") {
        // Allow degraded Foundry providers when the selected model is in the
        // catalog (manual deployment IDs remain available even when /models
        // did not confirm any configured deployment). The degraded state
        // honestly reflects the incomplete discovery, but Chat can still
        // proceed with the configured manual deployments.
        const modelAvailable =
          targetProbe.readiness === "degraded" &&
          targetProbe.models.some((candidate) => String(candidate.id) === String(command.modelId));
        if (!modelAvailable) {
          throw new ChatServiceError(
            decodeChatFailure({
              category:
                targetProbe.readiness === "unauthenticated"
                  ? "unauthorized"
                  : targetProbe.readiness === "incompatible"
                    ? "unsupported"
                    : "unavailable",
              message: "Selected provider is not ready for Chat.",
            }),
          );
        }
      }
      const selectedModel = targetProbe.models.find(
        (model) => String(model.id) === String(command.modelId),
      );
      const changed = changeChatProvider(current, {
        providerInstanceId,
        modelId: command.modelId,
        expectedVersion: command.expectedVersion,
        updatedAt: timestamp,
        availableModels: targetProbe.models.map((model) => model.id),
        modelOptions: selectedModel?.options ?? [],
        ...(command.modelOptionValues === undefined
          ? {}
          : { modelOptionValues: command.modelOptionValues }),
      });
      const omissions = this.#historicalAttachmentOmissions(current, targetProbe, command.modelId);
      const { handoffWarning: _previousWarning, ...withoutPreviousWarning } = changed;
      next = decodeChatThread({
        ...withoutPreviousWarning,
        ...(omissions.length === 0
          ? {}
          : {
              handoffWarning: {
                targetProviderInstanceId: providerInstanceId,
                targetModelId: command.modelId,
                omittedAttachments: omissions as ChatHandoffWarning["omittedAttachments"],
                createdAt: timestamp,
              },
            }),
      });
    } else if (command.kind === "select-chat-multi-model-pool") {
      // Data-layer seam only: selects/clears the thread's opt-in
      // multi-model pool. Per-candidate eligibility (readiness, mode,
      // Project, authority, capability, vendor, and cost policy) is
      // evaluated fresh for each parent turn by resolveMultiModelRoute, not
      // here, so this command performs no provider probing of its own.
      if (command.pool !== undefined) {
        // Narrow-only guard: when Settings define a default
        // agent-eligible pool, a composer selection may only narrow it —
        // never widen it. Clearing the pool (single-model restoration) is
        // always allowed, and absent defaults keep the behaviour
        // where per-turn eligibility alone fail-closes each candidate.
        const eligibleDefaults = this.#persistence.readProviderDefaults().agentEligibleModels;
        if (eligibleDefaults !== undefined) {
          const eligibleKeys = new Set(
            eligibleDefaults.map((ref) => `${ref.providerInstanceId}:${ref.modelId}`),
          );
          const widening = command.pool.candidates.some(
            (candidate) =>
              !eligibleKeys.has(`${candidate.providerInstanceId}:${candidate.modelId}`),
          );
          if (widening) {
            throw new ChatServiceError({
              category: "invalid",
              message:
                "Multi-model pool selection can only narrow the agent-eligible models defined in Provider Settings.",
            });
          }
        }
      }
      next = decodeChatThread({
        ...current,
        ...(command.pool === undefined ? {} : { multiModelPool: command.pool }),
        version: (command.expectedVersion + 1) as AggregateVersion,
        updatedAt: timestamp,
      });
      if (command.pool === undefined) {
        const { multiModelPool: _clearedPool, ...withoutPool } = next;
        next = decodeChatThread(withoutPool);
      }
    } else if (command.kind === "change-chat-research") {
      next = changeChatResearch(current, {
        researchEnabled: command.researchEnabled,
        researchRouting: command.researchRouting,
        expectedVersion: command.expectedVersion,
        updatedAt: timestamp,
      });
    } else if (command.kind === "change-chat-instructions") {
      next = {
        ...current,
        personalityInstructions: command.personalityInstructions,
        version: (command.expectedVersion + 1) as AggregateVersion,
        updatedAt: timestamp,
      };
    } else {
      throw new ChatServiceError({
        category: "invalid",
        message: "Chat command is not supported.",
      });
    }
    this.#persistence.journal.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: threadId },
      expectedVersion: command.expectedVersion,
      events: [this.#pending("chat.thread-updated@1", { kind: "thread-updated", thread: next })],
    });
    return { kind: "thread-updated", thread: next };
  }

  /** A paused harness session refuses a new prompt, whether sent or edited in. */
  #admitHarnessTurn(thread: ChatThread): void {
    const admission = this.#nativeHarness?.admitTurn?.({
      threadId: String(thread.id),
      mode: "chat",
      providerInstanceId: decodeProviderInstanceId(thread.providerInstanceId),
      modelId: decodeProviderModelId(thread.modelId),
      ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
    });
    if (admission?.kind === "paused") {
      throw new ChatServiceError(
        decodeChatFailure({
          category: "waiting",
          message: `${admission.status === "paused-by-advisor" ? "The advisor paused this thread" : "This thread is paused"}: ${admission.detail} Resume the harness session to continue.`,
        }),
      );
    }
  }

  async #sendTurn(
    command: Extract<ReturnType<typeof decodeChatCommand>, { kind: "send-chat-turn" }>,
    executionContext?: ChatServiceExecutionContext,
  ): Promise<ChatCommandResult> {
    const accepted = await this.#withThreadAdmission(command.threadId, async () => {
      const thread = this.#requireActiveThread(command.threadId);
      this.#admitHarnessTurn(thread);
      if (command.submissionId !== undefined) {
        // Match on submissionId alone. A turn whose only attempt ended
        // failed, cancelled, or interrupted is still the turn this
        // submission already created — excluding those outcomes let a
        // retried send with the same submissionId fall through to turn
        // creation and mint a second turn under the same submission
        // identity.
        const existing = [...(this.#persistence.readChatThreadView(thread.id)?.turns ?? [])]
          .reverse()
          .find((candidate) => String(candidate.submissionId) === String(command.submissionId));
        if (existing !== undefined) {
          const content = this.#persistence.readChatContent(
            String(existing.userMessageRef.contentId),
          );
          if (content === undefined || content.body !== command.prompt) {
            throw new ChatServiceError(
              decodeChatFailure({
                category: "invalid",
                message: "Chat submission identity was reused for different message text.",
              }),
            );
          }
          return { kind: "existing" as const, turn: existing };
        }
      }
      this.#assertExpectedThreadVersion(thread, command.expectedVersion);
      const timestamp = decodeTimestamp(this.#clock());
      const userMessage = this.#prepareContent(thread.id, "user", command.prompt);
      const userMessageRef = userMessage.reference;
      const view = this.#persistence.readChatThreadView(thread.id);
      this.#assertNoActiveTurn(view, thread.id);
      const sequence = (view?.turns.length ?? 0) + 1;
      const turnId = this.#uuid() as ChatTurn["id"];
      // Extension selection checks can reject disabled/revoked extensions.
      // Resolve them before route gathering because a provider probe can touch
      // a CLI, credentials, or network.  Preparation reuses these approved
      // facts after route resolution rather than resolving them twice.
      const resolvedExtensions = await this.#resolveExtensionContext(
        thread,
        command.extensionSelections,
        "send",
        executionContext?.windowId,
      );
      const routing = await this.#computeTurnRouting(thread, turnId);
      if (routing !== undefined && routing.decision.decision.kind === "waiting") {
        // Durably recorded as the actionable Waiting reason (chat-turn-route
        // aggregate) before any chat-thread turn/attempt is created, so no
        // eligible route still produces a durable actionable Waiting reason.
        // A Waiting parent route never produces a turn.
        await this.#multiModelRoute.persistTurnRoute(routing.decision);
        throw new ChatServiceError(
          decodeChatFailure({
            category: "waiting",
            message: routing.decision.decision.message,
          }),
        );
      }
      const executionThread = routing?.executionThread ?? thread;
      const prepared = await this.#prepareTurnExecution(
        executionThread,
        command.prompt,
        userMessageRef,
        command.attachmentIds,
        command.previewSelections,
        command.canvasSelections,
        command.threadMentionIds,
        command.extensionSelections,
        "send",
        executionContext,
        resolvedExtensions,
      );
      const attachmentIds = command.attachmentIds;
      const turn = beginChatTurn(prepared.executionThread, {
        turnId,
        ...(command.submissionId === undefined ? {} : { submissionId: command.submissionId }),
        attemptId: this.#uuid() as ChatAttempt["id"],
        providerSessionId: decodeProviderSessionId(this.#uuid()),
        contextManifestId: prepared.context.snapshot.next.manifest.id,
        userMessageRef,
        ...(attachmentIds !== undefined && attachmentIds.length > 0 ? { attachmentIds } : {}),
        ...(prepared.extensionSelections.length === 0
          ? {}
          : {
              extensionSelections: prepared.extensionSelections.map((selection) => ({
                ...selection,
                origin: { kind: "turn" as const, reference: String(turnId) },
              })),
            }),
        sequence,
        expectedVersion: command.expectedVersion,
        createdAt: timestamp,
      });
      const updatedThread = {
        ...thread,
        version: (command.expectedVersion + 1) as AggregateVersion,
        updatedAt: timestamp,
      };
      this.#persistence.journal.append(
        {
          aggregate: { aggregateType: "chat-thread", aggregateId: thread.id },
          expectedVersion: command.expectedVersion,
          events: [
            this.#pending("chat.thread-updated@1", {
              kind: "thread-updated",
              thread: updatedThread,
            }),
            this.#pending("chat.turn-created@1", { kind: "turn-created", turn }),
            ...(routing !== undefined && routing.decision.decision.kind === "selected"
              ? [
                  this.#pending("chat.turn-route-decided@1", {
                    kind: "turn-route-decided",
                    decision: routing.decision,
                  }),
                ]
              : []),
          ],
        },
        { beforeEvents: (connection) => this.#writePreparedContent(connection, userMessage) },
      );
      return {
        kind: "accepted" as const,
        thread: updatedThread,
        turn,
        attempt: turn.attempts[0]!,
        prepared,
      };
    });
    if (accepted.kind === "existing") return { kind: "turn-created", turn: accepted.turn };
    await this.#runAttempt({
      thread: threadAsRoutedFor(accepted.thread, accepted.attempt),
      turn: accepted.turn,
      attempt: accepted.attempt,
      prompt: command.prompt,
      prepared: accepted.prepared,
    });
    return { kind: "turn-created", turn: accepted.turn };
  }

  /**
   * Revise an earlier user message and re-run the thread from that point.
   *
   * Nothing is rewritten or deleted. The revised turn, its attempts, and every
   * turn that followed it stay journaled exactly as they were; the edit appends
   * a new turn that names the revised one in `supersedes`. The re-run is asked
   * to continue from the conversation as it stood *before* the revised message,
   * so the superseded exchange never leaks back into context.
   *
   * Provider, model, and Project scope come from the server's copy of the
   * thread, so an edit can neither widen authority nor silently re-route, and
   * `expectedVersion` is checked here before any side effect, so an edit
   * computed against a stale transcript is refused rather than applied.
   */
  async #editTurn(
    command: Extract<ReturnType<typeof decodeChatCommand>, { kind: "edit-chat-turn" }>,
    executionContext?: ChatServiceExecutionContext,
  ): Promise<ChatCommandResult> {
    const accepted = await this.#withThreadAdmission(command.threadId, async () => {
      const thread = this.#requireActiveThread(command.threadId);
      this.#admitHarnessTurn(thread);
      this.#assertExpectedThreadVersion(thread, command.expectedVersion);
      const view = this.#requireThreadView(command.threadId);
      this.#assertNoActiveTurn(view, thread.id);
      const through = chatTurnsThrough(view.turns, command.turnId);
      if (through === undefined) {
        throw new ChatServiceError({
          category: "invalid",
          message: "Chat turn is not part of the active conversation.",
        });
      }
      const revised = through[through.length - 1]!;
      const history = through.slice(0, -1);
      const timestamp = decodeTimestamp(this.#clock());
      const userMessage = this.#prepareContent(thread.id, "user", command.prompt);
      const userMessageRef = userMessage.reference;
      const sequence = view.turns.length + 1;
      const turnId = this.#uuid() as ChatTurn["id"];
      // The revised turn's own extension selections are re-resolved, not
      // trusted: a selection that was revoked since the original send must
      // fail closed here exactly as it does on a fresh send.
      const resolvedExtensions = await this.#resolveExtensionContext(
        thread,
        revised.extensionSelections,
        "send",
        executionContext?.windowId,
      );
      const routing = await this.#computeTurnRouting(thread, turnId);
      if (routing !== undefined && routing.decision.decision.kind === "waiting") {
        await this.#multiModelRoute.persistTurnRoute(routing.decision);
        throw new ChatServiceError(
          decodeChatFailure({
            category: "waiting",
            message: routing.decision.decision.message,
          }),
        );
      }
      const executionThread = routing?.executionThread ?? thread;
      const prepared = await this.#prepareTurnExecution(
        executionThread,
        command.prompt,
        userMessageRef,
        revised.attachmentIds,
        undefined,
        undefined,
        undefined,
        revised.extensionSelections,
        "send",
        executionContext,
        resolvedExtensions,
        history,
      );
      const turn = beginChatTurn(prepared.executionThread, {
        turnId,
        attemptId: this.#uuid() as ChatAttempt["id"],
        providerSessionId: decodeProviderSessionId(this.#uuid()),
        contextManifestId: prepared.context.snapshot.next.manifest.id,
        userMessageRef,
        ...(revised.attachmentIds.length === 0 ? {} : { attachmentIds: revised.attachmentIds }),
        ...(prepared.extensionSelections.length === 0
          ? {}
          : {
              extensionSelections: prepared.extensionSelections.map((selection) => ({
                ...selection,
                origin: { kind: "turn" as const, reference: String(turnId) },
              })),
            }),
        supersedes: revised.id,
        sequence,
        expectedVersion: command.expectedVersion,
        createdAt: timestamp,
      });
      const updatedThread = {
        ...thread,
        version: (command.expectedVersion + 1) as AggregateVersion,
        updatedAt: timestamp,
      };
      this.#persistence.journal.append(
        {
          aggregate: { aggregateType: "chat-thread", aggregateId: thread.id },
          expectedVersion: command.expectedVersion,
          events: [
            this.#pending("chat.thread-updated@1", {
              kind: "thread-updated",
              thread: updatedThread,
            }),
            this.#pending("chat.turn-created@1", { kind: "turn-created", turn }),
            ...(routing !== undefined && routing.decision.decision.kind === "selected"
              ? [
                  this.#pending("chat.turn-route-decided@1", {
                    kind: "turn-route-decided",
                    decision: routing.decision,
                  }),
                ]
              : []),
          ],
        },
        { beforeEvents: (connection) => this.#writePreparedContent(connection, userMessage) },
      );
      return { thread: updatedThread, turn, attempt: turn.attempts[0]!, prepared };
    });
    await this.#runAttempt({
      thread: threadAsRoutedFor(accepted.thread, accepted.attempt),
      turn: accepted.turn,
      attempt: accepted.attempt,
      prompt: command.prompt,
      prepared: accepted.prepared,
    });
    return { kind: "turn-created", turn: accepted.turn };
  }

  /**
   * Start a second Chat thread carrying this thread's conversation through one
   * turn, so the same conversation can be taken in a second direction without
   * disturbing the first.
   *
   * The branch is created as an ordinary Chat thread in one journal append: its
   * creation, its carried turns, and its settled version commit together, so a
   * crash cannot leave a half-seeded branch. Provider, model, Project scope,
   * research settings, and instructions are copied from the server's copy of
   * the source thread — the command cannot choose them — so a branch can never
   * widen authority or escape the source thread's Project.
   *
   * A branch carries message text only. Attachments stay bound to the source
   * thread and are counted in `branchedFrom.omittedAttachmentCount` rather than
   * silently dropped, and only completed attempts with readable response
   * content are carried, so the branch never shows an exchange that did not
   * happen.
   */
  async #branchThread(
    command: Extract<ReturnType<typeof decodeChatCommand>, { kind: "branch-chat-thread" }>,
  ): Promise<ChatCommandResult> {
    this.#assertReady();
    const source = this.#requireActiveThread(command.threadId);
    this.#assertExpectedThreadVersion(source, command.expectedVersion);
    if (source.projectId !== undefined) this.#assertActiveChatProject(source.projectId);
    const view = this.#requireThreadView(command.threadId);
    this.#assertNoActiveTurn(view, source.id);
    const carried = chatTurnsThrough(view.turns, command.turnId);
    if (carried === undefined) {
      throw new ChatServiceError({
        category: "invalid",
        message: "Chat turn is not part of the active conversation.",
      });
    }
    const branchThreadId = command.branchThreadId ?? decodeChatThreadId(this.#uuid());
    if (
      String(branchThreadId) === String(source.id) ||
      this.#persistence.readChatThread(branchThreadId) !== undefined
    ) {
      throw new ChatServiceError({
        category: "invalid",
        message: "Chat branch thread ID is already in use.",
      });
    }

    const contentById = new Map(
      view.contents.map((content) => [String(content.contentId), content]),
    );
    const timestamp = decodeTimestamp(this.#clock());
    const copiedContent: PreparedChatContent[] = [];
    const branchTurns: ChatTurn[] = [];
    let omittedAttachmentCount = 0;
    for (const sourceTurn of carried) {
      const userContent = contentById.get(String(sourceTurn.userMessageRef.contentId));
      if (userContent === undefined) {
        throw new ChatServiceError({
          category: "unavailable",
          message: "Chat turn content is unavailable.",
        });
      }
      omittedAttachmentCount += sourceTurn.attachmentIds.length;
      const turnId = this.#uuid() as ChatTurn["id"];
      const userMessage = this.#prepareContent(branchThreadId, "user", userContent.body);
      copiedContent.push(userMessage);
      const attempts: ChatAttempt[] = [];
      for (const attempt of sourceTurn.attempts) {
        if (attempt.outcome !== "completed") continue;
        const responses = attempt.responseRefs.map((reference) =>
          contentById.get(String(reference.contentId)),
        );
        const definedResponses = responses.filter(
          (content): content is NonNullable<typeof content> => content !== undefined,
        );
        if (definedResponses.length === 0 || definedResponses.length !== responses.length) continue;
        const copiedResponses = definedResponses.map((content) =>
          this.#prepareContent(branchThreadId, "assistant", content.body),
        );
        copiedContent.push(...copiedResponses);
        attempts.push(
          decodeChatAttempt({
            id: this.#uuid(),
            turnId,
            threadId: branchThreadId,
            providerInstanceId: attempt.providerInstanceId,
            // The provider session and context manifest are the source
            // attempt's real identifiers, kept so the copy points at what
            // actually happened instead of inventing a session of its own.
            providerSessionId: attempt.providerSessionId,
            modelId: attempt.modelId,
            contextManifestId: attempt.contextManifestId,
            outcome: "completed",
            responseRefs: copiedResponses.map((content) => content.reference),
            citationIds: [],
            createdAt: attempt.createdAt,
            updatedAt: attempt.updatedAt,
          }),
        );
      }
      branchTurns.push(
        decodeChatTurn({
          id: turnId,
          threadId: branchThreadId,
          sequence: branchTurns.length + 1,
          userMessageRef: userMessage.reference,
          attachmentIds: [],
          attempts,
          createdAt: sourceTurn.createdAt,
        }),
      );
    }

    const branch = createChatThread({
      id: branchThreadId,
      title: command.title,
      ...(source.projectId === undefined ? {} : { projectId: source.projectId }),
      providerInstanceId: source.providerInstanceId,
      modelId: source.modelId,
      // The branch runs the same model, so it keeps the settings the person
      // chose for it rather than silently reverting to provider defaults.
      ...(source.modelOptionValues === undefined
        ? {}
        : { modelOptionValues: source.modelOptionValues }),
      researchEnabled: source.researchEnabled,
      researchRouting: source.researchRouting,
      personalityInstructions: source.personalityInstructions,
      branchedFrom: {
        threadId: source.id,
        turnId: command.turnId,
        sourceVersion: command.expectedVersion,
        carriedTurnCount: branchTurns.length,
        omittedAttachmentCount,
        branchedAt: timestamp,
      },
      createdAt: timestamp,
    });
    const settled = decodeChatThread({
      ...branch,
      version: (branchTurns.length + 2) as AggregateVersion,
      updatedAt: timestamp,
    });
    await this.#scratchStore.acquire(branch.id);
    this.#persistence.journal.append(
      {
        aggregate: { aggregateType: "chat-thread", aggregateId: branch.id },
        expectedVersion: 0,
        events: [
          this.#pending("chat.thread-created@1", { kind: "thread-created", thread: branch }),
          ...branchTurns.map((turn) =>
            this.#pending("chat.turn-created@1", { kind: "turn-created", turn }),
          ),
          this.#pending("chat.thread-updated@1", { kind: "thread-updated", thread: settled }),
        ],
      },
      {
        beforeEvents: (connection) => {
          for (const content of copiedContent) this.#writePreparedContent(connection, content);
        },
      },
    );
    return { kind: "thread-created", thread: settled };
  }

  async #retryTurn(
    command: Extract<ReturnType<typeof decodeChatCommand>, { kind: "retry-chat-turn" }>,
    executionContext?: ChatServiceExecutionContext,
  ): Promise<ChatCommandResult> {
    const accepted = await this.#withThreadAdmission(command.threadId, async () => {
      const thread = this.#requireActiveThread(command.threadId);
      this.#assertExpectedThreadVersion(thread, command.expectedVersion);
      const view = this.#requireThreadView(command.threadId);
      this.#assertNoActiveTurn(view, thread.id);
      const turn = view.turns.find((candidate) => String(candidate.id) === String(command.turnId));
      const attempt = turn?.attempts.find(
        (candidate) => String(candidate.id) === String(command.attemptId),
      );
      if (turn === undefined || attempt === undefined) {
        throw new ChatServiceError({
          category: "invalid",
          message: "Chat attempt was not found.",
        });
      }
      if (chatTurnsThrough(view.turns, command.turnId) === undefined) {
        // The turn was revised: re-running it would send a prompt the user has
        // already replaced, against a conversation that no longer leads to it.
        throw new ChatServiceError({
          category: "invalid",
          message: "Chat turn is not part of the active conversation.",
        });
      }
      if (attempt.outcome !== "failed" && attempt.outcome !== "interrupted") {
        throw new ChatServiceError(
          decodeChatFailure({
            category: "invalid",
            message: `Cannot retry an attempt that is ${attempt.outcome}`,
          }),
        );
      }
      const timestamp = decodeTimestamp(this.#clock());
      const content = this.#persistence.readChatContent(String(turn.userMessageRef.contentId));
      if (content === undefined) {
        throw new ChatServiceError(
          decodeChatFailure({
            category: "unavailable",
            message: "Chat turn content is unavailable.",
          }),
        );
      }
      const prompt = content.body;
      const retryExecutionThread: ChatThread = {
        ...thread,
        providerInstanceId: attempt.providerInstanceId,
        modelId: attempt.modelId,
      };
      const prepared = await this.#prepareTurnExecution(
        retryExecutionThread,
        prompt,
        turn.userMessageRef,
        turn.attachmentIds,
        undefined,
        undefined,
        undefined,
        turn.extensionSelections,
        "replay",
        executionContext,
      );
      const nextAttempt = retryChatTurn(thread, attempt, {
        turnId: command.turnId,
        attemptId: command.attemptId,
        newAttemptId: this.#uuid() as ChatAttempt["id"],
        newProviderSessionId: decodeProviderSessionId(this.#uuid()),
        newContextManifestId: prepared.context.snapshot.next.manifest.id,
        expectedVersion: command.expectedVersion,
        createdAt: timestamp,
      });
      const updatedTurn: ChatTurn = { ...turn, attempts: [...turn.attempts, nextAttempt] };
      const updatedThread = {
        ...thread,
        version: (command.expectedVersion + 1) as AggregateVersion,
        updatedAt: timestamp,
      };
      this.#persistence.journal.append({
        aggregate: { aggregateType: "chat-thread", aggregateId: thread.id },
        expectedVersion: command.expectedVersion,
        events: [
          this.#pending("chat.thread-updated@1", { kind: "thread-updated", thread: updatedThread }),
          this.#pending("chat.attempt-updated@1", {
            kind: "attempt-updated",
            attempt: nextAttempt,
          }),
        ],
      });
      return { thread: updatedThread, turn: updatedTurn, attempt: nextAttempt, prompt, prepared };
    });
    await this.#runAttempt({
      thread: threadAsRoutedFor(accepted.thread, accepted.attempt),
      turn: accepted.turn,
      attempt: accepted.attempt,
      prompt: accepted.prompt,
      prepared: accepted.prepared,
    });
    return { kind: "attempt-updated", attempt: accepted.attempt };
  }

  async #resumeTurn(
    command: Extract<ReturnType<typeof decodeChatCommand>, { kind: "resume-chat-turn" }>,
    executionContext?: ChatServiceExecutionContext,
  ): Promise<ChatCommandResult> {
    const accepted = await this.#withThreadAdmission(command.threadId, async () => {
      const thread = this.#requireActiveThread(command.threadId);
      this.#assertExpectedThreadVersion(thread, command.expectedVersion);
      const view = this.#requireThreadView(command.threadId);
      this.#assertNoActiveTurn(view, thread.id);
      const turn = view.turns.find((candidate) => String(candidate.id) === String(command.turnId));
      const attempt = turn?.attempts.find(
        (candidate) => String(candidate.id) === String(command.attemptId),
      );
      if (turn === undefined || attempt === undefined) {
        throw new ChatServiceError({
          category: "invalid",
          message: "Chat attempt was not found.",
        });
      }
      if (chatTurnsThrough(view.turns, command.turnId) === undefined) {
        throw new ChatServiceError({
          category: "invalid",
          message: "Chat turn is not part of the active conversation.",
        });
      }
      if (attempt.outcome !== "waiting" && attempt.outcome !== "interrupted") {
        throw new ChatServiceError(
          decodeChatFailure({
            category: "invalid",
            message: `Cannot resume an attempt that is ${attempt.outcome}`,
          }),
        );
      }
      if (attempt.resumeCursor === undefined) {
        throw new ChatServiceError(
          decodeChatFailure({
            category: "invalid",
            message: "Chat attempt has no provider resume cursor.",
          }),
        );
      }
      // Validate extension selection authority BEFORE any provider probe,
      // credential, attachment, app-tool, or context work. Selection
      // revalidation on resume must fail closed before context, tools,
      // credentials, or provider side effects when a persisted extension
      // selection drifted.
      if (turn.extensionSelections !== undefined && turn.extensionSelections.length > 0) {
        await this.#resolveExtensionContext(thread, turn.extensionSelections, "resume");
      }
      const timestamp = decodeTimestamp(this.#clock());
      const content = this.#persistence.readChatContent(String(turn.userMessageRef.contentId));
      if (content === undefined) {
        throw new ChatServiceError(
          decodeChatFailure({
            category: "unavailable",
            message: "Chat turn content is unavailable.",
          }),
        );
      }
      const prompt = content.body;
      const resumeExecutionThread: ChatThread = {
        ...thread,
        providerInstanceId: attempt.providerInstanceId,
        modelId: attempt.modelId,
      };
      const prepared = await this.#prepareTurnExecution(
        resumeExecutionThread,
        prompt,
        turn.userMessageRef,
        turn.attachmentIds,
        undefined,
        undefined,
        undefined,
        turn.extensionSelections,
        "resume",
        executionContext,
      );
      const nextAttempt = resumeChatTurn(thread, attempt, {
        turnId: command.turnId,
        attemptId: command.attemptId,
        newAttemptId: this.#uuid() as ChatAttempt["id"],
        newContextManifestId: prepared.context.snapshot.next.manifest.id,
        expectedVersion: command.expectedVersion,
        createdAt: timestamp,
      });
      const updatedTurn: ChatTurn = { ...turn, attempts: [...turn.attempts, nextAttempt] };
      const updatedThread = {
        ...thread,
        version: (command.expectedVersion + 1) as AggregateVersion,
        updatedAt: timestamp,
      };
      this.#persistence.journal.append({
        aggregate: { aggregateType: "chat-thread", aggregateId: thread.id },
        expectedVersion: command.expectedVersion,
        events: [
          this.#pending("chat.thread-updated@1", { kind: "thread-updated", thread: updatedThread }),
          this.#pending("chat.attempt-updated@1", {
            kind: "attempt-updated",
            attempt: nextAttempt,
          }),
        ],
      });
      return { thread: updatedThread, turn: updatedTurn, attempt: nextAttempt, prompt, prepared };
    });
    await this.#runAttempt({
      thread: threadAsRoutedFor(accepted.thread, accepted.attempt),
      turn: accepted.turn,
      attempt: accepted.attempt,
      prompt: accepted.prompt,
      prepared: accepted.prepared,
      mode: "resume",
    });
    return { kind: "attempt-updated", attempt: accepted.attempt };
  }

  async #interruptTurn(
    command: Extract<ReturnType<typeof decodeChatCommand>, { kind: "interrupt-chat-turn" }>,
  ): Promise<ChatCommandResult> {
    const thread = this.#requireActiveThread(command.threadId);
    const view = this.#requireThreadView(command.threadId);
    const turn = view.turns.find((candidate) => String(candidate.id) === String(command.turnId));
    const attempt = turn?.attempts.find(
      (candidate) => String(candidate.id) === String(command.attemptId),
    );
    if (attempt === undefined) {
      throw new ChatServiceError({
        category: "invalid",
        message: "Chat attempt was not found.",
      });
    }
    const controller = this.#activeAttempts.get(String(command.attemptId));
    controller?.abort();
    const timestamp = decodeTimestamp(this.#clock());
    const cancelled = transitionChatAttempt(attempt, {
      outcome: "cancelled",
      updatedAt: timestamp,
    });
    const version = readAggregateVersion(this.#persistence.connection, "chat-thread", thread.id);
    this.#persistence.journal.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: thread.id },
      expectedVersion: version,
      events: [
        this.#pending("chat.attempt-updated@1", { kind: "attempt-updated", attempt: cancelled }),
      ],
    });
    return { kind: "attempt-updated", attempt: cancelled };
  }

  async #requestDeletion(
    command: Extract<ReturnType<typeof decodeChatCommand>, { kind: "delete-chat-thread" }>,
  ): Promise<ChatCommandResult> {
    const thread = this.#persistence.readChatThread(command.threadId);
    if (thread === undefined) {
      throw new ChatServiceError({
        category: "invalid",
        message: "Chat thread was not found.",
      });
    }
    this.#assertNoActiveTurn(this.#persistence.readChatThreadView(thread.id), thread.id);
    const aggregateVersion = readAggregateVersion(
      this.#persistence.connection,
      "chat-thread",
      thread.id,
    );
    const timestamp = decodeTimestamp(this.#clock());
    const deleting = requestChatThreadDeletion(
      { ...thread, version: aggregateVersion },
      {
        expectedVersion: command.expectedVersion,
        updatedAt: timestamp,
      },
    );
    this.#persistence.journal.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: thread.id },
      expectedVersion: command.expectedVersion,
      events: [
        this.#pending("chat.thread-updated@1", { kind: "thread-updated", thread: deleting }),
        this.#pending("chat.deletion-requested@1", {
          kind: "deletion-requested",
          threadId: thread.id,
          requestedAt: timestamp,
        }),
      ],
    });
    return await this.finalizePendingDeletion(thread.id);
  }

  async #prepareTurnExecution(
    requestedThread: ChatThread,
    prompt: string,
    currentRef: ChatContentReference,
    attachmentIds?: ReadonlyArray<ChatAttachmentId>,
    previewSelections?: ReadonlyArray<PreviewContextSelection>,
    canvasSelections?: ReadonlyArray<CanvasContextSelection>,
    /**
     * `#thread` mentions this turn names. Like preview and canvas selections,
     * they belong to the turn that made them: a retry, resume, or edit passes
     * none, so nothing a mention contributed is replayed.
     */
    threadMentionIds?: ReadonlyArray<MentionableThreadId>,
    extensionSelections?: ReadonlyArray<ExtensionSelection>,
    extensionPhase: "send" | "replay" | "resume" = "send",
    executionContext?: ChatServiceExecutionContext,
    preResolvedExtensions?: {
      readonly selections: ReadonlyArray<ExtensionSelection>;
      readonly entries: ReadonlyArray<ResolvedChatExtensionContextEntry>;
      readonly toolSet?: AppManagedToolSet;
    },
    /**
     * Conversation history this turn should run against. Only an edit supplies
     * it, because an edit re-runs the thread from before the revised message
     * and must not see the turns it supersedes. Absent means the thread's
     * current active conversation.
     */
    historyTurns?: ReadonlyArray<ChatTurn>,
  ): Promise<PreparedChatTurn> {
    const settings = this.#requireChatSettings();
    const routed = await this.#resolveTurnProvider(requestedThread, settings, extensionPhase);
    const thread = routed.thread;
    const providerInstanceId = routed.providerInstanceId;
    const driver = routed.driver;
    const probe = routed.probe;
    const attachments = await this.#loadFinalizedAttachments(thread.id, attachmentIds);
    const researchRoute = this.#resolveResearchRoute(thread, settings, probe);
    this.#assertResearchAvailable(thread, researchRoute);
    const appManagedTools =
      executionContext !== undefined &&
      this.#resolveAppManagedTools !== undefined &&
      this.#effectiveAppManagedTools(probe, decodeProviderModelId(thread.modelId)) === "supported"
        ? this.#resolveAppManagedTools({
            windowId: executionContext.windowId,
            thread,
            ...(threadMentionIds === undefined ? {} : { threadMentionIds }),
            ...(executionContext.coordinationDepth === undefined
              ? {}
              : { coordinationDepth: executionContext.coordinationDepth }),
          })
        : undefined;
    const resolvedExtensions =
      preResolvedExtensions ??
      (await this.#resolveExtensionContext(
        thread,
        extensionSelections,
        extensionPhase,
        executionContext?.windowId,
      ));
    const reservedResearchTools =
      thread.researchEnabled &&
      researchRoute.kind === "ready" &&
      researchRoute.backend === "searxng"
        ? 1
        : 0;
    const tools = this.#mergeToolSets(
      appManagedTools,
      resolvedExtensions.toolSet,
      MAX_PROVIDER_TOOLS - reservedResearchTools,
    );
    this.#preflightChatTurn(probe, thread, attachments, researchRoute, tools);
    const providerFacts = await this.#resolveProviderContextFacts(
      driver,
      probe,
      decodeProviderModelId(thread.modelId),
    );
    const sideChatSourceContext = await this.#resolveSideChatSource(thread, executionContext);
    const threadMentionContexts = await this.#resolveThreadMentions(
      threadMentionIds,
      executionContext,
      tools?.definitions.some((definition) => definition.name === "octant_thread_message") === true,
    );
    const context = this.#planContext(
      thread,
      prompt,
      currentRef,
      attachmentIds,
      previewSelections,
      canvasSelections,
      resolvedExtensions.entries,
      providerFacts.modelLimitObservations,
      providerFacts.serviceLimits,
      researchRoute,
      historyTurns,
      sideChatSourceContext,
      threadMentionContexts,
    );
    const maintained = await this.#compactDroppedConversation(
      thread,
      context,
      driver,
      providerInstanceId,
    );
    return {
      executionThread: thread,
      context: maintained,
      attachments,
      researchRoute,
      serviceLimits: providerFacts.serviceLimits,
      ...(tools === undefined ? {} : { appManagedTools: tools }),
      extensionSelections: resolvedExtensions.selections,
    };
  }

  /**
   * The provider a turn runs on, together with the facts it reported.
   *
   * A fresh turn may move to the user's fallback route when the thread's own
   * provider can no longer serve it, so a provider that went unavailable or
   * dropped the thread's model mid-conversation does not end the conversation.
   * A replay or resume continues an existing provider session and stays on the
   * route its attempt recorded. Without a fallback preference, or when the
   * named route cannot honestly serve the same turn, the turn keeps the
   * thread's provider so the refusal reports the real reason.
   */
  async #resolveTurnProvider(
    thread: ChatThread,
    settings: ConfiguredChatSettings,
    extensionPhase: "send" | "replay" | "resume",
  ): Promise<{
    readonly thread: ChatThread;
    readonly providerInstanceId: ProviderInstanceId;
    readonly driver: ProviderDriver;
    readonly probe: ProviderProbeResult;
  }> {
    const providerInstanceId = decodeProviderInstanceId(thread.providerInstanceId);
    // Constructing the driver for a provider whose configuration no driver can
    // serve throws, so it is part of the same failed active candidate as a
    // refused probe: a fallback route still gets its chance, and the original
    // failure is what the turn reports when no fallback is selected.
    const probed = await (async () => {
      try {
        const driver = this.#driver(providerInstanceId);
        const probe = await this.#probeProvider(driver, providerInstanceId);
        return { kind: "probed" as const, driver, probe };
      } catch (error: unknown) {
        return { kind: "failed" as const, error };
      }
    })();
    const active = () => {
      if (probed.kind === "failed") throw probed.error;
      return { thread, providerInstanceId, driver: probed.driver, probe: probed.probe };
    };
    if (extensionPhase !== "send") return active();
    const servesTurn = (routed: ChatThread, probe: ProviderProbeResult): boolean => {
      const modelId = decodeProviderModelId(routed.modelId);
      const facts = providerTurnFacts(probe, this.#effectiveAppManagedTools(probe, modelId));
      if (
        chatProviderServesTurn(facts, {
          modelId,
          requiredCapabilities: CHAT_TURN_REQUIRED_CAPABILITIES,
        }).kind !== "serves"
      ) {
        return false;
      }
      return this.#resolveResearchRoute(routed, settings, probe).kind !== "unavailable";
    };
    if (probed.kind === "probed" && servesTurn(thread, probed.probe)) {
      return { thread, providerInstanceId, driver: probed.driver, probe: probed.probe };
    }
    const preference = settings.providerFallback;
    const candidate =
      preference === undefined ||
      String(preference.providerInstanceId) === String(providerInstanceId)
        ? undefined
        : await this.#probeFallbackProvider(
            decodeProviderInstanceId(preference.providerInstanceId),
          );
    const candidateFacts =
      preference === undefined || candidate === undefined
        ? undefined
        : providerTurnFacts(
            candidate.probe,
            this.#effectiveAppManagedTools(
              candidate.probe,
              decodeProviderModelId(preference.modelId),
            ),
          );
    const decision = selectChatProviderFallback({
      preference,
      activeProviderInstanceId: providerInstanceId,
      requiredCapabilities: CHAT_TURN_REQUIRED_CAPABILITIES,
      candidate: candidateFacts,
    });
    if (decision.kind === "selected" && candidate !== undefined) {
      const routed = threadAsRoutedFor(thread, {
        providerInstanceId: candidate.providerInstanceId,
        modelId: decision.modelId,
      });
      if (servesTurn(routed, candidate.probe)) {
        return {
          thread: routed,
          providerInstanceId: candidate.providerInstanceId,
          driver: candidate.driver,
          probe: candidate.probe,
        };
      }
    }
    return active();
  }

  async #probeFallbackProvider(providerInstanceId: ProviderInstanceId): Promise<
    | undefined
    | {
        readonly providerInstanceId: ProviderInstanceId;
        readonly driver: ProviderDriver;
        readonly probe: ProviderProbeResult;
      }
  > {
    const instance = this.#persistence.readProviderInstance(providerInstanceId);
    if (instance === undefined || instance.enabled !== true) {
      // A disabled or missing fallback is not a route. Never construct its
      // driver or invoke probe(), which could spawn a CLI, touch credentials,
      // or make network requests. The turn reports the thread's own provider
      // refusal instead.
      return undefined;
    }
    try {
      const driver = this.#driver(providerInstanceId);
      const probe = await this.#probeProvider(driver, providerInstanceId);
      return { providerInstanceId, driver, probe };
    } catch {
      // An unobservable fallback is not a route. The turn reports why the
      // thread's own provider refused instead of this instance's failure.
      return undefined;
    }
  }

  /**
   * Resolve the source-thread context for a Side Chat sidecar's turn.
   *
   * The link and the Open check both live behind the port, so this only has to
   * decide what an unreadable source means: refuse. A sidecar exists to answer
   * questions about one specific thread, and answering from nothing would let
   * a deleted or newly unauthorized source pass as an empty conversation.
   */
  async #resolveSideChatSource(
    thread: ChatThread,
    executionContext: ChatServiceExecutionContext | undefined,
  ): Promise<string | undefined> {
    if (this.#resolveSideChatSourceContext === undefined) return undefined;
    let source: SideChatSourceContext | undefined;
    try {
      source = await this.#resolveSideChatSourceContext({
        sidecarThreadId: thread.id,
        ...(executionContext === undefined ? {} : { windowId: executionContext.windowId }),
      });
    } catch {
      // A resolver that throws says nothing about whether this thread is a
      // sidecar, so it cannot be read as "ordinary thread".
      throw new ChatServiceError({
        category: "unavailable",
        message: SIDE_CHAT_SOURCE_UNREADABLE,
      });
    }
    if (source === undefined) return undefined;
    if (source.kind === "unreadable") {
      throw new ChatServiceError({
        category: "unavailable",
        message: SIDE_CHAT_SOURCE_UNREADABLE,
      });
    }
    return source.text;
  }

  /**
   * Resolve the `#thread` mentions this turn names into read-only context.
   *
   * The host owns every fact behind the port: whether this send's principal
   * may still Open each named thread, and how much of its transcript one
   * mention carries. A mention it refuses is answered here in words rather
   * than dropped, because the user's own message still shows the chip they
   * typed — silence would let the model treat a thread it was never shown as
   * one it read. Unlike a Side Chat sidecar, a chip is an addition to an
   * ordinary turn rather than the thread the turn exists to discuss, so an
   * unreadable one costs the mention, not the send.
   */
  async #resolveThreadMentions(
    threadMentionIds: ReadonlyArray<MentionableThreadId> | undefined,
    executionContext: ChatServiceExecutionContext | undefined,
    dialogueEnabled: boolean,
  ): Promise<ReadonlyArray<{ readonly threadId: MentionableThreadId; readonly text: string }>> {
    if (threadMentionIds === undefined || threadMentionIds.length === 0) return [];
    if (this.#resolveThreadMentionContext === undefined) {
      return threadMentionIds.map((threadId) => ({
        threadId,
        text: THREAD_MENTION_UNREADABLE_CONTEXT,
      }));
    }
    let resolved: ReadonlyArray<ChatThreadMentionContext>;
    try {
      resolved = await this.#resolveThreadMentionContext({
        threadMentionIds,
        ...(executionContext === undefined ? {} : { windowId: executionContext.windowId }),
        ...(dialogueEnabled ? { dialogueEnabled: true } : {}),
      });
    } catch {
      // A resolver that throws proves nothing about any one mention, so every
      // named thread is reported unread rather than half of them guessed.
      return threadMentionIds.map((threadId) => ({
        threadId,
        text: THREAD_MENTION_UNREADABLE_CONTEXT,
      }));
    }
    const byThreadId = new Map(resolved.map((mention) => [String(mention.threadId), mention]));
    return threadMentionIds.map((threadId) => {
      const mention = byThreadId.get(String(threadId));
      return mention === undefined || mention.kind === "unreadable"
        ? { threadId, text: THREAD_MENTION_UNREADABLE_CONTEXT }
        : { threadId, text: mention.text };
    });
  }

  /**
   * Compacts the conversation material this turn's plan had to drop.
   *
   * Without this the thread simply stops seeing its older turns once it
   * outgrows the model's window, and neither the transcript nor the journal
   * records that anything happened. The summary stands for material the plan
   * already excluded, and it has to earn its own place in the request: making
   * one is a replan, and this turn is dispatched from — and journaled under —
   * whatever that replan decided. The whole step is best-effort: any
   * maintenance failure leaves the turn on the deterministic reduction it
   * already has.
   */
  async #compactDroppedConversation(
    thread: ChatThread,
    context: ChatTurnContextPlan,
    driver: ProviderDriver,
    providerInstanceId: ProviderInstanceId,
  ): Promise<ChatTurnContextPlan> {
    const droppedToFit = context.snapshot.next.plan.entries.some(
      (entry) => entry.state === "omitted" && entry.reason === "omitted-to-fit",
    );
    if (!droppedToFit || context.conversationMaterial.length === 0) return context;

    const reservationId = decodeCapacityReservationId(this.#uuid());
    const submission = this.#capacityScheduler.submit({
      reservationId,
      subject: context.subject,
      providerInstanceId,
      modelId: decodeProviderModelId(thread.modelId),
      estimatedTokens: context.snapshot.next.plan.safeInputBudget,
      requests: 1,
      // Context maintenance is a managed child of this turn, not a turn of its
      // own, and it shares the same provider slot as every other dispatch.
      origin: "subagent",
    });
    if (submission.status !== "dispatched") {
      this.#capacityScheduler.recordTerminal({ reservationId, outcome: "cancelled" });
      return context;
    }
    this.#capacityScheduler.markRunning(reservationId);
    const controller = new AbortController();
    let maintenanceTokens = 0;
    try {
      const scratchRoot = await this.#scratchStore.acquire(thread.id);
      const maintained = await this.#contextHarness.maintainContext({
        subject: context.subject,
        materials: context.conversationMaterial,
        generateSummary: makeContextSummaryGenerator({
          driver,
          providerInstanceId,
          scratchRoot,
          sessionId: decodeProviderSessionId(this.#uuid()),
          mode: "chat",
          observeUsage: (usage) => {
            maintenanceTokens = usage.inputTokens + usage.outputTokens;
          },
          ...(this.#contextMaintenanceTimeoutMs === undefined
            ? {}
            : { timeoutMs: this.#contextMaintenanceTimeoutMs }),
          ...(this.#contextMaintenanceShutdownTimeoutMs === undefined
            ? {}
            : { shutdownTimeoutMs: this.#contextMaintenanceShutdownTimeoutMs }),
        }),
        signal: controller.signal,
      });
      // Reconcile only against usage the provider actually reported; an
      // unmeasured request stays a released reservation rather than a
      // fabricated one.
      this.#capacityScheduler.recordTerminal(
        maintenanceTokens > 0
          ? { reservationId, outcome: "completed", actualTokens: maintenanceTokens }
          : { reservationId, outcome: "interrupted" },
      );
      if (maintained.kind !== "summary-created") return context;
      // Maintenance replans the turn against the compacted manifest, and that
      // plan — not the one this turn's blocks were first filtered by — is what
      // is journaled for it. The summary is therefore offered to the new plan
      // like any other entry rather than spliced into the old request: the plan
      // can price it out again, and what the provider receives stays exactly
      // what the journal says was sent.
      //
      // Position is not something the plan can supply, because the compacted
      // manifest appends the summary last, after the current request. It is
      // placed where the dropped conversation stood instead — ahead of the
      // turns that survived — and the plan then decides whether it is sent. A
      // manifest that does not carry the summary as an entry has no plan for
      // it either, so there is nothing to offer and nothing to send.
      const summaryEntry = maintained.snapshot.next.manifest.entries.find(
        (entry) =>
          entry.source.kind === "summary" &&
          entry.source.referenceId === String(maintained.summary.id),
      );
      const firstMessage = context.providerBlocks.findIndex(
        ({ block }) => block.kind === "user-message" || block.kind === "assistant-message",
      );
      const insertAt = firstMessage === -1 ? context.providerBlocks.length : firstMessage;
      const providerBlocks =
        summaryEntry === undefined
          ? context.providerBlocks
          : [
              ...context.providerBlocks.slice(0, insertAt),
              {
                entryId: summaryEntry.id,
                block: { kind: "conversation-summary", text: maintained.content } as const,
              },
              ...context.providerBlocks.slice(insertAt),
            ];
      return {
        ...context,
        snapshot: maintained.snapshot,
        providerBlocks,
        providerContext: dispatchedProviderContext(providerBlocks, maintained.snapshot.next.plan),
      };
    } catch {
      this.#capacityScheduler.recordTerminal({ reservationId, outcome: "interrupted" });
      return context;
    }
  }

  async #resolveExtensionContext(
    thread: ChatThread,
    selections: ReadonlyArray<ExtensionSelection> | undefined,
    phase: "send" | "replay" | "resume" | "provider-handoff",
    windowId?: WindowId,
  ): Promise<{
    readonly selections: ReadonlyArray<ExtensionSelection>;
    readonly entries: ReadonlyArray<ResolvedChatExtensionContextEntry>;
    readonly toolSet?: AppManagedToolSet;
  }> {
    if (selections === undefined || selections.length === 0) {
      return { selections: [], entries: [] };
    }
    if (this.#resolveExtensionSelectionContext === undefined) {
      throw new ChatServiceError({
        category: "unavailable",
        message: "Selected extension context is unavailable.",
      });
    }
    return await this.#resolveExtensionSelectionContext({
      phase,
      thread,
      selections,
      ...(windowId === undefined ? {} : { windowId }),
    });
  }

  #mergeToolSets(
    appManaged: AppManagedToolSet | undefined,
    extension: AppManagedToolSet | undefined,
    maximumDefinitions: number,
  ): AppManagedToolSet | undefined {
    if (appManaged === undefined && extension === undefined) return undefined;
    const candidates = [...(appManaged?.definitions ?? []), ...(extension?.definitions ?? [])];
    if (new Set(candidates.map(({ name }) => name)).size !== candidates.length) {
      throw new ChatServiceError({
        category: "invalid",
        message: "Selected extension tool names collide with available app-managed tools.",
      });
    }
    if (candidates.length > Math.max(0, maximumDefinitions)) {
      throw new ChatServiceError({
        category: "unavailable",
        message: "Selected extension tools exceed the provider's remaining tool capacity.",
      });
    }
    const definitions = candidates;
    const selectedNames = new Set(definitions.map(({ name }) => name));
    const appManagedNames = new Set(
      appManaged?.definitions.map(({ name }) => name).filter((name) => selectedNames.has(name)) ??
        [],
    );
    const extensionNames = new Set(
      extension?.definitions.map(({ name }) => name).filter((name) => selectedNames.has(name)) ??
        [],
    );
    return {
      definitions,
      execute: (input) => {
        if (extension !== undefined && extensionNames.has(input.name)) {
          return extension.execute(input);
        }
        if (appManaged !== undefined && appManagedNames.has(input.name)) {
          return appManaged.execute(input);
        }
        return Promise.reject(new Error("Tool definition is unavailable."));
      },
    };
  }

  #defaultChatSettings(): ChatSettings {
    return {
      defaultResearchEnabled: false,
      defaultResearchRouting: "automatic",
      defaultPersonalityInstructions: DEFAULT_CHAT_PERSONALITY_INSTRUCTIONS,
      version: 0 as AggregateVersion,
      updatedAt: decodeTimestamp(this.#clock()),
    };
  }

  #requireChatSettings(): ConfiguredChatSettings {
    const projected = this.#persistence.readChatSettings();
    if (
      projected?.settings.defaultProviderInstanceId === undefined ||
      projected.settings.defaultModelId === undefined
    ) {
      throw new ChatServiceError({
        category: "unavailable",
        message: "Configure a default Chat provider and model before creating a conversation.",
      });
    }
    return projected.settings as ConfiguredChatSettings;
  }

  async #probeProvider(
    driver: ProviderDriver,
    providerInstanceId: ProviderInstanceId,
  ): Promise<ProviderProbeResult> {
    try {
      const probe = await Effect.runPromise(
        Effect.scoped(driver.probe({ instanceId: providerInstanceId })),
      );
      // The driver probe carries verifiedToolModelIds forward from the
      // in-memory runtime observation, which is empty after an app restart.
      // Merge from the persisted catalog so a verified Foundry deployment
      // used after restart does not lose its tool verification before the
      // Chat turn/research preflight. Skip invalidated catalogs: a config
      // change invalidates prior verification evidence.
      const persistedCatalog = this.#persistence.readProviderCatalog?.(providerInstanceId);
      const persistedVerified =
        persistedCatalog?.invalidated === false ? persistedCatalog.verifiedToolModelIds : undefined;
      if (persistedVerified === undefined || persistedVerified.length === 0) {
        return probe;
      }
      const merged = [
        ...new Set([
          ...(probe.verifiedToolModelIds ?? []),
          ...persistedVerified.map((id) => String(id) as ProviderModelId),
        ]),
      ].map((id) => id as ProviderModelId);
      const mergedProbe = { ...probe, verifiedToolModelIds: merged };
      // Write the merged verification back to the provider runtime registry
      // so openAiCompatibleDriver.send (which re-checks
      // observed?.verifiedToolModelIds before accepting the SearXNG research
      // tool) sees the effective capability. Without this, preflight would
      // pass but the actual turn would fail as "App-managed tools are
      // unsupported" until the user runs Settings → Check connection.
      this.#providerRuntimeRegistry?.setObservedState(mergedProbe);
      return mergedProbe;
    } catch (error) {
      throw this.#mapProviderProbeFailure(error);
    }
  }

  #mapProviderProbeFailure(error: unknown): ChatServiceError {
    if (error instanceof ChatServiceError) return error;
    if (this.#isProviderFailure(error)) {
      return new ChatServiceError(this.#mapProviderFailureToChat(error));
    }
    return this.#unavailable();
  }

  async #resolveProviderContextFacts(
    driver: ProviderDriver,
    probe: ProviderProbeResult,
    modelId: ProviderModelId,
  ): Promise<{
    readonly modelLimitObservations: ReadonlyArray<ModelContextLimits>;
    readonly serviceLimits: ProviderServiceLimits;
  }> {
    let modelEvidence = await this.#observeModelLimitEvidence(driver, probe, modelId);
    if (modelEvidence.length === 0) {
      const fromProbe = this.#modelLimitEvidenceFromProbeModel(probe, modelId);
      if (fromProbe !== undefined) {
        modelEvidence = [fromProbe];
      }
    }
    const modelLimitObservations = modelEvidence
      .map((evidence) => normalizeModelLimitEvidence(evidence))
      .flatMap((observation) => (observation.status === "available" ? [observation.limits] : []));
    if (modelLimitObservations.length === 0) {
      const fallback = normalizeModelLimitEvidence(
        this.#fallbackModelLimitEvidence(probe, modelId),
      );
      if (fallback.status !== "available") {
        throw new ChatServiceError({
          category: "unsupported",
          message: "Selected model context limits are unavailable.",
        });
      }
      modelLimitObservations.push(fallback.limits);
    }

    const serviceLimits = await this.#observeServiceLimits(driver, probe);
    return { modelLimitObservations, serviceLimits };
  }

  async #observeModelLimitEvidence(
    driver: ProviderDriver,
    probe: ProviderProbeResult,
    modelId: ProviderModelId,
  ): Promise<ReadonlyArray<ProviderModelLimitEvidence>> {
    if (driver.contextFacts?.observeModelLimits !== undefined) {
      try {
        const observed = await Effect.runPromise(
          Effect.scoped(driver.contextFacts.observeModelLimits({ instanceId: probe.instanceId })),
        );
        return observed
          .filter((evidence) => String(evidence.modelId) === String(modelId))
          .map((evidence) => this.#withConservativeMaxOutput(evidence));
      } catch {
        // Fall back to probe-derived evidence.
      }
    }
    return modelEvidenceFromObservedState(probe)
      .filter((evidence) => String(evidence.modelId) === String(modelId))
      .map((evidence) => this.#withConservativeMaxOutput(evidence));
  }

  #withConservativeMaxOutput(evidence: ProviderModelLimitEvidence): ProviderModelLimitEvidence {
    if (evidence.maxOutput !== undefined || evidence.contextWindow === undefined) {
      return evidence;
    }
    return {
      ...evidence,
      maxOutput: Math.min(4_096, Math.max(1, Math.floor(evidence.contextWindow / 4))),
      confidence: "low",
    };
  }

  #modelLimitEvidenceFromProbeModel(
    probe: ProviderProbeResult,
    modelId: ProviderModelId,
  ): ProviderModelLimitEvidence | undefined {
    const model = probe.models.find((candidate) => String(candidate.id) === String(modelId));
    if (model?.contextLimit === undefined) return undefined;
    return this.#withConservativeMaxOutput({
      providerInstanceId: probe.instanceId,
      modelId: model.id,
      contextWindow: model.contextLimit,
      reasoning: model.reasoning === "supported" ? "included" : "unknown",
      source: model.source === "discovered" ? "provider-discovery" : "user-supplied",
      confidence: model.verification === "verified" ? "medium" : "low",
      observedAt: probe.observedAt,
    });
  }

  /**
   * Limits for a model no provider reported any for. A reviewed manifest entry
   * is preferred over the built-in floor because the floor is small enough to
   * truncate an ordinary thread; both stay low-confidence so provider-reported
   * evidence still wins.
   */
  #fallbackModelLimitEvidence(
    probe: ProviderProbeResult,
    modelId: ProviderModelId,
  ): ProviderModelLimitEvidence {
    const reviewed = this.#reviewedModelManifest?.entry(String(modelId));
    return {
      providerInstanceId: probe.instanceId,
      modelId,
      contextWindow: reviewed?.contextWindow ?? FALLBACK_CHAT_CONTEXT_WINDOW,
      maxOutput: reviewed?.maxOutput ?? FALLBACK_CHAT_MAX_OUTPUT,
      ...(reviewed === undefined ? {} : { reasoning: reviewed.reasoning }),
      source: "reviewed-catalog",
      confidence: "low",
      observedAt: probe.observedAt,
    };
  }

  async #observeServiceLimits(
    driver: ProviderDriver,
    probe: ProviderProbeResult,
  ): Promise<ProviderServiceLimits> {
    if (driver.contextFacts?.observeServiceLimits !== undefined) {
      try {
        return await Effect.runPromise(
          Effect.scoped(driver.contextFacts.observeServiceLimits({ instanceId: probe.instanceId })),
        );
      } catch {
        // Fall back to unavailable service limits.
      }
    }
    return unavailableProviderServiceLimits(
      probe.instanceId,
      probe.observedAt,
      "provider-discovery",
    );
  }

  async #loadFinalizedAttachments(
    threadId: ChatThreadId,
    attachmentIds?: ReadonlyArray<ChatAttachmentId>,
  ): Promise<ReadonlyArray<ProviderAttachmentInput>> {
    if (attachmentIds === undefined || attachmentIds.length === 0) return [];
    const attachments: ProviderAttachmentInput[] = [];
    for (const attachmentId of attachmentIds) {
      const row = this.#persistence.connection
        .prepare("SELECT attachment_json FROM chat_attachment_projection WHERE attachment_id = ?")
        .get(attachmentId) as { readonly attachment_json: string } | undefined;
      if (row === undefined) {
        throw new ChatServiceError({
          category: "invalid",
          message: "Chat attachment was not found.",
        });
      }
      const metadata = decodeChatAttachment(JSON.parse(row.attachment_json));
      if (String(metadata.threadId) !== String(threadId)) {
        throw new ChatServiceError({
          category: "invalid",
          message: "Chat attachment is not available.",
        });
      }
      if (metadata.status !== "finalized") {
        throw new ChatServiceError({
          category: "invalid",
          message: "Chat attachment is not available.",
        });
      }
      const bytes = await this.#attachmentStore.read({
        chatThreadId: threadId,
        chatAttachmentId: attachmentId,
        displayName: metadata.displayName,
        size: metadata.byteLength,
        hash: metadata.digest,
        finalizedAt: metadata.createdAt,
      });
      attachments.push(
        decodeProviderAttachmentInput({
          attachmentId: String(attachmentId),
          displayName: metadata.displayName,
          mediaType: metadata.mediaType,
          bytes,
        }),
      );
    }
    return attachments;
  }

  /**
   * For Azure AI Foundry, tool support is per-deployment (gated by
   * verifiedToolModelIds). The Chat preflight and research routing must treat
   * the selected model as tool-supported when its id is verified, even though
   * the provider-level appManagedTools flag stays "unsupported" until all
   * deployments are verified.
   */
  #effectiveAppManagedTools(
    probe: ProviderProbeResult,
    modelId: ProviderModelId,
  ): ProviderCapabilitySupport {
    if (probe.capabilities.appManagedTools === "supported") return "supported";
    const isVerified =
      probe.verifiedToolModelIds?.some((id) => String(id) === String(modelId)) ?? false;
    return isVerified ? "supported" : probe.capabilities.appManagedTools;
  }

  #resolveResearchRoute(
    thread: ChatThread,
    settings: ChatSettings,
    probe: ProviderProbeResult,
  ): ResearchRouteDecision {
    return this.#researchRouter.resolve({
      researchEnabled: thread.researchEnabled,
      routing: thread.researchRouting,
      searxngConfigured:
        settings.searxngBaseUrl !== undefined && settings.searxngBaseUrl.trim().length > 0,
      appManagedTools: this.#effectiveAppManagedTools(probe, decodeProviderModelId(thread.modelId)),
      nativeResearch: probe.capabilities.nativeWebResearch,
    });
  }

  #assertResearchAvailable(thread: ChatThread, researchRoute: ResearchRouteDecision): void {
    if (!thread.researchEnabled || researchRoute.kind !== "unavailable") return;
    throw new ChatServiceError(
      decodeChatFailure({
        category:
          researchRoute.reason === "app-managed-tools-unsupported" ||
          researchRoute.reason === "native-research-unsupported"
            ? "unsupported"
            : "unavailable",
        message: "Chat research is unavailable for the selected routing.",
      }),
    );
  }

  #preflightChatTurn(
    probe: ProviderProbeResult,
    thread: ChatThread,
    attachments: ReadonlyArray<ProviderAttachmentInput>,
    researchRoute: ResearchRouteDecision,
    appManagedTools?: AppManagedToolSet,
  ): void {
    const model = probe.models.find((candidate) => String(candidate.id) === String(thread.modelId));
    if (model === undefined) {
      throw new ChatServiceError(
        decodeChatFailure({
          category: "unavailable",
          message: "Selected Chat model is unavailable.",
        }),
      );
    }
    // The thread's option values were validated against the catalog observed
    // when they were chosen, not the one this turn will run on. Re-check them
    // against the freshly probed model so a retired tier is reported instead
    // of being dropped by the driver into a silent provider default.
    const unsupported = unsupportedModelOptionValues(thread.modelOptionValues, model.options);
    if (unsupported.length > 0) {
      throw new ChatServiceError(
        decodeChatFailure({
          category: "unsupported",
          message: `Selected Chat model no longer offers ${unsupported
            .map(({ optionId, value }) => `${optionId}=${value}`)
            .join(", ")}. Choose an available option before sending.`,
        }),
      );
    }
    const researchTools =
      thread.researchEnabled &&
      researchRoute.kind === "ready" &&
      researchRoute.backend === "searxng"
        ? [
            {
              name: RESEARCH_TOOL_NAME,
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          ]
        : [];
    const tools = [...researchTools, ...(appManagedTools?.definitions ?? [])];
    if (new Set(tools.map(({ name }) => name)).size !== tools.length) {
      throw new ChatServiceError({
        category: "invalid",
        message: "Selected extension tool names collide with available research tools.",
      });
    }
    const rejected = validateChatTurnInput(
      {
        sessionId: decodeProviderSessionId(this.#uuid()),
        prompt: "preflight",
        context: [],
        attachments: [...attachments],
        tools,
      },
      {
        ...probe.capabilities,
        appManagedTools: this.#effectiveAppManagedTools(
          probe,
          decodeProviderModelId(thread.modelId),
        ),
      },
      model,
    );
    if (rejected !== undefined) {
      throw new ChatServiceError(this.#mapProviderFailureToChat(rejected));
    }
  }

  #mapProviderFailureToChat(failure: ProviderFailure): ChatFailure {
    const category =
      failure.category === "interrupted"
        ? "interrupted"
        : failure.category === "rate-limited"
          ? "waiting"
          : failure.category === "unauthorized" || failure.category === "unauthenticated"
            ? "unauthorized"
            : failure.category === "unsupported" || failure.category === "incompatible"
              ? "unsupported"
              : failure.category === "provider-failed"
                ? "failed"
                : "unavailable";
    return decodeChatFailure({
      category,
      message: failure.message,
      ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
    });
  }

  #isProviderFailure(error: unknown): error is ProviderFailure {
    if (typeof error !== "object" || error === null || !("category" in error)) {
      return false;
    }
    const failure = error as ProviderFailure;
    return typeof failure.message === "string";
  }

  #planContext(
    thread: ChatThread,
    prompt: string,
    currentRef: ChatContentReference,
    options: ReadonlyArray<ChatAttachmentId> | undefined,
    previewSelections: ReadonlyArray<PreviewContextSelection> | undefined,
    canvasSelections: ReadonlyArray<CanvasContextSelection> | undefined,
    extensionContextEntries: ReadonlyArray<ResolvedChatExtensionContextEntry>,
    modelLimitObservations: ReadonlyArray<ModelContextLimits>,
    serviceLimits: ProviderServiceLimits,
    researchRoute: ResearchRouteDecision,
    historyTurns?: ReadonlyArray<ChatTurn>,
    /**
     * Framed, read-only transcript of the thread a Side Chat sidecar is about
     * Present only for a sidecar, and resolved by the host on this
     * turn's own principal.
     */
    sideChatSourceContext?: string,
    /**
     * Framed, read-only context for each `#thread` mention this turn names,
     * resolved by the host on this turn's own principal. Present only
     * for the turn that named them.
     */
    threadMentionContexts?: ReadonlyArray<{
      readonly threadId: MentionableThreadId;
      readonly text: string;
    }>,
  ): ChatTurnContextPlan {
    const providerInstanceId = decodeProviderInstanceId(thread.providerInstanceId);
    const subject = decodeContextSubjectRef({
      aggregateType: "chat-thread",
      aggregateId: String(thread.id),
    });
    const work = readThreadWorkState(this.#persistence.connection, thread.id);
    const view = this.#persistence.readChatThreadView(thread.id);
    const contentById = new Map(
      (view?.contents ?? []).map((content) => [content.contentId, content]),
    );
    const providerContextByEntryId = new Map<string, ProviderContextBlock>();
    const contextEntry = (
      entry: ReturnType<typeof decodeContextEntry>,
      block?: ProviderContextBlock,
    ) => {
      if (block !== undefined) providerContextByEntryId.set(String(entry.id), block);
      return entry;
    };
    const requireContent = (reference: ChatContentReference) => {
      const content = contentById.get(reference.contentId);
      if (content === undefined) {
        throw new ChatServiceError({
          category: "unavailable",
          message: "Chat context content is unavailable.",
        });
      }
      return content;
    };
    // Superseded turns stay journaled but are not part of the conversation the
    // model is asked to continue, so the transcript is always the active one.
    const selectedTurns = historyTurns ?? activeChatTurns(view?.turns ?? []);
    // Conversation a previous turn already compacted. Its summary is reused
    // instead of re-sending the material and paying for maintenance again, and
    // the transcript keeps every original message either way.
    const compacted = this.#contextHarness.compactedConversation(subject);
    // A summary stands for the sources it replaced, so it may only be reused
    // when all of them belong to the history this turn selected. An edit runs
    // the thread from before the revised message, and a summary reaching past
    // that point would restate exactly the conversation the edit excludes.
    const reusableSummaryIds = reusableContextSummaryIds(
      compacted.summarizedSourceKeys,
      new Set(
        selectedTurns.flatMap((turn) => [
          contextSourceKey({
            kind: "message",
            referenceId: String(turn.userMessageRef.contentId),
          }),
          ...turn.attempts.map((attempt) =>
            contextSourceKey({ kind: "message", referenceId: `attempt:${attempt.id}` }),
          ),
        ]),
      ),
    );
    // A compacted message keeps its place in the manifest as a summarized
    // entry so the inspector can say what replaced it and the next turn still
    // knows it is compacted. It costs this turn nothing and is not sent.
    // Material whose summary this turn may not reuse is not elided: it is sent
    // as the real message, and this turn compacts it again if it does not fit.
    const compactedEntry = (source: ContextSourceRef, body: string, tokens: number) => {
      const summaryId = compacted.summarizedSourceKeys.get(contextSourceKey(source));
      return summaryId === undefined || !reusableSummaryIds.has(String(summaryId))
        ? undefined
        : this.#contextEntry(
            thread,
            "conversation",
            body,
            tokens,
            "compressible",
            source,
            "included",
            { summaryId },
          );
    };
    const summaryEntries = compacted.summaries
      .filter((summary) => reusableSummaryIds.has(String(summary.id)))
      .map((summary) =>
        contextEntry(
          this.#contextEntry(
            thread,
            "conversation",
            // The manifest is journaled, and a summary's text is generated
            // from this thread's own messages, so it must not become the
            // entry's label. The harness labels the summary it commits the
            // same way; only the provider block below carries the real text.
            "Compacted earlier conversation",
            Math.max(16, summary.tokens),
            "compressible",
            { kind: "summary", referenceId: String(summary.id) },
          ),
          { kind: "conversation-summary", text: summary.content },
        ),
      );
    const transcriptEntries = selectedTurns.flatMap((turn) => {
      const user = requireContent(turn.userMessageRef);
      const userSource = { kind: "message", referenceId: String(user.contentId) } as const;
      const userTokens = Math.max(16, Math.ceil(user.body.length / 4));
      const compactedUser = compactedEntry(userSource, user.body, userTokens);
      const entries =
        compactedUser !== undefined
          ? [compactedUser]
          : [
              contextEntry(
                this.#contextEntry(
                  thread,
                  "conversation",
                  user.body,
                  userTokens,
                  "compressible",
                  userSource,
                ),
                { kind: "user-message", text: user.body },
              ),
            ];
      for (const attempt of turn.attempts) {
        // Skipped before the text is read, sized, or costed, so an abandoned
        // reply never occupies budget the plan then charges for — it would
        // push one of the thread's real exchanges into compaction to pay for
        // text the thread never accepted. This context is the thread's own
        // next turn, so a fragment admitted here is not briefed once but fed
        // back on every turn that follows, and after a retry it stands beside
        // the real answer with nothing to tell them apart. No block kind can
        // mark text as partial, so an attempt that failed, was interrupted or
        // cancelled, or has not finished arriving contributes nothing; the
        // turn's prompt is still admitted above. The compacted-source keys
        // above deliberately still cover every attempt, so this skip cannot
        // change which material counts as already compacted and make the
        // thread pay for that maintenance a second time.
        if (!chatAttemptAnswered(attempt)) continue;
        const assistantText = attempt.responseRefs
          .map(requireContent)
          .map((content) => content.body)
          .join("");
        if (assistantText.trim().length === 0) continue;
        const assistantSource = {
          kind: "message",
          referenceId: `attempt:${attempt.id}`,
        } as const;
        const assistantTokens = Math.max(16, Math.ceil(assistantText.length / 4));
        const compactedAssistant = compactedEntry(assistantSource, assistantText, assistantTokens);
        entries.push(
          compactedAssistant ??
            contextEntry(
              this.#contextEntry(
                thread,
                "conversation",
                assistantText,
                assistantTokens,
                "compressible",
                assistantSource,
              ),
              { kind: "assistant-message", text: assistantText },
            ),
        );
      }
      return entries;
    });
    const memoryEntries =
      thread.projectId === undefined
        ? []
        : this.#persistence
            .readProjectMemory(thread.projectId)
            .active.map((entry) =>
              contextEntry(
                this.#contextEntry(
                  thread,
                  "project-memory",
                  entry.content,
                  Math.max(16, Math.ceil(entry.content.length / 4)),
                  "compressible",
                  { kind: "memory", referenceId: String(entry.id) },
                ),
                { kind: "project-memory", text: entry.content },
              ),
            );
    const attachmentEntries = (options ?? []).map((attachmentId) =>
      this.#contextEntry(
        thread,
        "workspace-context",
        String(attachmentId),
        24,
        "compressible",
        { kind: "file", referenceId: String(attachmentId) },
        "referenced",
      ),
    );
    // Preview selections are explicit, source-versioned, bounded agent
    // context. Each selection is attributed through the context planner as a
    // separately removable "preview-selection" entry. The host reauthorizes
    // the opaque target and rechecks the source version at send time; a
    // stale/revoked selection surfaces as an honest referenced entry the
    // planner can omit under budget pressure without guessing a replacement.
    const previewSelectionEntries = (previewSelections ?? []).map((selection) =>
      this.#contextEntry(
        thread,
        "workspace-context",
        selection.displayName,
        32,
        "compressible",
        { kind: "preview-selection", referenceId: String(selection.id) },
        "referenced",
      ),
    );
    const canvasSelectionEntries = (canvasSelections ?? []).map((selection) =>
      this.#contextEntry(
        thread,
        "workspace-context",
        selection.displayName,
        32,
        "compressible",
        { kind: "canvas-selection", referenceId: String(selection.id) },
        "referenced",
      ),
    );
    const extensionEntries = extensionContextEntries.map((entry) =>
      contextEntry(entry.contextEntry, entry.providerContext),
    );
    // A sidecar's source thread is workspace context like any other selection:
    // compressible, so the planner can compact or omit it under budget
    // pressure rather than pushing out the conversation it is meant to
    // support, and never `required`.
    const sideChatSourceEntries =
      sideChatSourceContext === undefined || sideChatSourceContext.length === 0
        ? []
        : [
            contextEntry(
              this.#contextEntry(
                thread,
                "workspace-context",
                sideChatSourceContext,
                Math.max(16, Math.ceil(sideChatSourceContext.length / 4)),
                "compressible",
                { kind: "message", referenceId: `side-chat-source:${thread.id}` },
              ),
              { kind: "user-message", text: sideChatSourceContext },
            ),
          ];
    // A `#thread` mention is workspace context like any other selection:
    // compressible, so the planner can compact or omit it under budget
    // pressure, and separately attributed so the inspector can say which
    // mention cost what. It belongs to this turn alone — the user's message
    // keeps only what they typed, so no later turn replays it.
    const threadMentionEntries = (threadMentionContexts ?? []).map((mention) =>
      contextEntry(
        this.#contextEntry(
          thread,
          "workspace-context",
          mention.text,
          Math.max(16, Math.ceil(mention.text.length / 4)),
          "compressible",
          { kind: "message", referenceId: `thread-mention:${mention.threadId}` },
        ),
        { kind: "user-message", text: mention.text },
      ),
    );
    const priorTurns = this.#persistence.readChatThreadView(thread.id)?.turns ?? [];
    const stillFirstTurn = priorTurns.every((turn) => turn.sequence === 1);
    if (!stillFirstTurn) {
      this.#issueContext?.consumeFramedForFirstTurn(String(thread.id));
      this.#linearIssueContext?.consumeFramedForFirstTurn(String(thread.id));
    }
    const githubIssueContextFramed = stillFirstTurn
      ? this.#issueContext?.peekFramedForFirstTurn(String(thread.id))
      : undefined;
    const linearIssueContextFramed =
      stillFirstTurn && githubIssueContextFramed === undefined
        ? this.#linearIssueContext?.peekFramedForFirstTurn(String(thread.id))
        : undefined;
    const issueContextFramed = githubIssueContextFramed ?? linearIssueContextFramed;
    const issueContextSource =
      githubIssueContextFramed !== undefined ? "github-issue" : "linear-issue";
    const issueContextEntries =
      issueContextFramed === undefined
        ? []
        : [
            contextEntry(
              this.#contextEntry(
                thread,
                "workspace-context",
                issueContextFramed.text,
                Math.max(16, Math.ceil(issueContextFramed.text.length / 4)),
                "required",
                { kind: "message", referenceId: `${issueContextSource}:${thread.id}` },
              ),
              { kind: "user-message", text: issueContextFramed.text },
            ),
          ];
    const historicalAttachmentEntries = (thread.handoffWarning?.omittedAttachments ?? []).map(
      (attachment) =>
        this.#contextEntry(
          thread,
          "workspace-context",
          attachment.displayName,
          24,
          "compressible",
          { kind: "file", referenceId: String(attachment.attachmentId) },
          "omitted",
        ),
    );
    const researchEntries =
      thread.researchEnabled &&
      researchRoute.kind === "ready" &&
      researchRoute.backend === "searxng"
        ? [
            this.#contextEntry(thread, "octant-tools", RESEARCH_TOOL_NAME, 24, "compressible", {
              kind: "tool",
              referenceId: RESEARCH_TOOL_NAME,
            }),
          ]
        : [];
    const entries = [
      contextEntry(
        this.#contextEntry(
          thread,
          "user-instructions",
          thread.personalityInstructions,
          48,
          "required",
          { kind: "instruction", referenceId: `thread:${thread.id}:instructions` },
        ),
        { kind: "instructions", text: thread.personalityInstructions },
      ),
      ...memoryEntries,
      ...summaryEntries,
      ...transcriptEntries,
      ...work.workList.items
        .filter((item) => item.status !== "completed" && item.status !== "cancelled")
        .map((item) =>
          contextEntry(
            this.#contextEntry(thread, "workspace-context", item.title, 24, "compressible", {
              kind: "artifact",
              referenceId: `work:${item.id}`,
            }),
            { kind: "work-item", text: item.title },
          ),
        ),
      ...sideChatSourceEntries,
      ...threadMentionEntries,
      ...issueContextEntries,
      ...attachmentEntries,
      ...previewSelectionEntries,
      ...canvasSelectionEntries,
      ...extensionEntries,
      ...historicalAttachmentEntries,
      ...researchEntries,
      this.#contextEntry(
        thread,
        "current-request",
        prompt,
        Math.max(16, Math.ceil(prompt.length / 4)),
        "required",
        { kind: "message", referenceId: currentRef.contentId },
      ),
    ];
    const snapshot = this.#contextHarness.planTurn({
      subject,
      displayLabel: thread.title,
      requestShape: "chat-turn",
      modelLimitObservations,
      serviceLimits,
      entries,
      reserves: { response: 200, reasoning: 50, framing: 50, variance: 50, safety: 50 },
      watchHeadroomTokens: 100,
      capabilityCatalog: {
        entries: [] as CapabilityCatalogEntry[],
        epoch: deriveCatalogEpoch({
          entries: [],
          activeFacts: {
            providerInstanceId,
            activeScope: {
              mode: { referenceId: "mode:chat", revision: 1 },
              project: { referenceId: `chat-thread:${thread.id}`, revision: 1 },
              host: { referenceId: "host:local", revision: 1 },
              model: { referenceId: `model:${thread.modelId}`, revision: 1 },
            },
          },
          invalidationFacts: [],
        }),
      },
      capabilityRequest: {
        providerInstanceId,
        activeScope: {
          mode: { referenceId: "mode:chat", revision: 1 },
          project: { referenceId: `chat-thread:${thread.id}`, revision: 1 },
          host: { referenceId: "host:local", revision: 1 },
          model: { referenceId: `model:${thread.modelId}`, revision: 1 },
        },
        nativeToolSearch: "supported",
        taskKeywords: thread.researchEnabled ? ["research"] : [],
        explicitSelections: [],
      },
    });
    const providerBlocks = entries.flatMap((entry) => {
      const block = providerContextByEntryId.get(String(entry.id));
      return block === undefined ? [] : [{ entryId: entry.id, block }];
    });
    return {
      subject,
      snapshot,
      providerBlocks,
      providerContext: dispatchedProviderContext(providerBlocks, snapshot.next.plan),
      conversationMaterial: entries.flatMap((entry) => {
        const block = providerContextByEntryId.get(String(entry.id));
        if (entry.category !== "conversation" || block === undefined) return [];
        const speaker = block.kind === "assistant-message" ? "Assistant" : "User";
        return [{ entryId: entry.id, content: `${speaker}: ${block.text}` }];
      }),
    };
  }

  async #runAttempt(input: {
    readonly thread: ChatThread;
    readonly turn: ChatTurn;
    readonly attempt: ChatAttempt;
    readonly prompt: string;
    readonly prepared: PreparedChatTurn;
    readonly mode?: "send" | "resume";
  }): Promise<void> {
    const controller = new AbortController();
    this.#activeAttempts.set(String(input.attempt.id), controller);
    this.#activeThreadExecutions.add(String(input.thread.id));
    const pendingContent = new Map<string, PreparedChatContent>();
    const persistAttempt = async (attempt: ChatAttempt, providerFailure?: ProviderFailure) => {
      const version = readAggregateVersion(
        this.#persistence.connection,
        "chat-thread",
        input.thread.id,
      );
      const referencedContent = attempt.responseRefs
        .map((reference) => pendingContent.get(String(reference.contentId)))
        .filter((content): content is PreparedChatContent => content !== undefined);
      this.#persistence.journal.append(
        {
          aggregate: { aggregateType: "chat-thread", aggregateId: input.thread.id },
          expectedVersion: version,
          events: [
            this.#pending(
              "chat.attempt-updated@1",
              { kind: "attempt-updated", attempt },
              providerFailure === undefined
                ? undefined
                : { correlationId: decodeCorrelationId(attempt.id) },
            ),
            ...(providerFailure === undefined
              ? []
              : [
                  createDiagnosticsFailureIncidentEvent(
                    {
                      correlationId: decodeCorrelationId(attempt.id),
                      domain: "provider",
                      failureCode: decodeDiagnosticFailureCode(providerFailure.category),
                      observedAt: this.#clock(),
                    },
                    { eventIdGenerator: this.#uuid },
                  ),
                ]),
          ],
        },
        referencedContent.length === 0
          ? undefined
          : {
              beforeEvents: (connection) => {
                for (const content of referencedContent) {
                  this.#writePreparedContent(connection, content);
                }
              },
            },
      );
      for (const content of referencedContent) {
        pendingContent.delete(String(content.reference.contentId));
      }
    };

    try {
      if (input.prepared.extensionSelections.length > 0) {
        await this.#resolveExtensionContext(
          input.thread,
          input.prepared.extensionSelections,
          input.mode === "resume" ? "resume" : "provider-handoff",
        );
      }
      const scratchRoot = await this.#scratchStore.acquire(input.thread.id);
      const reservationId = decodeCapacityReservationId(this.#uuid());
      const providerInstanceId = decodeProviderInstanceId(input.thread.providerInstanceId);

      const harnessScope: NativeHarnessTurnScope = {
        threadId: String(input.thread.id),
        mode: "chat",
        providerInstanceId,
        modelId: decodeProviderModelId(input.attempt.modelId),
        ...(input.thread.projectId === undefined ? {} : { projectId: input.thread.projectId }),
      };
      this.#nativeHarness?.turnStarted(harnessScope);
      await Effect.runPromise(
        Effect.scoped(
          this.#turnRunner.run({
            thread: input.thread,
            attempt: input.attempt,
            prompt: input.prompt,
            context: [
              ...(this.#nativeHarness?.contextFor(harnessScope) ?? []),
              ...input.prepared.context.providerContext,
            ],
            ...(this.#nativeHarness === undefined
              ? {}
              : {
                  onTurnCompleted: (completed) =>
                    this.#nativeHarness!.turnCompleted({
                      ...harnessScope,
                      ...completed,
                      contextSubject: input.prepared.context.subject,
                    }),
                }),
            scratchRoot,
            driver: this.#driver(providerInstanceId),
            providerInstanceId,
            serviceLimits: input.prepared.serviceLimits,
            contextSubject: input.prepared.context.subject,
            contextPlanId: input.prepared.context.snapshot.next.plan.id,
            requestShape: "chat-turn",
            varianceReserve: input.prepared.context.snapshot.next.plan.reserves.variance,
            reservationId,
            estimatedTokens: input.prepared.context.snapshot.next.plan.plannedInputTokens,
            attachments: input.prepared.attachments,
            researchEnabled: input.thread.researchEnabled,
            researchRoute: input.prepared.researchRoute,
            ...(input.prepared.appManagedTools === undefined
              ? {}
              : { appManagedTools: input.prepared.appManagedTools }),
            ...(input.mode === "resume" && input.attempt.resumeCursor !== undefined
              ? { mode: "resume" as const, resumeCursor: input.attempt.resumeCursor }
              : {}),
            clock: () => this.#clock(),
            signal: controller.signal,
            persistAttempt: (attempt) =>
              Effect.tryPromise({
                try: () => persistAttempt(attempt),
                catch: () =>
                  decodeChatFailure({
                    category: "unavailable",
                    message: "Chat attempt persistence failed.",
                  }),
              }),
            persistProviderFailure: (attempt, failure) =>
              Effect.tryPromise({
                try: () => persistAttempt(attempt, failure),
                catch: () =>
                  decodeChatFailure({
                    category: "unavailable",
                    message: "Chat provider failure could not be persisted.",
                  }),
              }),
            persistResponse: (text) =>
              Effect.try({
                try: () => {
                  const content = this.#prepareContent(input.thread.id, "assistant", text);
                  pendingContent.set(String(content.reference.contentId), content);
                  return content.reference;
                },
                catch: () =>
                  decodeChatFailure({
                    category: "failed",
                    message: "Chat transcript content is invalid.",
                  }),
              }),
            persistCitation: (event, backend) =>
              Effect.try({
                try: () => {
                  const citationId = decodeChatCitationId(this.#uuid());
                  const snippet =
                    event.snippet === undefined
                      ? undefined
                      : this.#prepareContent(input.thread.id, "snippet", event.snippet);
                  const citation = decodeChatCitation({
                    citationId,
                    threadId: input.thread.id,
                    turnId: input.turn.id,
                    attemptId: input.attempt.id,
                    sourceTitle: event.sourceTitle,
                    sourceUrl: event.sourceUrl,
                    backend,
                    ...(snippet === undefined ? {} : { snippetRef: snippet.reference }),
                    retrievedAt: decodeTimestamp(this.#clock()),
                  });
                  const version = readAggregateVersion(
                    this.#persistence.connection,
                    "chat-thread",
                    input.thread.id,
                  );
                  this.#persistence.journal.append(
                    {
                      aggregate: { aggregateType: "chat-thread", aggregateId: input.thread.id },
                      expectedVersion: version,
                      events: [
                        this.#pending("chat.citation-recorded@1", {
                          kind: "citation-recorded",
                          citation,
                        }),
                      ],
                    },
                    snippet === undefined
                      ? undefined
                      : {
                          beforeEvents: (connection) =>
                            this.#writePreparedContent(connection, snippet),
                        },
                  );
                  return citationId;
                },
                catch: () =>
                  decodeChatFailure({
                    category: "unavailable",
                    message: "Chat citation persistence failed.",
                  }),
              }),
          }),
        ),
      );
    } catch {
      const currentView = this.#persistence.readChatThreadView(input.thread.id);
      const currentAttempt = currentView?.turns
        .flatMap((turn) => turn.attempts)
        .find((candidate) => String(candidate.id) === String(input.attempt.id));
      if (
        currentAttempt !== undefined &&
        currentAttempt.outcome !== "completed" &&
        currentAttempt.outcome !== "failed" &&
        currentAttempt.outcome !== "cancelled" &&
        currentAttempt.outcome !== "interrupted" &&
        currentAttempt.outcome !== "waiting"
      ) {
        await persistAttempt(
          transitionChatAttempt(currentAttempt, {
            outcome: "interrupted",
            updatedAt: decodeTimestamp(this.#clock()),
          }),
        );
      }
    } finally {
      this.#activeAttempts.delete(String(input.attempt.id));
      this.#activeThreadExecutions.delete(String(input.thread.id));
    }
  }

  #prepareContent(
    threadId: ChatThreadId,
    role: "user" | "assistant" | "research" | "snippet",
    body: string,
  ): PreparedChatContent {
    const contentId = this.#uuid();
    const digest = createHash("sha256").update(body).digest("hex");
    const byteLength = new TextEncoder().encode(body).byteLength;
    const validated = decodeChatContentBody({
      contentId,
      role,
      body,
      digest,
      byteLength,
    });
    return {
      reference: {
        contentId: validated.contentId,
        digest: validated.digest,
        byteLength: validated.byteLength,
      },
      input: {
        contentId: String(validated.contentId),
        threadId: String(threadId),
        role: validated.role,
        body: validated.body,
        digest: validated.digest,
        byteLength: validated.byteLength,
      },
    };
  }

  #writePreparedContent(connection: SqliteConnection, content: PreparedChatContent): void {
    writeChatContent(connection, content.input);
  }

  #historicalAttachmentOmissions(
    thread: ChatThread,
    targetProbe: ProviderProbeResult,
    targetModelId: ProviderModelId,
  ): ReadonlyArray<ChatHandoffWarning["omittedAttachments"][number]> {
    const model = targetProbe.models.find((candidate) => candidate.id === targetModelId);
    const priorAttachmentIds = new Set(
      (this.#persistence.readChatThreadView(thread.id)?.turns ?? []).flatMap((turn) =>
        turn.attachmentIds.map(String),
      ),
    );
    return (this.#persistence.readChatThreadView(thread.id)?.attachments ?? []).flatMap(
      (attachment) => {
        if (!priorAttachmentIds.has(String(attachment.id)) || attachment.status !== "finalized") {
          return [];
        }
        const reason =
          targetProbe.capabilities.nativeAttachments === "unsupported"
            ? "native-attachments-unsupported"
            : targetProbe.capabilities.nativeAttachments !== "supported"
              ? "native-attachments-unavailable"
              : (() => {
                  const modality = attachmentMediaTypeToModality(attachment.mediaType);
                  return modality === undefined || !model?.inputModalities.includes(modality)
                    ? "attachment-modality-unsupported"
                    : undefined;
                })();
        return reason === undefined
          ? []
          : [
              {
                attachmentId: attachment.id,
                displayName: attachment.displayName,
                mediaType: attachment.mediaType,
                reason,
              },
            ];
      },
    );
  }

  #contextEntry(
    thread: ChatThread,
    category:
      | "user-instructions"
      | "current-request"
      | "conversation"
      | "workspace-context"
      | "project-memory"
      | "octant-tools",
    body: string,
    tokens: number,
    posture: "required" | "compressible",
    source: ContextSourceRef,
    state: "included" | "referenced" | "omitted" = "included",
    /**
     * Present when a journaled summary already stands for this material. The
     * entry keeps its canonical original size but contributes nothing to the
     * request, because the summary carries it instead.
     */
    compaction?: { readonly summaryId: ContextSummaryId },
  ) {
    const includedSize =
      compaction !== undefined
        ? 0
        : state === "omitted"
          ? 0
          : state === "referenced"
            ? Math.min(tokens, 32)
            : tokens;
    return decodeContextEntry({
      id: this.#uuid(),
      source,
      category,
      // Context entry labels must satisfy NonEmptyTrimmedString: slicing the
      // body can leave leading/trailing whitespace (e.g. an assistant reply
      // whose first 64 chars end in newlines), which made every follow-up send
      // in such threads fail decode and surface as a generic unavailable.
      label: body.slice(0, 64).trim() || category,
      eligibility: {
        providerInstanceId: decodeProviderInstanceId(thread.providerInstanceId),
        status: state === "omitted" ? "ineligible" : "eligible",
        reason: state === "omitted" ? "provider-mismatch" : "selected-provider",
      },
      posture,
      retention: "active",
      priority: posture === "required" ? 100 : 20,
      originalSize: tokens,
      includedSize,
      tokens: {
        kind: "known",
        tokens: compaction === undefined ? tokens : 0,
        accuracy: "conservative-heuristic",
      },
      state: compaction === undefined ? state : "summarized",
      introducedAtTurn: 1,
      reuseCount: 0,
      preview: { redacted: true, label: `${category} hidden` },
      ...(compaction === undefined ? {} : { summaryId: compaction.summaryId }),
    });
  }

  #toEventFrame(
    threadId: ChatThreadId,
    envelope: {
      readonly globalSequence: number;
      readonly eventName: string;
      readonly payload: unknown;
    },
  ): ChatEventFrame | undefined {
    try {
      const event = decodeChatPublicEvent(envelope.payload);
      if (event.kind === "settings-updated") {
        return undefined;
      }
      if (
        "thread" in event &&
        event.thread !== undefined &&
        String((event as { thread: ChatThread }).thread.id) !== String(threadId)
      ) {
        return undefined;
      }
      if ("threadId" in event && String(event.threadId) !== String(threadId)) {
        return undefined;
      }
      if (
        "turn" in event &&
        String((event as { turn: ChatTurn }).turn.threadId) !== String(threadId)
      ) {
        return undefined;
      }
      if (
        "attempt" in event &&
        String((event as { attempt: ChatAttempt }).attempt.threadId) !== String(threadId)
      ) {
        return undefined;
      }
      if (
        "decision" in event &&
        String((event as { decision: { threadId: ChatThreadId } }).decision.threadId) !==
          String(threadId)
      ) {
        return undefined;
      }
      if (
        "attachment" in event &&
        String((event as { attachment: ChatAttachment }).attachment.threadId) !== String(threadId)
      ) {
        return undefined;
      }
      if ("citation" in event && String(event.citation.threadId) !== String(threadId)) {
        return undefined;
      }
      if (
        "workItem" in event &&
        String((event as { workItem: { threadId: ChatThreadId } }).workItem.threadId) !==
          String(threadId)
      ) {
        return undefined;
      }
      if (
        "followUp" in event &&
        String((event as { followUp: { threadId: ChatThreadId } }).followUp.threadId) !==
          String(threadId)
      ) {
        return undefined;
      }
      return decodeChatEventFrame({
        threadId,
        sequence: envelope.globalSequence,
        event,
      });
    } catch {
      return undefined;
    }
  }

  #requireActiveThread(threadId: ChatThreadId): ChatThread {
    const thread = this.#persistence.readChatThread(threadId);
    if (thread === undefined || thread.lifecycle === "deleted") {
      throw new ChatServiceError({
        category: "invalid",
        message: "Chat thread was not found.",
      });
    }
    if (thread.lifecycle !== "active") {
      throw new ChatServiceError({
        category: "invalid",
        message: `Chat thread is ${thread.lifecycle}.`,
      });
    }
    const aggregateVersion = readAggregateVersion(
      this.#persistence.connection,
      "chat-thread",
      threadId,
    );
    return { ...thread, version: aggregateVersion };
  }

  #requireLifecycleMutableThread(threadId: ChatThreadId): ChatThread {
    const thread = this.#persistence.readChatThread(threadId);
    if (thread === undefined || thread.lifecycle === "deleted") {
      throw new ChatServiceError({
        category: "invalid",
        message: "Chat thread was not found.",
      });
    }
    if (thread.lifecycle === "deleting") {
      throw new ChatServiceError({
        category: "invalid",
        message: "Chat thread is being deleted.",
      });
    }
    const aggregateVersion = readAggregateVersion(
      this.#persistence.connection,
      "chat-thread",
      threadId,
    );
    return { ...thread, version: aggregateVersion };
  }

  #assertNoActiveTurn(view: ChatThreadView | undefined, threadId: ChatThreadId): void {
    const active = view?.turns
      .flatMap((turn) => turn.attempts)
      .find((attempt) => attempt.outcome === "queued" || attempt.outcome === "streaming");
    if (active !== undefined || this.#activeThreadExecutions.has(String(threadId))) {
      throw new ChatServiceError({
        category: "waiting",
        message: "A Chat response is already running for this thread.",
      });
    }
  }

  #withAggregateHeadVersion(thread: ChatThread): ChatThread {
    const version = readAggregateVersion(this.#persistence.connection, "chat-thread", thread.id);
    return { ...thread, version };
  }

  async #withThreadAdmission<T>(threadId: ChatThreadId, work: () => Promise<T>): Promise<T> {
    const key = String(threadId);
    const previous = this.#threadAdmissions.get(key) ?? Promise.resolve();
    let releaseCurrent: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const queued = previous.then(() => current);
    this.#threadAdmissions.set(key, queued);
    await previous;
    try {
      return await work();
    } finally {
      releaseCurrent?.();
      if (this.#threadAdmissions.get(key) === queued) {
        this.#threadAdmissions.delete(key);
      }
    }
  }

  #assertExpectedThreadVersion(thread: ChatThread, expectedVersion: AggregateVersion): void {
    if (thread.version !== expectedVersion) {
      throw new ChatServiceError(
        decodeChatFailure({
          category: "stale",
          message: "Chat thread changed; reload and retry.",
        }),
      );
    }
  }

  #assertActiveChatProject(projectId: Parameters<PersistenceService["readProject"]>[0]): void {
    const project = this.#persistence.readProject(projectId);
    if (project === undefined || project.lifecycle !== "active" || project.type !== "chat") {
      throw new ChatServiceError({
        category: "invalid",
        message: "Chat project membership is invalid.",
      });
    }
  }

  #requireThreadView(threadId: ChatThreadId): ChatThreadView {
    const view = this.#persistence.readChatThreadView(threadId);
    if (view === undefined) {
      throw new ChatServiceError({
        category: "invalid",
        message: "Chat thread was not found.",
      });
    }
    return view;
  }

  #assertReadableThread(threadId: ChatThreadId): void {
    const thread = this.#persistence.readChatThread(threadId);
    if (thread === undefined || thread.lifecycle === "deleted") {
      throw new ChatServiceError({
        category: "invalid",
        message: "Chat thread was not found.",
      });
    }
    if (thread.lifecycle === "deleting") {
      throw new ChatServiceError({
        category: "invalid",
        message: "Chat thread is being deleted.",
      });
    }
  }

  #assertReady(): void {
    const status = this.#persistence.status();
    if (status.state !== "current" || status.integrity !== "ok") {
      throw this.#unavailable();
    }
  }

  #assertChatEnabled(): void {
    this.#assertReady();
    const settings = this.#persistence.readShellSettings()?.settings ?? defaultShellSettings();
    if (!settings.chatEnabled) {
      throw new ChatServiceError({
        category: "unavailable",
        message: "Chat mode is disabled.",
      });
    }
  }

  #isThreadWorkCommand(input: unknown): boolean {
    return (
      typeof input === "object" &&
      input !== null &&
      "kind" in input &&
      typeof input.kind === "string" &&
      (input.kind.endsWith("-chat-work-item") ||
        input.kind === "reorder-chat-work-items" ||
        input.kind === "open-chat-follow-up" ||
        input.kind === "complete-chat-follow-up")
    );
  }

  #pending(
    eventName: string,
    payload: unknown,
    options?: { readonly correlationId?: CorrelationId },
  ) {
    return {
      eventId: decodeEventId(this.#uuid()),
      eventName,
      eventVersion: 1,
      hostId: LOCAL_HOST_ID,
      correlationId: options?.correlationId ?? decodeCorrelationId(this.#uuid()),
      actor: { kind: "local-user" as const, actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
      occurredAt: decodeTimestamp(this.#clock()),
      payload,
    };
  }

  #mapFailure(error: unknown): ChatServiceError {
    if (error instanceof ThreadWorkServiceError) {
      return new ChatServiceError(error.failure);
    }
    if (error instanceof ContextHarnessError) {
      return new ChatServiceError(
        decodeChatFailure({
          category:
            error.category === "stale"
              ? "stale"
              : error.category === "blocked"
                ? "waiting"
                : error.category === "invalid"
                  ? "invalid"
                  : "unavailable",
          message: error.message,
        }),
      );
    }
    if (error instanceof ChatServiceError) return error;
    if (error instanceof ChatPolicyRejected) {
      return new ChatServiceError(
        decodeChatFailure({
          category: error.code === "stale-version" ? "stale" : "invalid",
          message: error.message,
        }),
      );
    }
    if (error instanceof ConcurrencyConflict) {
      return new ChatServiceError(
        decodeChatFailure({
          category: "stale",
          message: "Chat thread changed; reload and retry.",
        }),
      );
    }
    if (error instanceof JournalWriteFailed || error instanceof ProjectionApplicationFailed) {
      return new ChatServiceError(
        decodeChatFailure({
          category: "unavailable",
          message: "Chat persistence is temporarily unavailable.",
        }),
      );
    }
    return new ChatServiceError(
      decodeChatFailure({
        category: "unavailable",
        message: "Chat service is unavailable.",
      }),
    );
  }

  #unavailable(): ChatServiceError {
    return new ChatServiceError(
      decodeChatFailure({
        category: "unavailable",
        message: "Chat service is unavailable.",
      }),
    );
  }
}
