import { Schema } from "effect";
import { CodeThreadId, type OctantMode, type WindowId, type UtcTimestamp } from "@octant/contracts";
import {
  type ActivityCardSource,
  type ActivityFinishedCounts,
  type ActivityKind,
  type ActivityQuery,
  type ActivityRecord,
  type ActivitySnapshotId,
  type ActivityView,
} from "@octant/contracts/code-home-activity";
import type { ActivityFact } from "../persistence/activityHistoryProjection";

const PAGE_SIZE = 25;
const MAX_SELECTED_RECORDS = 10_000;
const SNAPSHOT_TTL_MS = 5 * 60 * 1_000;
const MAX_SNAPSHOTS = 64;
const RUN_IDENTITY = /^(code|chat|work|agent-run):/;

const decodeDeliveryFactMetadata = Schema.decodeUnknownSync(
  Schema.Union(
    Schema.Struct({
      repositoryOwner: Schema.NonEmptyTrimmedString,
      repositoryName: Schema.NonEmptyTrimmedString,
      number: Schema.Int,
      title: Schema.optional(Schema.String),
      mergedBy: Schema.NonEmptyTrimmedString,
    }),
    Schema.Struct({
      repositoryOwner: Schema.NonEmptyTrimmedString,
      repositoryName: Schema.NonEmptyTrimmedString,
      number: Schema.Int,
      title: Schema.optional(Schema.String),
      closingPullRequest: Schema.Struct({
        repositoryOwner: Schema.NonEmptyTrimmedString,
        repositoryName: Schema.NonEmptyTrimmedString,
        number: Schema.Int,
      }),
    }),
  ),
);
const decodeRunFactMetadata = Schema.decodeUnknownSync(
  Schema.Struct({
    source: Schema.Literal("code", "chat", "work", "agent-run"),
    runId: Schema.NonEmptyTrimmedString,
    finish: Schema.Literal("successful", "failed", "canceled"),
    mode: Schema.Literal("chat", "work", "code"),
  }),
);
const decodeFactThreadId = Schema.decodeUnknownSync(CodeThreadId);

/** Who may read a fact, resolved by composition; this service asks, never knows. */
export interface CodeHomeActivityServicePorts {
  /** The window's currently admitted, active Projects (ids). */
  readonly listProjects: (windowId: WindowId) => Promise<ReadonlyArray<string>>;
  /**
   * Whether this window may read this thread as this Project's witness: the
   * thread still exists, is not purged or departed, still names this Project,
   * and a projectless Chat thread is admitted only by the person's own Chat
   * scope.
   */
  readonly canReadThread: (input: {
    readonly windowId: WindowId;
    readonly mode: OctantMode;
    readonly threadId: string;
    readonly projectId: string | null;
  }) => Promise<boolean>;
  /** Newest-first normalized journal facts for one card and window. */
  readonly readFacts: (input: {
    readonly kind: Exclude<ActivityKind, "releases-published">;
    readonly from: UtcTimestamp | null;
    readonly until: UtcTimestamp;
  }) => ReadonlyArray<ActivityFact>;
  /** The oldest fact the card holds, or null when nothing was ever recorded. */
  readonly coverageFrom: (kind: Exclude<ActivityKind, "releases-published">) => string | null;
  /** The derived projection is held after a failed apply: its rows lag. */
  readonly projectionHeld: () => boolean;
  /**
   * Whether the forge seam could answer for this host. Absent means no
   * connection; `github` reads then fall back to Octant facts.
   */
  readonly forgeReadiness?: () => "connected" | "disconnected" | "insecure";
  readonly uuid: () => string;
  readonly now: () => number;
  readonly clock: () => UtcTimestamp;
}

interface ThreadWitness {
  readonly mode: OctantMode;
  readonly threadId: string;
  readonly projectId: string | null;
}

interface ActivitySnapshot {
  readonly windowId: string;
  readonly source: ActivityCardSource;
  readonly admittedKey: string;
  readonly all: ReadonlyArray<ActivityRecord>;
  readonly filtered: ReadonlyArray<ActivityRecord>;
  readonly authorityOf: ReadonlyMap<string, ThreadWitness>;
  readonly count: number;
  readonly comparisonCount: number | undefined;
  readonly finished: ActivityFinishedCounts | undefined;
  readonly partial: boolean;
  readonly expiresAtMs: number;
}

