import { homedir } from "node:os";
import type {
  AgentProfile,
  AgentProfileId,
  AgentProfileScope,
  ChatThread,
  ChatNavigationThread,
  ChatThreadId,
  ChatThreadView,
  CodeCheckoutId,
  CodeCheckoutIdentity,
  CodeFileId,
  CodeFileReference,
  CodeReviewFindingId,
  CodeReviewFinding,
  CodeRuntimeWork,
  CodeRuntimeWorkId,
  CodeThread,
  CodeThreadActivity,
  CodeThreadId,
  CodeThreadView,
  MemoryEntry,
  MemoryEntryId,
  ProfileScopeKind,
  Project,
  ProjectId,
  ProjectMemoryView,
  ProviderDefaults,
  ProviderCatalogSnapshot,
  ProviderInstance,
  ProductFeedbackNote,
  ProductFeedbackNoteId,
  ProviderInstanceId,
  ThreadCheckpoint,
  ThreadCheckpointId,
  WindowId,
  ZenSpace,
  ZenSpaceId,
} from "@octant/contracts";
import { Context, Data, Effect, Layer } from "effect";
import { classifySqliteFailure } from "./journalErrors";
import { Journal } from "./journal";
import {
  BackupVerificationFailed,
  DataLifecycleOperationFailed,
  MigrationDowngradeRefused,
  MigrationInterruptedRestored,
  PathOutsideDataDirectory,
  StoreBackupFailed,
  StoreRestoreFailed,
} from "./dataLifecycleErrors";
import { hasPendingLocalDataRemoval } from "./dataLifecycle";
import { migrateStoreWithBackup } from "./migrationBackup";
import { backupPathFor, createStoreBackup, type StoreBackupReceipt } from "./storeBackup";
import {
  DatabaseVersionTooNew,
  MigrationChecksumMismatch,
  MigrationFailed,
  MigrationHistoryMismatch,
} from "./migrationErrors";
import { MIGRATIONS } from "./migrations";
import { compactSupersededCheckoutObservations } from "./journalCompaction";
import {
  CheckpointAheadOfJournal,
  ProjectionQuarantined,
  ProjectionRegistry,
  ProjectionStorageFailed,
  catchUpProjection,
  quarantineIncompatibleJournal,
} from "./projection";
import {
  readMemoryEntry,
  readProject,
  readProjectMemory,
  readProjects,
  searchProjects,
  type ProjectReadFilter,
} from "./projectProjection";
import {
  readAgentProfile,
  readAgentProfileBinding,
  readAgentProfiles,
  readProfilesForScope,
} from "./agentProfileProjection";
import {
  readChatContent,
  readChatSettings,
  readChatThread,
  readChatThreads,
  readChatNavigation,
  readChatThreadView,
  readPendingChatPurges,
  searchChatThreads,
  searchChatTranscript,
  type ChatTranscriptSearchRows,
  type ProjectedChatSettings,
} from "./chatProjection";
import type { PendingChatPurge, ProjectedChatContent } from "./chatPersistenceSchema";
import type { ProjectedCodeSettings } from "./codePersistenceSchema";
import {
  readCodeCheckout,
  readCodeCheckoutAggregateVersion,
  readCodeCheckouts,
  readCodeFileReference,
  readCodeFileReferences,
  readCodeRuntimeWork,
  readCodeRuntimeWorks,
  readCodeReviewFinding,
  readCodeReviewFindings,
  readCodeSettings,
  readCodeThread,
  readCodeThreadActivity,
  readCodeThreads,
  readCodeThreadView,
  reconcileCodeRestart,
  type ProjectedCodeRuntimeWork,
} from "./codeProjection";
import { readProductFeedbackNote, readProductFeedbackNotes } from "./productFeedbackProjection";
import { readThreadCheckpoint, readThreadCheckpoints } from "./threadCheckpointProjection";
import { databaseStatus, rebuildAll, type DatabaseStatus } from "./recovery";
import {
  readProviderDefaults,
  readProviderCatalog,
  readProviderCatalogs,
  readProviderInstance,
  readProviderInstances,
} from "../providers/providerProjection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import {
  readShellSettings,
  readWindowWorkspace,
  readWindowWorkspaces,
  readEnvironmentPresentation,
  type ProjectedShellSettings,
  type ProjectedWindowWorkspace,
  type ProjectedEnvironmentPresentation,
} from "./shellProjection";
import { openSqlite, type SqliteConnection } from "./sqlitePort";
import { prepareStore } from "./storePath";
import { loadZenSpace, loadZenSpaceByWindowId, loadZenSpaces } from "./zenProjection";
import { readThemeSettings, type ProjectedThemeSettings } from "./themeProjection";
import type { AgentRunProjection } from "../agentRun/agentRunProjection";
import type { AutomationProjection } from "../automation/automationProjection";
import type { CanvasProjection } from "../canvas/canvasProjection";
import type { GithubCloneProjection } from "./githubCloneProjection";
import type { ImageJobProjection } from "../image/imageJobProjection";

