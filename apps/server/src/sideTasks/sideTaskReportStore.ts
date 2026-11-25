import {
  AggregateId,
  UtcTimestamp,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  SideTaskReportDelivered,
  SideTaskReportOwed,
  SideTaskReportRefused,
  SideTaskReportingResumed,
  SideTaskReportingStopped,
  THREAD_RETENTION_EVENT_NAMES,
  THREAD_SIDE_TASK_REPORTS_AGGREGATE_TYPE,
  THREAD_SIDE_TASK_REPORT_EVENT_NAMES,
  type ThreadRetentionThreadPurged,
} from "@octant/contracts";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import { replayAggregateTypesInOrder } from "../persistence/journalHydration";
import { THREAD_RETENTION_AGGREGATE } from "../persistence/threadRetentionProjection";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeUtcTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

type JournalPort = Pick<Journal, "append" | "replayAggregateType">;

export function registerSideTaskReportEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(THREAD_SIDE_TASK_REPORT_EVENT_NAMES.owed, 1, SideTaskReportOwed)
    .register(THREAD_SIDE_TASK_REPORT_EVENT_NAMES.delivered, 1, SideTaskReportDelivered)
    .register(THREAD_SIDE_TASK_REPORT_EVENT_NAMES.refused, 1, SideTaskReportRefused)
    .register(THREAD_SIDE_TASK_REPORT_EVENT_NAMES.reportingStopped, 1, SideTaskReportingStopped)
    .register(THREAD_SIDE_TASK_REPORT_EVENT_NAMES.reportingResumed, 1, SideTaskReportingResumed);
}

interface ChildRecord {
  /** Every report owed, in the order the child's turns ended. */
  readonly reports: SideTaskReportOwed[];
  readonly delivered: Set<string>;
  /** Reports the parent can never take; settled, never retried, never dropped silently. */
  readonly refused: Set<string>;
  stopped: boolean;
  version: number;
}

/** How one report a parent was owed stands now, for delivery admission to check. */
export type SideTaskReportState = "owed" | "delivered" | "refused";

export interface SideTaskReportEntry {
  readonly childThreadId: string;
  readonly report: SideTaskReportOwed;
  readonly state: SideTaskReportState;
}

/**
 * What each side-task child thread owes its offering thread, rebuilt from the
 * journal. The aggregate is keyed by the child thread: a turn ending there is
 * a fact about the child, and coalescing across children happens at delivery
 * time by reading every child that owes the same parent. A report stays owed
 * until its delivery turn lands in the parent, so a restart loses nothing.
 */