export class CodeHomeActivityService {
  readonly #ports: CodeHomeActivityServicePorts;
  readonly #snapshots = new Map<string, ActivitySnapshot>();

  constructor(ports: CodeHomeActivityServicePorts) {
    this.#ports = ports;
  }

  async read(
    windowId: WindowId,
    query: ActivityQuery,
    admission: () => boolean,
  ): Promise<ActivityView> {
    if (query.kind === "page") return this.#page(windowId, query, admission);
    return this.#initial(windowId, query, admission);
  }

  #unavailable(
    source: ActivityCardSource,
    reason: "read-failed" | "expired" | "authorization-changed" | "not-recorded" | "not-checked",
    fallback?: "no-github-connection" | "insecure-github-storage",
  ): ActivityView {
    return {
      status: "unavailable",
      source,
      reason,
      ...(fallback === undefined ? {} : { fallback }),
      records: [],
    };
  }

  async #initial(
    windowId: WindowId,
    query: Extract<ActivityQuery, { kind: "read" }>,
    admission: () => boolean,
  ): Promise<ActivityView> {
    // Releases are not journaled anywhere yet: the card answers honestly
    // rather than inventing history or a fake zero.
    if (query.card === "releases-published") {
      return { status: "unavailable", source: query.source, reason: "not-recorded", records: [] };
    }
    let fallback: "no-github-connection" | "insecure-github-storage" | undefined;
    if (query.source === "github") {
      const readiness = this.#ports.forgeReadiness?.() ?? "disconnected";
      if (readiness === "connected") {
        // The resolved forge read arrives with its own slice; until then the
        // card says it has not checked rather than claiming coverage.
        return this.#unavailable("github", "not-checked");
      }
      fallback = readiness === "insecure" ? "insecure-github-storage" : "no-github-connection";
    }
    if (!admission()) return this.#unavailable("octant", "authorization-changed", fallback);
    if (this.#ports.projectionHeld()) {
      return this.#unavailable("octant", "read-failed", fallback);
    }
    const admitted = await this.#ports.listProjects(windowId);
    if (!admission()) return this.#unavailable("octant", "authorization-changed", fallback);

    const selected = await this.#select(windowId, admitted, {
      kind: query.card,
      from: query.current.from,
      until: query.current.until,
    });
    const records = selected.records;
    const finished = query.card === "runs" ? this.#countFinishes(records) : undefined;
    const filtered =
      query.card === "runs"
        ? records.filter((record) => record.kind === "runs" && record.finish === "successful")
        : records;
    const count = query.card === "runs" ? (finished?.successful ?? 0) : records.length;

    const coverageFrom = this.#ports.coverageFrom(query.card);
    let comparisonCount: number | undefined;
    if (query.comparison !== undefined) {
      // A comparison counts only over coverage the source actually has: a
      // card that first recorded after the comparison window ends would read
      // a fabricated zero, so it stays unanswered instead.
      if (coverageFrom !== null && coverageFrom < query.comparison.until) {
        const comparison = await this.#select(windowId, admitted, {
          kind: query.card,
          from: query.comparison.from,
          until: query.comparison.until,
        });
        comparisonCount =
          query.card === "runs"
            ? this.#countFinishes(comparison.records).successful
            : comparison.records.length;
      }
    }

    this.#evictSnapshots();
    const snapshotId = this.#ports.uuid();
    this.#snapshots.set(snapshotId, {
      windowId: String(windowId),
      source: "octant",
      admittedKey: admitted.slice().sort().join("|"),
      all: records,
      filtered,
      authorityOf: selected.authorityOf,
      count,
      comparisonCount,
      finished,
      partial: selected.partial,
      expiresAtMs: this.#ports.now() + SNAPSHOT_TTL_MS,
    });
    while (this.#snapshots.size > MAX_SNAPSHOTS) {
      const oldest = this.#snapshots.keys().next().value;
      if (oldest === undefined) break;
      this.#snapshots.delete(oldest);
    }
    const page = filtered.slice(0, PAGE_SIZE);
    if (!admission()) return this.#unavailable("octant", "authorization-changed", fallback);
    return {
      status: selected.partial ? "partial" : "ready",
      source: "octant",
      ...(fallback === undefined ? {} : { fallback }),
      ...(selected.partial ? { reason: "incomplete" as const } : {}),
      checkedAt: this.#ports.clock(),
      ...(coverageFrom === null ? {} : { coverageFrom: coverageFrom as UtcTimestamp }),
      count,
      ...(comparisonCount === undefined ? {} : { comparisonCount }),
      ...(finished === undefined ? {} : { finished }),
      snapshotId: snapshotId as ActivitySnapshotId,
      records: page,
      ...(page.length < filtered.length ? { nextOffset: page.length } : {}),
    };
  }

  async #page(
    windowId: WindowId,
    query: Extract<ActivityQuery, { kind: "page" }>,
    admission: () => boolean,
  ): Promise<ActivityView> {
    this.#evictSnapshots();
    const snapshot = this.#snapshots.get(query.snapshotId);
    // An unknown, expired, or other-window snapshot answers nothing: no
    // totals and no rows survive an authority change.
    if (snapshot === undefined || snapshot.windowId !== String(windowId) || !admission()) {
      return this.#unavailable("octant", "expired");
    }
    const admitted = await this.#ports.listProjects(windowId);
    if (admitted.slice().sort().join("|") !== snapshot.admittedKey) {
      this.#snapshots.delete(query.snapshotId);
      return this.#unavailable(snapshot.source, "authorization-changed");
    }
    const list = query.allFinished === true ? snapshot.all : snapshot.filtered;
    const page = list.slice(query.offset, query.offset + PAGE_SIZE);
    // Every row this page would show is re-authorized against the thread it
    // witnessed; losing any one of them expires the whole snapshot rather
    // than letting totals or rows leak past a scope change.
    for (const witness of snapshot.authorityOf.values()) {
      const allowed = await this.#ports.canReadThread({ windowId, ...witness });
      if (!allowed) {
        this.#snapshots.delete(query.snapshotId);
        return this.#unavailable(snapshot.source, "authorization-changed");
      }
    }
    if (!admission()) {
      this.#snapshots.delete(query.snapshotId);
      return this.#unavailable(snapshot.source, "authorization-changed");
    }
    return {
      status: snapshot.partial ? "partial" : "ready",
      source: snapshot.source,
      ...(snapshot.partial ? { reason: "incomplete" as const } : {}),
      checkedAt: this.#ports.clock(),
      count: snapshot.count,
      ...(snapshot.comparisonCount === undefined
        ? {}
        : { comparisonCount: snapshot.comparisonCount }),
      ...(snapshot.finished === undefined ? {} : { finished: snapshot.finished }),
      snapshotId: query.snapshotId,
      records: page,
      ...(query.offset + page.length < list.length
        ? { nextOffset: query.offset + page.length }
        : {}),
    };
  }

  #countFinishes(records: ReadonlyArray<ActivityRecord>): ActivityFinishedCounts {
    const counts = { successful: 0, failed: 0, canceled: 0 };
    for (const record of records) {
      if (record.kind !== "runs") continue;
      counts[record.finish] += 1;
    }
    return counts;
  }

  /**
   * Authorized first-wins deduplication: rows arrive newest first, each fact
   * must pass the window's own authority before it may claim an identity, and
   * an accessible witness beats an inaccessible one that happens to sort
   * earlier.
   */
  async #select(
    windowId: WindowId,
    admitted: ReadonlyArray<string>,
    input: {
      readonly kind: Exclude<ActivityKind, "releases-published">;
      readonly from: UtcTimestamp | null;
      readonly until: UtcTimestamp;
    },
  ): Promise<{
    readonly records: ReadonlyArray<ActivityRecord>;
    readonly authorityOf: ReadonlyMap<string, ThreadWitness>;
    readonly partial: boolean;
  }> {
    const threadReads = new Map<string, Promise<boolean>>();
    const admittedSet = new Set(admitted);
    const rows = this.#ports.readFacts(input);
    const byId = new Map<string, ActivityRecord>();
    const authorityOf = new Map<string, ThreadWitness>();
    let partial = false;
    for (const fact of rows) {
      if (byId.size >= MAX_SELECTED_RECORDS) {
        partial = true;
        break;
      }
      if (byId.has(fact.identity)) continue;
      const witness = this.#witness(fact);
      if (witness === undefined) continue;
      if (!(await this.#mayRead(windowId, admittedSet, witness, threadReads))) continue;
      const record = this.#decodeRecord(fact, witness);
      if (record === undefined) continue;
      byId.set(fact.identity, record);
      authorityOf.set(fact.identity, witness);
    }
    return { records: [...byId.values()], authorityOf, partial };
  }

  /** The thread a fact witnessed, for authority. Malformed facts read nothing. */
  #witness(fact: ActivityFact): ThreadWitness | undefined {
    if (!RUN_IDENTITY.test(fact.identity)) {
      return { mode: "code", threadId: fact.threadId, projectId: fact.projectId };
    }
    try {
      const metadata = decodeRunFactMetadata(JSON.parse(fact.metadataJson));
      return { mode: metadata.mode, threadId: fact.threadId, projectId: fact.projectId };
    } catch {
      return undefined;
    }
  }

  async #mayRead(
    windowId: WindowId,
    admitted: ReadonlySet<string>,
    witness: ThreadWitness,
    threadReads: Map<string, Promise<boolean>>,
  ): Promise<boolean> {
    // Work and Code facts have no life outside a Project: a null Project can
    // never admit them, and only Chat's own personal scope may.
    if (witness.projectId === null && witness.mode !== "chat") return false;
    if (witness.projectId !== null && !admitted.has(witness.projectId)) return false;
    const key = `${witness.mode}:${witness.threadId}:${witness.projectId ?? ""}`;
    let pending = threadReads.get(key);
    if (pending === undefined) {
      pending = this.#ports.canReadThread({ windowId, ...witness });
      threadReads.set(key, pending);
    }
    return pending;
  }

  #decodeRecord(fact: ActivityFact, witness: ThreadWitness): ActivityRecord | undefined {
    try {
      if (!RUN_IDENTITY.test(fact.identity)) {
        const metadata = decodeDeliveryFactMetadata(JSON.parse(fact.metadataJson));
        const threadId = decodeFactThreadId(fact.threadId);
        const label =
          metadata.title ??
          `${metadata.repositoryOwner}/${metadata.repositoryName}#${metadata.number}`;
        if ("mergedBy" in metadata) {
          return {
            kind: "prs-merged",
            occurredAt: fact.occurredAt as UtcTimestamp,
            id: fact.identity,
            label,
            repositoryOwner: metadata.repositoryOwner,
            repositoryName: metadata.repositoryName,
            number: metadata.number,
            mergedBy: metadata.mergedBy,
            threadId,
          };
        }
        return {
          kind: "issues-closed",
          occurredAt: fact.occurredAt as UtcTimestamp,
          id: fact.identity,
          label,
          repositoryOwner: metadata.repositoryOwner,
          repositoryName: metadata.repositoryName,
          number: metadata.number,
          closingPullRequest: metadata.closingPullRequest,
          threadId,
        };
      }
      const metadata = decodeRunFactMetadata(JSON.parse(fact.metadataJson));
      const modeName = witness.mode === "chat" ? "Chat" : witness.mode === "work" ? "Work" : "Code";
      return {
        kind: "runs",
        occurredAt: fact.occurredAt as UtcTimestamp,
        id: fact.identity,
        label: metadata.source === "agent-run" ? `${modeName} agent run` : `${modeName} run`,
        source: metadata.source,
        finish: metadata.finish,
        mode: metadata.mode,
        threadId: fact.threadId,
        runId: metadata.runId,
      };
    } catch {
      // A fact that fails its own metadata contract cannot be shown; it is
      // skipped rather than smuggled through as a partial record.
      return undefined;
    }
  }

  #evictSnapshots(): void {
    const now = this.#ports.now();
    for (const [id, snapshot] of this.#snapshots) {
      if (snapshot.expiresAtMs <= now) this.#snapshots.delete(id);
    }
  }
}
