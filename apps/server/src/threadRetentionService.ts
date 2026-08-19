import {
  ActorId,
  CorrelationId,
  EventId,
  LOCAL_HOST_ID,
  THREAD_RETENTION_EVENT_NAMES,
  UtcTimestamp,
  decodeProjectId,
  type OctantMode,
  type ProjectId,
  type PurgeThreadsOutcome,
  type PurgeThreadsRequest,
  type SetThreadRetentionOutcome,
  type SetThreadRetentionRequest,
  type ThreadRetentionState,
  type ThreadRetentionThreadId,
} from "@octant/contracts";
import {
  decidePurgeThreads,
  decideSetRetentionWindow,
  selectThreadsForPurge,
  THREAD_PURGE_DELETED_SCOPES,
  THREAD_PURGE_RETAINED_SCOPES,
  type PrincipalKind,
  type ThreadRetentionSubject,
} from "@octant/domain";
import { Schema } from "effect";
import { readProject } from "./persistence/projectProjection";
import { readAggregateVersion } from "./persistence/chatProjection";
import type { Journal } from "./persistence/journal";
import type { SqliteConnection } from "./persistence/sqlitePort";
import {
  erasePurgedThread,
  listProjectedThreadSubjects,
  threadProjectionExists,
} from "./persistence/threadPurge";
import {
  readThreadPurgeTombstone,
  readThreadRetentionState,
  THREAD_RETENTION_AGGREGATE,
  THREAD_RETENTION_AGGREGATE_ID,
} from "./persistence/threadRetentionProjection";

const LOCAL_ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export interface ThreadRetentionWorkThread {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly updatedAt: string;
}

export interface ThreadRetentionServiceOptions {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly clock: () => string;
  readonly uuid: () => string;
  readonly listWorkThreads: () => ReadonlyArray<ThreadRetentionWorkThread>;
  readonly forgetWorkThread?: (threadId: string) => void;
  readonly purgeThreadArtifacts?: (input: {
    readonly mode: OctantMode;
    readonly threadId: ThreadRetentionThreadId;
  }) => Promise<void> | void;
}

export class ThreadRetentionService {
  readonly #connection: SqliteConnection;
  readonly #journal: Journal;
  readonly #clock: () => string;
  readonly #uuid: () => string;
  readonly #listWorkThreads: () => ReadonlyArray<ThreadRetentionWorkThread>;
  readonly #forgetWorkThread: ((threadId: string) => void) | undefined;
  readonly #purgeThreadArtifacts: ThreadRetentionServiceOptions["purgeThreadArtifacts"];

  constructor(options: ThreadRetentionServiceOptions) {
    this.#connection = options.connection;
    this.#journal = options.journal;
    this.#clock = options.clock;
    this.#uuid = options.uuid;
    this.#listWorkThreads = options.listWorkThreads;
    this.#forgetWorkThread = options.forgetWorkThread;
    this.#purgeThreadArtifacts = options.purgeThreadArtifacts;
  }

  readState(): ThreadRetentionState {
    return readThreadRetentionState(this.#connection);
  }

  setWindow(
    request: SetThreadRetentionRequest,
    principalKind: PrincipalKind,
  ): SetThreadRetentionOutcome {
    const existence = this.#existence(request.scope);
    const decision = decideSetRetentionWindow({
      principalKind,
      scope: request.scope,
      ...existence,
    });
    if (decision.kind === "refused") return decision;
    const updatedAt = decodeTimestamp(this.#clock());
    this.#append(THREAD_RETENTION_EVENT_NAMES.windowSet, {
      kind: "window-set",
      scope: request.scope,
      window: request.window,
      updatedAt,
    });
    return this.readState();
  }