export class SideTaskReportStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;
  readonly #clock: () => string;
  readonly #records = new Map<string, ChildRecord>();
  /** Threads a purge erased, as the retained purge records say; no report may name one again. */
  readonly #purged = new Set<string>();

  constructor(options: {
    readonly journal: JournalPort;
    readonly uuid: () => string;
    readonly actor: typeof EventActor.Type;
    readonly clock: () => string;
  }) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    this.#actor = decodeActor(options.actor);
    this.#clock = options.clock;
    this.#hydrate();
  }

  /** Whether turns ending in this child should owe reports at all. */
  reportingOn(childThreadId: string): boolean {
    return this.#records.get(childThreadId)?.stopped !== true;
  }

  /**
   * Journals that one ended turn in the child is owed to the parent. A child
   * whose reporting the person stopped owes nothing, so the refusal is a
   * value rather than an event: nothing is journaled, nothing is delivered.
   * The same holds once either thread was purged, so a turn still winding
   * down cannot write back what the purge erased.
   */
  owe(
    childThreadId: string,
    report: Omit<SideTaskReportOwed, "reportId" | "owedAt">,
  ): "owed" | "stopped" | "purged" {
    if (this.#purged.has(childThreadId) || this.#purged.has(String(report.parentThreadId)))
      return "purged";
    if (!this.reportingOn(childThreadId)) return "stopped";
    const record = this.#record(childThreadId);
    const full = {
      ...report,
      reportId: this.#uuid(),
      owedAt: decodeUtcTimestamp(this.#clock()),
    } as SideTaskReportOwed;
    this.#append(childThreadId, record, THREAD_SIDE_TASK_REPORT_EVENT_NAMES.owed, full);
    record.reports.push(full);
    return "owed";
  }

  /**
   * Every report this parent was ever owed, with how it stands. Delivery
   * admission reads this to verify a claimed mark against the journal: a
   * report still `owed` may enter a turn, `delivered` only through the turn
   * that already carries it, and `refused` never again.
   */
  reportsForParent(parentThreadId: string): ReadonlyArray<SideTaskReportEntry> {
    const entries: SideTaskReportEntry[] = [];
    for (const [childThreadId, record] of this.#records) {
      for (const report of record.reports) {
        if (String(report.parentThreadId) !== parentThreadId) continue;
        const id = String(report.reportId);
        entries.push({
          childThreadId,
          report,
          state: record.delivered.has(id)
            ? "delivered"
            : record.refused.has(id)
              ? "refused"
              : "owed",
        });
      }
    }
    return entries;
  }

  /** The reports this parent has not yet heard about, across every child. */
  undeliveredForParent(parentThreadId: string): ReadonlyArray<{
    readonly childThreadId: string;
    readonly report: SideTaskReportOwed;
  }> {
    const owed: { childThreadId: string; report: SideTaskReportOwed }[] = [];
    for (const [childThreadId, record] of this.#records) {
      for (const report of record.reports) {
        const id = String(report.reportId);
        if (
          String(report.parentThreadId) === parentThreadId &&
          !record.delivered.has(id) &&
          !record.refused.has(id)
        ) {
          owed.push({ childThreadId, report });
        }
      }
    }
    return owed;
  }

  /** Every report still owed, for the startup sweep that catches up after a restart. */
  undelivered(): ReadonlyArray<{
    readonly childThreadId: string;
    readonly report: SideTaskReportOwed;
  }> {
    const owed: { childThreadId: string; report: SideTaskReportOwed }[] = [];
    for (const [childThreadId, record] of this.#records) {
      for (const report of record.reports) {
        const id = String(report.reportId);
        if (!record.delivered.has(id) && !record.refused.has(id)) {
          owed.push({ childThreadId, report });
        }
      }
    }
    return owed;
  }

  /**
   * Journals that the named reports entered their parent. The delivery turn
   * itself is what the parent's agent reads; this mark is what keeps a retry
   * or a replay from minting a second one.
   */
  markDelivered(childThreadId: string, reportIds: ReadonlyArray<string>): void {
    const record = this.#records.get(childThreadId);
    if (record === undefined || reportIds.length === 0) return;
    // A report already delivered or refused is settled; naming it again must
    // not mint a second journal event for the same fact.
    const fresh = reportIds.filter((id) => !record.delivered.has(id) && !record.refused.has(id));
    if (fresh.length === 0) return;
    const payload: SideTaskReportDelivered = {
      reportIds: fresh.map((id) => id as SideTaskReportDelivered["reportIds"][number]),
      deliveredAt: decodeUtcTimestamp(this.#clock()),
    };
    this.#append(childThreadId, record, THREAD_SIDE_TASK_REPORT_EVENT_NAMES.delivered, payload);
    for (const id of fresh) record.delivered.add(id);
  }

  /**
   * Journals that the named reports can never reach their parent — the parent
   * is gone or refuses them for good. They leave the owed set for good, so a
   * restart neither retries them nor loses that they were settled.
   */
  markRefused(childThreadId: string, reportIds: ReadonlyArray<string>, detail: string): void {
    const record = this.#records.get(childThreadId);
    if (record === undefined || reportIds.length === 0) return;
    const fresh = reportIds.filter((id) => !record.delivered.has(id) && !record.refused.has(id));
    if (fresh.length === 0) return;
    const trimmed = detail.trim().slice(0, 512).trim();
    const payload: SideTaskReportRefused = {
      reportIds: fresh.map((id) => id as SideTaskReportRefused["reportIds"][number]),
      detail: trimmed.length === 0 ? "The parent refused the delivery." : trimmed,
      refusedAt: decodeUtcTimestamp(this.#clock()),
    };
    this.#append(childThreadId, record, THREAD_SIDE_TASK_REPORT_EVENT_NAMES.refused, payload);
    for (const id of fresh) record.refused.add(id);
  }

  /** Settles what a deleted child still owes: its words leave with its thread. */
  refuseOwedFrom(childThreadId: string, detail: string): void {
    const record = this.#records.get(childThreadId);
    if (record === undefined) return;
    this.markRefused(
      childThreadId,
      record.reports.map((report) => String(report.reportId)),
      detail,
    );
  }

  /**
   * Drops what this projection holds of a purged thread, as a child and as a
   * parent. The purge erases the same aggregates from the journal, so nothing
   * is journaled here.
   */
  forgetPurgedThread(threadId: string): void {
    this.#purged.add(threadId);
    this.#records.delete(threadId);
    for (const [childThreadId, record] of this.#records) {
      if (record.reports.some((report) => String(report.parentThreadId) === threadId))
        this.#records.delete(childThreadId);
    }
  }

  /** A purged child's receipt outlives it on the parent; its switch writes nothing back. */
  setReporting(childThreadId: string, on: boolean): "set" | "purged" {
    if (this.#purged.has(childThreadId)) return "purged";
    const record = this.#record(childThreadId);
    if (record.stopped === !on) return "set";
    const eventName = on
      ? THREAD_SIDE_TASK_REPORT_EVENT_NAMES.reportingResumed
      : THREAD_SIDE_TASK_REPORT_EVENT_NAMES.reportingStopped;
    const payload = on
      ? ({ resumedAt: decodeUtcTimestamp(this.#clock()) } satisfies SideTaskReportingResumed)
      : ({ stoppedAt: decodeUtcTimestamp(this.#clock()) } satisfies SideTaskReportingStopped);
    this.#append(childThreadId, record, eventName, payload);
    record.stopped = !on;
    return "set";
  }

  #record(childThreadId: string): ChildRecord {
    const existing = this.#records.get(childThreadId);
    if (existing !== undefined) return existing;
    const created: ChildRecord = {
      reports: [],
      delivered: new Set(),
      refused: new Set(),
      stopped: false,
      version: 0,
    };
    this.#records.set(childThreadId, created);
    return created;
  }

  #append(childThreadId: string, record: ChildRecord, eventName: string, payload: unknown): void {
    this.#journal.append({
      aggregate: {
        aggregateType: THREAD_SIDE_TASK_REPORTS_AGGREGATE_TYPE,
        aggregateId: decodeAggregateId(childThreadId),
      },
      expectedVersion: decodeAggregateVersion(record.version),
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: this.#actor,
          occurredAt: this.#clock(),
          payload,
        },
      ],
    });
    record.version += 1;
  }

  #hydrate(): void {
    for (const envelope of replayAggregateTypesInOrder(this.#journal, [
      THREAD_SIDE_TASK_REPORTS_AGGREGATE_TYPE,
      THREAD_RETENTION_AGGREGATE,
    ])) {
      if (envelope.aggregateType === THREAD_RETENTION_AGGREGATE) {
        if (envelope.eventName === THREAD_RETENTION_EVENT_NAMES.threadPurged)
          this.forgetPurgedThread(
            String((envelope.payload as ThreadRetentionThreadPurged).threadId),
          );
        continue;
      }
      const childThreadId = String(envelope.aggregateId);
      const record = this.#record(childThreadId);
      record.version += 1;
      if (envelope.eventName === THREAD_SIDE_TASK_REPORT_EVENT_NAMES.owed) {
        record.reports.push(envelope.payload as SideTaskReportOwed);
      } else if (envelope.eventName === THREAD_SIDE_TASK_REPORT_EVENT_NAMES.delivered) {
        for (const id of (envelope.payload as SideTaskReportDelivered).reportIds) {
          record.delivered.add(String(id));
        }
      } else if (envelope.eventName === THREAD_SIDE_TASK_REPORT_EVENT_NAMES.refused) {
        for (const id of (envelope.payload as SideTaskReportRefused).reportIds) {
          record.refused.add(String(id));
        }
      } else if (envelope.eventName === THREAD_SIDE_TASK_REPORT_EVENT_NAMES.reportingStopped) {
        record.stopped = true;
      } else if (envelope.eventName === THREAD_SIDE_TASK_REPORT_EVENT_NAMES.reportingResumed) {
        record.stopped = false;
      }
    }
  }
}