export interface VerifiedStoreBackupReceipt extends StoreBackupReceipt {
  readonly path: string;
}

export interface PersistenceService {
  readonly dataDirectory: string;
  readonly connection: SqliteConnection;
  /**
   * Creates a verified online backup of the live store through the owner's
   * open connection. The label is a confined identifier, never a path; the
   * snapshot always lands beside the canonical store inside the data
   * directory.
   */
  readonly createVerifiedBackup: (label: string) => VerifiedStoreBackupReceipt;
  readonly journal: Journal;
  readonly projections: ProjectionRegistry;
  readonly agentRunProjection: AgentRunProjection;
  readonly canvasProjection: CanvasProjection;
  readonly automationProjection: AutomationProjection;
  readonly githubCloneProjection: GithubCloneProjection;
  readonly imageJobProjection: ImageJobProjection;
  readonly readShellSettings: () => ProjectedShellSettings | undefined;
  readonly readWindowWorkspace: (windowId: WindowId) => ProjectedWindowWorkspace | undefined;
  readonly readWindowWorkspaces: () => ReadonlyArray<ProjectedWindowWorkspace>;
  readonly readEnvironmentPresentation: (
    windowId: WindowId,
  ) => ProjectedEnvironmentPresentation | undefined;
  readonly readProject: (projectId: ProjectId) => Project | undefined;
  readonly readProjects: (filter?: ProjectReadFilter) => ReadonlyArray<Project>;
  readonly searchProjects: (query: string, filter?: ProjectReadFilter) => ReadonlyArray<Project>;
  readonly readMemoryEntry: (
    projectId: ProjectId,
    entryId: MemoryEntryId,
  ) => MemoryEntry | undefined;
  readonly readProjectMemory: (projectId: ProjectId) => ProjectMemoryView;
  readonly readProviderInstance: (instanceId: ProviderInstanceId) => ProviderInstance | undefined;
  readonly readProviderInstances: () => ReadonlyArray<ProviderInstance>;
  readonly readProviderDefaults: () => ProviderDefaults;
  readonly readProviderCatalog?: (
    instanceId: ProviderInstanceId,
  ) => ProviderCatalogSnapshot | undefined;
  readonly readProviderCatalogs?: () => ReadonlyArray<ProviderCatalogSnapshot>;
  readonly readChatSettings: () => ProjectedChatSettings | undefined;
  readonly readChatThread: (threadId: ChatThreadId) => ChatThread | undefined;
  readonly readChatThreads: () => ReadonlyArray<ChatThread>;
  readonly readChatNavigation: () => ReadonlyArray<ChatNavigationThread>;
  readonly readChatThreadView: (threadId: ChatThreadId) => ChatThreadView | undefined;
  readonly readChatContent: (contentId: string) => ProjectedChatContent | undefined;
  readonly searchChatThreads: (query: string) => ReadonlyArray<ChatThread>;
  readonly searchChatTranscript: (query: string) => ChatTranscriptSearchRows;
  readonly readPendingChatPurges: () => ReadonlyArray<PendingChatPurge>;
  readonly readThreadCheckpoint: (checkpointId: ThreadCheckpointId) => ThreadCheckpoint | undefined;
  readonly readThreadCheckpoints: (threadId: string) => ReadonlyArray<ThreadCheckpoint>;
  readonly readProductFeedbackNote: (
    noteId: ProductFeedbackNoteId,
  ) => ProductFeedbackNote | undefined;
  readonly readProductFeedbackNotes: (threadId: string) => ReadonlyArray<ProductFeedbackNote>;
  readonly readCodeSettings: () => ProjectedCodeSettings | undefined;
  readonly readThemeSettings: () => ProjectedThemeSettings | undefined;
  readonly readCodeThread: (threadId: CodeThreadId) => CodeThread | undefined;
  readonly readCodeThreads: () => ReadonlyArray<CodeThread>;
  readonly readCodeThreadActivity: () => ReadonlyArray<CodeThreadActivity>;
  readonly readCodeCheckout: (checkoutId: CodeCheckoutId) => CodeCheckoutIdentity | undefined;
  readonly readCodeCheckoutAggregateVersion: (checkoutId: CodeCheckoutId) => number;
  readonly readCodeCheckouts: () => ReadonlyArray<CodeCheckoutIdentity>;
  readonly readCodeFileReference: (fileId: CodeFileId) => CodeFileReference | undefined;
  readonly readCodeFileReferences: (threadId: CodeThreadId) => ReadonlyArray<CodeFileReference>;
  readonly readCodeRuntimeWork: (workId: CodeRuntimeWorkId) => CodeRuntimeWork | undefined;
  readonly readCodeRuntimeWorks: (
    threadId: CodeThreadId,
  ) => ReadonlyArray<ProjectedCodeRuntimeWork>;
  readonly readCodeReviewFinding: (findingId: CodeReviewFindingId) => CodeReviewFinding | undefined;
  readonly readCodeReviewFindings: (threadId: CodeThreadId) => ReadonlyArray<CodeReviewFinding>;
  readonly readCodeThreadView: (threadId: CodeThreadId) => CodeThreadView | undefined;
  readonly readZenSpace: (spaceId: ZenSpaceId) => ZenSpace | null;
  readonly readZenSpaceByWindowId: (windowId: WindowId) => ZenSpace | null;
  readonly readZenSpaces: () => ReadonlyArray<ZenSpace>;
  readonly readAgentProfile: (profileId: AgentProfileId) => AgentProfile | undefined;
  readonly readAgentProfileBinding: (
    profileId: AgentProfileId,
  ) => { readonly profile: AgentProfile; readonly scope: AgentProfileScope } | undefined;
  readonly readAgentProfiles: () => ReadonlyArray<AgentProfile>;
  readonly readProfilesForScope: (
    scopeKind: ProfileScopeKind,
    scopeRef: string,
  ) => ReadonlyArray<AgentProfile>;
  readonly status: () => DatabaseStatus;
  readonly projectionCatchUp: ReadonlyArray<{
    readonly projection: string;
    readonly durationMs: number;
  }>;
}