  async purge(
    request: PurgeThreadsRequest,
    principalKind: PrincipalKind,
  ): Promise<PurgeThreadsOutcome> {
    const existence = this.#existence(request.scope);
    const decision = decidePurgeThreads({
      principalKind,
      confirm: request.confirm,
      scope: request.scope,
      ...existence,
    });
    if (decision.kind === "refused") return decision;
    const occurredAt = decodeTimestamp(this.#clock());
    const state = this.readState();
    const selected = selectThreadsForPurge({
      scope: request.scope,
      subjects: this.#subjects(),
      windows: state.windows,
      now: occurredAt,
    });
    const alreadyPurged =
      request.scope.kind === "thread" && existence.threadAlreadyPurged === true
        ? [
            {
              mode: request.scope.mode,
              threadId: request.scope.threadId,
              ...(this.#tombstoneProject(request.scope.mode, request.scope.threadId) === undefined
                ? {}
                : {
                    projectId: this.#tombstoneProject(request.scope.mode, request.scope.threadId),
                  }),
            },
          ]
        : [];
    for (const subject of selected) {
      if (this.#purgeThreadArtifacts !== undefined) {
        await this.#purgeThreadArtifacts({ mode: subject.mode, threadId: subject.threadId });
      }
      this.#append(THREAD_RETENTION_EVENT_NAMES.threadPurged, {
        kind: "thread-purged",
        mode: subject.mode,
        threadId: subject.threadId,
        ...(subject.projectId === undefined ? {} : { projectId: subject.projectId }),
        purgedAt: occurredAt,
      });
      erasePurgedThread({
        connection: this.#connection,
        mode: subject.mode,
        threadId: subject.threadId,
      });
      if (subject.mode === "work") this.#forgetWorkThread?.(String(subject.threadId));
    }
    return {
      operation: "purge-threads",
      scope: request.scope,
      purged: selected.map((subject) => ({
        mode: subject.mode,
        threadId: subject.threadId,
        ...(subject.projectId === undefined ? {} : { projectId: subject.projectId }),
      })),
      alreadyPurged,
      retained: [...THREAD_PURGE_RETAINED_SCOPES],
      deleted:
        selected.length === 0 && alreadyPurged.length > 0 ? [] : [...THREAD_PURGE_DELETED_SCOPES],
      occurredAt,
    };
  }

  #subjects(): ReadonlyArray<ThreadRetentionSubject> {
    return [
      ...listProjectedThreadSubjects(this.#connection),
      ...this.#listWorkThreads().map((thread) => ({
        mode: "work" as const,
        threadId: thread.id as ThreadRetentionThreadId,
        projectId: thread.projectId,
        updatedAt: thread.updatedAt,
      })),
    ];
  }

  #existence(scope: SetThreadRetentionRequest["scope"]): {
    readonly threadExists?: boolean;
    readonly threadAlreadyPurged?: boolean;
    readonly projectExists?: boolean;
  } {
    if (scope.kind === "host") return {};
    if (scope.kind === "project") {
      try {
        return {
          projectExists:
            readProject(this.#connection, decodeProjectId(scope.projectId)) !== undefined,
        };
      } catch {
        return { projectExists: false };
      }
    }
    if (readThreadPurgeTombstone(this.#connection, scope.mode, scope.threadId) !== undefined) {
      return { threadAlreadyPurged: true, threadExists: false };
    }
    if (scope.mode === "work") {
      return {
        threadExists: this.#listWorkThreads().some(
          (thread) => String(thread.id) === String(scope.threadId),
        ),
      };
    }
    return { threadExists: threadProjectionExists(this.#connection, scope.mode, scope.threadId) };
  }

  #tombstoneProject(mode: OctantMode, threadId: ThreadRetentionThreadId): ProjectId | undefined {
    return readThreadPurgeTombstone(this.#connection, mode, threadId)?.projectId;
  }

  #append(eventName: string, payload: unknown): void {
    const version = readAggregateVersion(
      this.#connection,
      THREAD_RETENTION_AGGREGATE,
      THREAD_RETENTION_AGGREGATE_ID,
    );
    this.#journal.append({
      aggregate: {
        aggregateType: THREAD_RETENTION_AGGREGATE,
        aggregateId: THREAD_RETENTION_AGGREGATE_ID,
      },
      expectedVersion: version,
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName,
          eventVersion: 1,
          hostId: LOCAL_HOST_ID,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: { kind: "local-user" as const, actorId: decodeActorId(LOCAL_ACTOR_ID) },
          occurredAt: decodeTimestamp(this.#clock()),
          payload,
        },
      ],
    });
  }
}
