import { Schema } from "effect";
import {
  CodeThreadId,
  decodeProjectId,
  type OctantMode,
  type WindowId,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  type ActivityCardSource,
  type ActivityFinishedCounts,
  type ActivityKind,
  type ActivityQuery,
  type ActivityRecord,
  type ActivitySnapshotId,
  type ActivityView,
  type ActivityWindow as ActivityWindowContract,
} from "@octant/contracts/code-home-activity";
import type { ActivityFact } from "../persistence/activityHistoryProjection";

const PAGE_SIZE = 25;
const MAX_SELECTED_RECORDS = 10_000;

// Scope lists are unordered enumerations; the key is the deduped sorted set
// so the same admitted roster compares equal however it was listed.
const scopeKey = (scope: ReadonlyArray<string>): string =>
  JSON.stringify([...new Set(scope)].sort());

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
  /** The derived projection is held after a failed apply: its rows lag. */
  readonly projectionHeld: () => boolean;
  /**
   * The window's currently connected and admitted `projectId|owner/name`
   * pairs. GitHub selections are authorized against this live set — never
   * against the broader active-Project roster — and pages recheck it.
   */
  readonly listForgeScope?: (windowId: WindowId) => Promise<ReadonlyArray<string>>;
  /**
   * The resolved forge history read; absent means no GitHub connection at
   * all, so `github` reads fall back to Octant facts. Never called for runs.
   */
  readonly forgeRead?: (input: {
    readonly windowId: WindowId;
    readonly card: Exclude<ActivityKind, "runs">;
    readonly current: ActivityWindowContract;
    readonly comparison?: ActivityWindowContract;
    readonly refresh: boolean;
    readonly signal?: AbortSignal;
    readonly admission?: () => boolean;
  }) => Promise<CodeHomeActivityForgeResult>;
  /**
   * The normalized login the forge seam answers as, or undefined when no
   * secure account is connected; github snapshots recheck it on every page.
   */
  readonly forgeAccount?: (card: Exclude<ActivityKind, "runs">) => Promise<string | undefined>;
  /**
   * The access epoch an account's forge repository is read under; a view or
   * page compares the epoch its rows were captured on against it, so a
   * confirmed access loss retires the snapshot instead of serving stale rows.
   */
  readonly forgeRepositoryEpoch?: (account: string, repositoryKey: string) => number;
  readonly uuid: () => string;
  readonly now: () => number;
  readonly clock: () => UtcTimestamp;
}

/** One forge row plus the Project, repository, and access epoch that witnessed it. */
export interface CodeHomeActivityForgeRecord {
  readonly record: ActivityRecord;
  readonly projectId: string;
  /** Normalized `owner/name`; authority is the projectId|repositoryKey pair. */
  readonly repositoryKey: string;
  /**
   * The account's access epoch the row was captured under. A repository-missing
   * that lands after the read began still retires the row at view time.
   */
  readonly repositoryEpoch: number;
}

/**
 * What the forge seam answers: a connection problem the Octant facts cover,
 * an honest refusal, or normalized rows the window is authorized for.
 */
export type CodeHomeActivityForgeResult =
  | Readonly<{
      status: "fallback";
      fallback: "no-github-connection" | "insecure-github-storage";
    }>
  | Readonly<{
      status: "unavailable";
      reason: "not-connected" | "not-checked" | "incomplete" | "rate-limited" | "read-failed";
    }>
  | Readonly<{
      status: "ready" | "partial";
      /** The account whose `gh` answered, normalized; pages recheck it. */
      account: string;
      checkedAt: UtcTimestamp;
      /**
       * The admitted Project/repository set the read enumerated before
       * gathering, including repositories that returned no rows. The view
       * stamps its snapshot only when the live scope is still this set.
       */
      readonly queriedScope: ReadonlyArray<string>;
      records: ReadonlyArray<CodeHomeActivityForgeRecord>;
      /**
       * Whether the binding these records were read under still holds: a
       * live check on the source and account, never this request's signal.
       * The view rechecks it after its own awaits and the snapshot keeps it
       * so later pages fail closed after a release or account swap.
       */
      readonly current?: () => boolean;
    }>;