export class Persistence extends Context.Tag("@octant/server/Persistence")<
  Persistence,
  PersistenceService
>() {}

export type PersistenceFailureCategory =
  | "migration-incompatible"
  | "recovery-required"
  | "storage-busy"
  | "storage-unavailable";

export class PersistenceStartupFailed extends Data.TaggedError("PersistenceStartupFailed")<{
  readonly category: PersistenceFailureCategory;
  readonly message: string;
}> {}

export interface PersistenceLiveOptions {
  readonly dataDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly clock?: () => string;
  readonly openConnection?: (path: string) => SqliteConnection;
}

export function makePersistenceLive(
  options: PersistenceLiveOptions,
): Layer.Layer<Persistence, PersistenceStartupFailed> {
  return Layer.scoped(
    Persistence,
    Effect.acquireRelease(
      Effect.tryPromise({
        try: () => acquirePersistence(options),
        catch: redactStartupFailure,
      }),
      (service) => Effect.sync(() => service.connection.close()),
    ),
  );
}

export const PersistenceLive = makePersistenceLive({ environment: process.env });

async function acquirePersistence(options: PersistenceLiveOptions): Promise<PersistenceService> {
  const clock = options.clock ?? (() => new Date().toISOString());
  const store = await prepareStore({
    env:
      options.environment ??
      (options.dataDirectory === undefined ? {} : { OCTANT_DATA_DIR: options.dataDirectory }),
    platform: process.platform,
    home: homedir(),
  });
  // A staged database is an authoritative pending destructive operation. Do
  // not create a replacement canonical store on ordinary startup: recovery
  // must reconcile the Keychain result through the maintenance remove command.
  if (
    hasPendingLocalDataRemoval({
      dataDirectory: store.directory,
      databasePath: store.databasePath,
    })
  ) {
    throw new PersistenceStartupFailed({
      category: "recovery-required",
      message: "Octant storage requires recovery before startup.",
    });
  }
  const migration = migrateStoreWithBackup({
    databasePath: store.databasePath,
    dataDirectory: store.directory,
    migrations: MIGRATIONS,
    clock,
    openConnection: options.openConnection ?? openSqlite,
  });
  const connection = migration.connection;

  try {
    const runtime = createPhase1RuntimeRegistries();
    const projections = runtime.projections;
    const journal = new Journal({ connection, registry: runtime.events, projections, clock });
    const compatibility = journal.inspectCompatibility();
    if (!compatibility.compatible) {
      quarantineIncompatibleJournal({
        connection,
        projections,
        issue: compatibility.issue,
        clock,
      });
    }

    const projectionCatchUp: Array<{
      readonly projection: string;
      readonly durationMs: number;
    }> = [];
    for (const projection of projections.all()) {
      const startedAt = performance.now();
      catchUpProjection({ connection, journal, projection, clock });
      projectionCatchUp.push({
        projection: projection.name,
        durationMs: Math.max(0, performance.now() - startedAt),
      });
    }
    // After catch-up so heads and the checkout projection are current, and
    // before restart reconciliation so its append continues from the compacted
    // head rather than racing the renumbering.
    const compaction = compactSupersededCheckoutObservations(connection);
    if (compaction.eventsRemoved > 0) {
      console.warn(
        `Octant journal compaction removed ${compaction.eventsRemoved} superseded checkout observation(s) across ${compaction.checkoutsCompacted} checkout(s).`,
      );
    }
    reconcileCodeRestart({ connection, journal, reconciledAt: clock() });

    let status = databaseStatus({ connection, journal, projections, compatibility });
    // A previously quarantined event can become readable after a compatible
    // persisted-event upcast ships. Quarantine is projection state, not journal
    // authority, so retry the atomic rebuild once before requiring operator
    // recovery. A genuinely invalid event quarantines again during replay and
    // the status check below still fails closed without changing the journal.
    if (status.state === "quarantined" && status.integrity === "ok" && compatibility.compatible) {
      rebuildAll({ connection, journal, projections, clock });
      status = databaseStatus({ connection, journal, projections, compatibility });
    }
    if (status.state !== "current" || status.integrity !== "ok") {
      throw new PersistenceStartupFailed({
        category: "recovery-required",
        message: "Octant storage requires recovery before startup.",
      });
    }
    return {
      dataDirectory: store.directory,
      connection,
      createVerifiedBackup: (label) => {
        if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(label)) {
          throw new StoreBackupFailed({ operation: "create" });
        }
        const backupPath = backupPathFor(store.databasePath, label);
        const receipt = createStoreBackup({
          connection,
          dataDirectory: store.directory,
          backupPath,
        });
        return { ...receipt, path: backupPath };
      },
      journal,
      projections,
      agentRunProjection: runtime.agentRunProjection,
      canvasProjection: runtime.canvasProjection,
      automationProjection: runtime.automationProjection,
      githubCloneProjection: runtime.githubCloneProjection,
      imageJobProjection: runtime.imageJobProjection,
      readShellSettings: () => readShellSettings(connection),
      readWindowWorkspace: (windowId) => readWindowWorkspace(connection, windowId),
      readWindowWorkspaces: () => readWindowWorkspaces(connection),
      readEnvironmentPresentation: (windowId) => readEnvironmentPresentation(connection, windowId),
      readProject: (projectId) => readProject(connection, projectId),
      readProjects: (filter) => readProjects(connection, filter),
      searchProjects: (query, filter) => searchProjects(connection, query, filter),
      readMemoryEntry: (projectId, entryId) => readMemoryEntry(connection, projectId, entryId),
      readProjectMemory: (projectId) => readProjectMemory(connection, projectId),
      readProviderInstance: (instanceId) => readProviderInstance(connection, instanceId),
      readProviderInstances: () => readProviderInstances(connection),
      readProviderDefaults: () => readProviderDefaults(connection),
      readProviderCatalog: (instanceId) => readProviderCatalog(connection, instanceId),
      readProviderCatalogs: () => readProviderCatalogs(connection),
      readChatSettings: () => readChatSettings(connection),
      readChatThread: (threadId) => readChatThread(connection, threadId),
      readChatThreads: () => readChatThreads(connection),
      readChatNavigation: () => readChatNavigation(connection),
      readChatThreadView: (threadId) => readChatThreadView(connection, threadId),
      readChatContent: (contentId) => readChatContent(connection, contentId),
      searchChatThreads: (query) => searchChatThreads(connection, query),
      searchChatTranscript: (query) => searchChatTranscript(connection, query),
      readPendingChatPurges: () => readPendingChatPurges(connection),
      readThreadCheckpoint: (checkpointId) => readThreadCheckpoint(connection, checkpointId),
      readThreadCheckpoints: (threadId) => readThreadCheckpoints(connection, threadId),
      readProductFeedbackNote: (noteId) => readProductFeedbackNote(connection, noteId),
      readProductFeedbackNotes: (threadId) => readProductFeedbackNotes(connection, threadId),
      readCodeSettings: () => readCodeSettings(connection),
      readThemeSettings: () => readThemeSettings(connection),
      readCodeThread: (threadId) => readCodeThread(connection, threadId),
      readCodeThreads: () => readCodeThreads(connection),
      readCodeThreadActivity: () => readCodeThreadActivity(connection),
      readCodeCheckout: (checkoutId) => readCodeCheckout(connection, checkoutId),
      readCodeCheckoutAggregateVersion: (checkoutId) =>
        readCodeCheckoutAggregateVersion(connection, checkoutId),
      readCodeCheckouts: () => readCodeCheckouts(connection),
      readCodeFileReference: (fileId) => readCodeFileReference(connection, fileId),
      readCodeFileReferences: (threadId) => readCodeFileReferences(connection, threadId),
      readCodeRuntimeWork: (workId) => readCodeRuntimeWork(connection, workId),
      readCodeRuntimeWorks: (threadId) => readCodeRuntimeWorks(connection, threadId),
      readCodeReviewFinding: (findingId) => readCodeReviewFinding(connection, findingId),
      readCodeReviewFindings: (threadId) => readCodeReviewFindings(connection, threadId),
      readCodeThreadView: (threadId) => readCodeThreadView(connection, threadId),
      readZenSpace: (spaceId) => loadZenSpace(connection, spaceId),
      readZenSpaceByWindowId: (windowId) => loadZenSpaceByWindowId(connection, windowId),
      readZenSpaces: () => loadZenSpaces(connection),
      readAgentProfile: (profileId) => readAgentProfile(connection, profileId),
      readAgentProfileBinding: (profileId) => readAgentProfileBinding(connection, profileId),
      readAgentProfiles: () => readAgentProfiles(connection),
      readProfilesForScope: (scopeKind, scopeRef) =>
        readProfilesForScope(connection, scopeKind, scopeRef),
      status: () => databaseStatus({ connection, journal, projections }),
      projectionCatchUp,
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}

function redactStartupFailure(error: unknown): PersistenceStartupFailed {
  if (error instanceof PersistenceStartupFailed) return error;
  if (
    error instanceof MigrationChecksumMismatch ||
    error instanceof MigrationHistoryMismatch ||
    error instanceof DatabaseVersionTooNew ||
    error instanceof MigrationFailed ||
    error instanceof MigrationDowngradeRefused ||
    error instanceof MigrationInterruptedRestored
  ) {
    return new PersistenceStartupFailed({
      category: "migration-incompatible",
      message: "Octant cannot use this database migration state.",
    });
  }
  if (
    error instanceof StoreBackupFailed ||
    error instanceof StoreRestoreFailed ||
    error instanceof BackupVerificationFailed ||
    error instanceof DataLifecycleOperationFailed ||
    error instanceof PathOutsideDataDirectory
  ) {
    return new PersistenceStartupFailed({
      category: "recovery-required",
      message: "Octant storage requires recovery before startup.",
    });
  }
  if (error instanceof ProjectionQuarantined || error instanceof CheckpointAheadOfJournal) {
    return new PersistenceStartupFailed({
      category: "recovery-required",
      message: "Octant storage requires recovery before startup.",
    });
  }
  if (error instanceof ProjectionStorageFailed) {
    return storageFailure(error.category);
  }
  const sqliteFailure = classifySqliteFailure(error);
  return storageFailure(sqliteFailure === "write-race" ? "busy" : "unavailable");
}

function storageFailure(category: "busy" | "unavailable"): PersistenceStartupFailed {
  return category === "busy"
    ? new PersistenceStartupFailed({
        category: "storage-busy",
        message: "Octant storage is busy; retry after other work stops.",
      })
    : new PersistenceStartupFailed({
        category: "storage-unavailable",
        message: "Octant storage is unavailable.",
      });
}