interface ThreadWitness {
  readonly mode: OctantMode;
  /** Absent on forge-resolved rows, which witness a Project, not a thread. */
  readonly threadId: string | undefined;
  readonly projectId: string | null;
}

interface ActivitySnapshot {
  readonly windowId: string;
  readonly source: ActivityCardSource;
  readonly card: ActivityKind;
  readonly checkedAt: UtcTimestamp;
  readonly admittedKey: string;
  /** The forge account a github view was read as; octant snapshots carry none. */
  readonly forgeKey: string | undefined;
  /** Access epochs of the repositories a github snapshot's records came from. */
  readonly forgeEpochs: ReadonlyMap<string, number> | undefined;
  /** Liveness of the binding a github snapshot's records were read under. */
  readonly bindingCurrent?: () => boolean;
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
    signal?: AbortSignal,
  ): Promise<ActivityView> {
    if (query.kind === "page") return this.#page(windowId, query, admission);
    return this.#initial(windowId, query, admission, signal);
  }

  #unavailable(
    source: ActivityCardSource,
    reason:
      | "read-failed"
      | "expired"
      | "authorization-changed"
      | "not-recorded"
      | "not-checked"
      | "not-connected"
      | "incomplete"
      | "rate-limited",
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
    signal?: AbortSignal,
  ): Promise<ActivityView> {
    // Octant has no release journal; GitHub resolves them through the forge
    // seam. An Octant release read still answers honestly unavailable.
    if (query.card === "releases-published" && query.source === "octant") {
      return { status: "unavailable", source: "octant", reason: "not-recorded", records: [] };
    }
    let fallback: "no-github-connection" | "insecure-github-storage" | undefined;
    if (query.source === "github" && query.card !== "runs") {
      if (this.#ports.forgeRead === undefined) {
        fallback = "no-github-connection";
      } else {
        const forge = await this.#ports.forgeRead({
          windowId,
          card: query.card,
          current: query.current,
          ...(query.comparison === undefined ? {} : { comparison: query.comparison }),
          refresh: query.refresh === true,
          ...(signal === undefined ? {} : { signal }),
          admission,
        });
        if (forge.status === "fallback") fallback = forge.fallback;
        else if (forge.status === "unavailable") {
          return this.#unavailable("github", forge.reason);
        } else {
          return this.#forgeView(
            windowId,
            query,
            forge,
            () => admission() && signal?.aborted !== true,
          );
        }
      }
    }
    if (query.card === "releases-published") {
      return {
        status: "unavailable",
        source: "octant",
        reason: "not-recorded",
        ...(fallback === undefined ? {} : { fallback }),
        records: [],
      };
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

    let comparisonCount: number | undefined;
    // A comparison-only witness still proved the answer: it must sit in the
    // snapshot's authority set so losing it expires the snapshot instead of
    // letting a later page keep answering `comparisonCount`.
    const authorityOf = new Map(selected.authorityOf);
    if (query.comparison !== undefined && !selected.partial) {
      // A comparison counts only over coverage the window can actually
      // read: an inaccessible fact must neither prove coverage nor become a
      // fabricated zero.
      const comparison = await this.#select(windowId, admitted, {
        kind: query.card,
        from: query.comparison.from,
        until: query.comparison.until,
      });
      let covered = comparison.oldestAuthorized !== undefined;
      if (!covered && query.comparison.from !== null) {
        // Facts older than the comparison window still prove the source
        // reached it; only then is a real zero honest.
        const reach = await this.#select(windowId, admitted, {
          kind: query.card,
          from: null,
          until: query.comparison.until,
        });
        covered = reach.oldestAuthorized !== undefined;
        // Reach's oldest witness alone is the proof the answer rested on:
        // retaining it — never reach's whole authority set — expires the
        // snapshot when that one thread is lost.
        if (covered && reach.oldestWitness !== undefined) {
          authorityOf.set(
            `reach|${reach.oldestWitness.mode}|${reach.oldestWitness.threadId}|${reach.oldestWitness.projectId ?? ""}`,
            reach.oldestWitness,
          );
        }
      }
      // A comparison that hit the selection cap answers nothing: neither a
      // truncated count nor witnesses from a partial window enter the
      // snapshot.
      if (covered && !comparison.partial) {
        comparisonCount =
          query.card === "runs"
            ? this.#countFinishes(comparison.records).successful
            : comparison.records.length;
        for (const [identity, witness] of comparison.authorityOf) {
          authorityOf.set(identity, witness);
        }
      }
    }
    // The view's coverage is only as old as facts this window may read — a
    // bounded window cannot claim coverage it never scanned.
    const coverageFrom = query.current.from === null ? selected.oldestAuthorized : undefined;

    this.#evictSnapshots();
    const snapshotId = this.#ports.uuid();
    this.#snapshots.set(snapshotId, {
      windowId: String(windowId),
      source: "octant",
      card: query.card,
      checkedAt: this.#ports.clock(),
      forgeKey: undefined,
      forgeEpochs: undefined,
      admittedKey: scopeKey(admitted),
      all: records,
      filtered,
      authorityOf,
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
      ...(coverageFrom === undefined ? {} : { coverageFrom }),
      count,
      ...(comparisonCount === undefined ? {} : { comparisonCount }),
      ...(finished === undefined ? {} : { finished }),
      snapshotId: snapshotId as ActivitySnapshotId,
      records: page,
      ...(page.length < filtered.length ? { nextOffset: page.length } : {}),
    };
  }

  /**
   * The authorized forge view: records arrive normalized with the Project
   * each was witnessed for, authority filters before dedupe just like the
   * journal path, and the frozen snapshot is what every later page reads.
   */
  async #forgeView(
    windowId: WindowId,
    query: Extract<ActivityQuery, { kind: "read" }>,
    forge: Extract<CodeHomeActivityForgeResult, { status: "ready" | "partial" }>,
    admission: () => boolean,
  ): Promise<ActivityView> {
    const scope = (await this.#ports.listForgeScope?.(windowId)) ?? [];
    // The scope await gave a source release or account swap time to land:
    // rows gathered under a binding that no longer holds, or under an
    // admitted set that is no longer this one, are never served.
    const admittedKey = scopeKey(scope);
    if (
      !admission() ||
      forge.current?.() === false ||
      admittedKey !== scopeKey(forge.queriedScope)
    ) {
      return this.#unavailable("github", "authorization-changed");
    }
    const admittedSet = new Set(scope);
    const scopeOf = (row: CodeHomeActivityForgeRecord) => `${row.projectId}|${row.repositoryKey}`;
    const inWindow = (record: CodeHomeActivityForgeRecord) =>
      (query.current.from === null || record.record.occurredAt >= query.current.from) &&
      record.record.occurredAt < query.current.until;
    // Every repository the view's records rest on, current and comparison,
    // with the access epoch its rows were captured under: an access loss on
    // any one of them retires this view and the snapshot's later pages.
    const witnessedRepositories = new Map<string, number>();
    // A row accepted under one epoch must not outlive a revocation that
    // landed before this view was built. Each accepted row is checked
    // itself: two Projects sharing a remote can report different epochs for
    // it, and only the freshest write in a summary map would hide that.
    const staleEpoch = (row: CodeHomeActivityForgeRecord) =>
      this.#ports.forgeRepositoryEpoch !== undefined &&
      this.#ports.forgeRepositoryEpoch(forge.account, row.repositoryKey) !== row.repositoryEpoch;
    const byId = new Map<string, CodeHomeActivityForgeRecord>();
    for (const row of forge.records) {
      if (!inWindow(row) || byId.has(row.record.id)) continue;
      if (!admittedSet.has(scopeOf(row))) continue;
      if (staleEpoch(row)) return this.#unavailable("github", "authorization-changed");
      witnessedRepositories.set(row.repositoryKey, row.repositoryEpoch);
      byId.set(row.record.id, row);
    }
    const records = [...byId.values()]
      .map((row) => row.record)
      .sort(
        (a, b) =>
          (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    const capped = records.slice(0, MAX_SELECTED_RECORDS);
    const partial = forge.status === "partial" || capped.length < records.length;

    // A partial view never claims a previous-window count: the search could
    // not prove what it counted. A ready one always compares — the windowed
    // read is exact, so a real zero is honest.
    let comparisonCount: number | undefined;
    if (query.comparison !== undefined && !partial) {
      const inComparison = (record: CodeHomeActivityForgeRecord) =>
        (query.comparison?.from === undefined ||
          query.comparison.from === null ||
          record.record.occurredAt >= query.comparison.from) &&
        record.record.occurredAt < (query.comparison?.until ?? record.record.occurredAt);
      const comparisonIds = new Set<string>();
      for (const row of forge.records) {
        if (!inComparison(row) || !admittedSet.has(scopeOf(row))) continue;
        if (staleEpoch(row)) return this.#unavailable("github", "authorization-changed");
        witnessedRepositories.set(row.repositoryKey, row.repositoryEpoch);
        comparisonIds.add(row.record.id);
      }
      comparisonCount = comparisonIds.size;
    }

    const authorityOf = new Map<string, ThreadWitness>();
    for (const row of byId.values()) {
      authorityOf.set(row.record.id, {
        mode: "code",
        threadId: undefined,
        projectId: row.projectId,
      });
    }
    const forgeEpochs =
      this.#ports.forgeRepositoryEpoch === undefined ? undefined : witnessedRepositories;
    this.#evictSnapshots();
    const snapshotId = this.#ports.uuid();
    this.#snapshots.set(snapshotId, {
      windowId: String(windowId),
      source: "github",
      card: query.card,
      checkedAt: forge.checkedAt,
      forgeKey: forge.account,
      forgeEpochs,
      ...(forge.current === undefined ? {} : { bindingCurrent: forge.current }),
      admittedKey,
      all: capped,
      filtered: capped,
      authorityOf,
      count: capped.length,
      comparisonCount,
      finished: undefined,
      partial,
      expiresAtMs: this.#ports.now() + SNAPSHOT_TTL_MS,
    });
    while (this.#snapshots.size > MAX_SNAPSHOTS) {
      const oldest = this.#snapshots.keys().next().value;
      if (oldest === undefined) break;
      this.#snapshots.delete(oldest);
    }
    const page = capped.slice(0, PAGE_SIZE);
    if (!admission()) return this.#unavailable("github", "authorization-changed");
    return {
      status: partial ? "partial" : "ready",
      source: "github",
      ...(partial ? { reason: "incomplete" as const } : {}),
      checkedAt: forge.checkedAt,
      count: capped.length,
      ...(comparisonCount === undefined ? {} : { comparisonCount }),
      snapshotId: snapshotId as ActivitySnapshotId,
      records: page,
      ...(page.length < capped.length ? { nextOffset: page.length } : {}),
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
    // A github view re-proves the secure account it was read as first: a
    // logout or a different signed-in login ends the snapshot rather than
    // paging another account's history under this one.
    if (snapshot.forgeKey !== undefined && snapshot.card !== "runs") {
      const account = await this.#ports.forgeAccount?.(snapshot.card);
      if (account !== snapshot.forgeKey) {
        this.#snapshots.delete(query.snapshotId);
        return this.#unavailable(snapshot.source, "authorization-changed");
      }
    }
    // The scope lookup is the last await a github page takes, so the checks
    // below all observe post-await state: a repository dropped from the
    // admitted set — or the binding itself released — while either call was
    // in flight is still caught before any row is served.
    const scope =
      snapshot.source === "github"
        ? ((await this.#ports.listForgeScope?.(windowId)) ?? [])
        : await this.#ports.listProjects(windowId);
    if (scopeKey(scope) !== snapshot.admittedKey || snapshot.bindingCurrent?.() === false) {
      this.#snapshots.delete(query.snapshotId);
      return this.#unavailable(snapshot.source, "authorization-changed");
    }
    // A repository whose access epoch moved since the read was confirmed
    // lost underneath the snapshot — its rows are purged, so the frozen
    // view must end rather than page them.
    if (
      snapshot.forgeEpochs !== undefined &&
      snapshot.forgeKey !== undefined &&
      this.#ports.forgeRepositoryEpoch !== undefined
    ) {
      for (const [repositoryKey, epoch] of snapshot.forgeEpochs) {
        if (this.#ports.forgeRepositoryEpoch(snapshot.forgeKey, repositoryKey) !== epoch) {
          this.#snapshots.delete(query.snapshotId);
          return this.#unavailable(snapshot.source, "authorization-changed");
        }
      }
    }
    const list = query.allFinished === true ? snapshot.all : snapshot.filtered;
    const page = list.slice(query.offset, query.offset + PAGE_SIZE);
    // Every row this page would show is re-authorized against the thread it
    // witnessed; losing any one of them expires the whole snapshot rather
    // than letting totals or rows leak past a scope change.
    for (const witness of snapshot.authorityOf.values()) {
      if (witness.threadId === undefined) continue;
      const allowed = await this.#ports.canReadThread({
        windowId,
        mode: witness.mode,
        threadId: witness.threadId,
        projectId: witness.projectId,
      });
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
      checkedAt: snapshot.checkedAt,
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
    readonly oldestAuthorized: UtcTimestamp | undefined;
    readonly oldestWitness: ThreadWitness | undefined;
  }> {
    const threadReads = new Map<string, Promise<boolean>>();
    const admittedSet = new Set(admitted);
    const rows = this.#ports.readFacts(input);
    const byId = new Map<string, ActivityRecord>();
    const authorityOf = new Map<string, ThreadWitness>();
    let partial = false;
    let oldestAuthorized: UtcTimestamp | undefined;
    let oldestWitness: ThreadWitness | undefined;
    for (const fact of rows) {
      if (byId.size >= MAX_SELECTED_RECORDS) {
        partial = true;
        break;
      }
      const witness = this.#witness(fact);
      if (witness === undefined) continue;
      if (!(await this.#mayRead(windowId, admittedSet, witness, threadReads))) continue;
      // Every accessible witness proves the answer, not only the one whose
      // row survives first-wins dedupe: the key is the identity plus the
      // witness so the same delivery seen through another thread keeps both
      // authorities instead of overwriting the first.
      authorityOf.set(
        `${fact.identity}|${witness.mode}|${witness.threadId}|${witness.projectId ?? ""}`,
        witness,
      );
      if (oldestAuthorized === undefined || fact.occurredAt < oldestAuthorized) {
        oldestAuthorized = fact.occurredAt as UtcTimestamp;
        oldestWitness = witness;
      }
      if (byId.has(fact.identity)) continue;
      const record = this.#decodeRecord(fact, witness);
      if (record === undefined) continue;
      byId.set(fact.identity, record);
    }
    return {
      records: [...byId.values()],
      authorityOf,
      partial,
      oldestAuthorized,
      oldestWitness,
    };
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
    if (witness.threadId === undefined) return false;
    const key = `${witness.mode}:${witness.threadId}:${witness.projectId ?? ""}`;
    let pending = threadReads.get(key);
    if (pending === undefined) {
      pending = this.#ports.canReadThread({
        windowId,
        mode: witness.mode,
        threadId: witness.threadId,
        projectId: witness.projectId,
      });
      threadReads.set(key, pending);
    }
    return pending;
  }

  #decodeRecord(fact: ActivityFact, witness: ThreadWitness): ActivityRecord | undefined {
    try {
      if (!RUN_IDENTITY.test(fact.identity)) {
        const metadata = decodeDeliveryFactMetadata(JSON.parse(fact.metadataJson));
        const threadId = decodeFactThreadId(fact.threadId);
        const projectId = fact.projectId === null ? undefined : decodeProjectId(fact.projectId);
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
            ...(projectId === undefined ? {} : { projectId }),
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
          ...(projectId === undefined ? {} : { projectId }),
        };
      }
      const metadata = decodeRunFactMetadata(JSON.parse(fact.metadataJson));
      const projectId = fact.projectId === null ? undefined : decodeProjectId(fact.projectId);
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
        ...(projectId === undefined ? {} : { projectId }),
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
