import {
  AggregateId,
  AggregateVersion,
  BROWSER_PAGE_AGGREGATE_TYPE,
  BROWSER_PAGE_CLOSED,
  BROWSER_PAGE_OPENED,
  CorrelationId,
  decodeBrowserPageClosed,
  decodeBrowserPageOpened,
  EventId,
  EventName,
  UtcTimestamp,
  type BrowserPageCloseReason,
  type BrowserPageOpened,
  type EventActor,
} from "@octant/contracts";
import { chooseBrowserPageOffers } from "@octant/domain";
import { Schema } from "effect";
import { readAggregateVersion } from "../persistence/chatProjection";
import {
  compactClosedBrowserPages,
  readOpenBrowserPage,
  readOpenBrowserPages,
  type OpenBrowserPage,
} from "../persistence/browserPageProjection";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);

/**
 * How many ended pages may sit in the journal before their events are swept
 * out. A page that opens and closes a thousand times leaves at most this many
 * pairs, however long the host runs.
 */
const SWEEP_AFTER_ENDS = 32;

export interface BrowserPageSessionsOptions {
  readonly journal: Pick<Journal, "append">;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: EventActor;
}

/**
 * The host's record of the Browser pages a thread's pane held, so a restart
 * or crash can offer one back. A page's start and end are two events on one
 * aggregate; an end is an append at the version the start left, so of two
 * windows that both try to end the same page, one append wins.
 *
 * Recording is best effort: a page that cannot be journaled still opens, and
 * a page whose end cannot be journaled is the conservative failure, because it
 * is offered back after a restart and the person can dismiss it.
 */
export class BrowserPageSessions {
  readonly #journal: BrowserPageSessionsOptions["journal"];
  readonly #connection: SqliteConnection;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #actor: EventActor;
  #endsSinceSweep = 0;

  constructor(options: BrowserPageSessionsOptions) {
    this.#journal = options.journal;
    this.#connection = options.connection;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#actor = options.actor;
  }

  /** Records that a page opened. Never throws. */
  opened(page: Omit<BrowserPageOpened, "openedAt">): void {
    try {
      const payload = decodeBrowserPageOpened({ ...page, openedAt: this.#clock() });
      this.#append(String(payload.pageId), 0, BROWSER_PAGE_OPENED, payload, payload.openedAt);
    } catch {
      // A page that cannot be recorded is never offered back; it opens as usual.
    }
  }

  /**
   * Records that a page ended. True only for the call that wrote the end: a
   * page never recorded, one already ended, and a lost race all answer false.
   * Never throws.
   */
  ended(pageId: string, threadId: string, reason: BrowserPageCloseReason): boolean {
    try {
      const aggregateId = decodeAggregateId(pageId);
      if (readAggregateVersion(this.#connection, BROWSER_PAGE_AGGREGATE_TYPE, aggregateId) !== 1)
        return false;
      const closedAt = this.#clock();
      this.#append(
        pageId,
        1,
        BROWSER_PAGE_CLOSED,
        decodeBrowserPageClosed({ pageId, threadId, reason, closedAt }),
        closedAt,
      );
      this.#endsSinceSweep += 1;
      if (this.#endsSinceSweep >= SWEEP_AFTER_ENDS) this.sweep();
      return true;
    } catch {
      // A lost race (another window ended it first) and a write that failed
      // both leave the page as the journal has it.
      return false;
    }
  }

  /** The pages with a start and no end. */
  open(): ReadonlyArray<OpenBrowserPage> {
    return readOpenBrowserPages(this.#connection);
  }

  page(pageId: string): OpenBrowserPage | undefined {
    return readOpenBrowserPage(this.#connection, pageId);
  }

  /**
   * Settles what the previous run left, once, before the host serves a
   * command. Every page still recorded open is a page that run did not end.
   * One whose thread can no longer open a Browser is ended as such, and of the
   * rest only the newest of a thread stays offered. Returns the ids offered.
   */
  settleAtStart(stillOffered: (page: OpenBrowserPage) => boolean): ReadonlySet<string> {
    const left = this.open();
    const kept: OpenBrowserPage[] = [];
    for (const page of left) {
      if (stillOffered(page)) kept.push(page);
      else this.ended(page.pageId, page.threadId, "thread-ended");
    }
    const chosen = chooseBrowserPageOffers(kept);
    for (const page of chosen.superseded) this.ended(page.pageId, page.threadId, "superseded");
    this.sweep();
    return new Set(chosen.offered.map((page) => page.pageId));
  }

  /** Removes the journal history of ended pages. */
  sweep(): void {
    this.#endsSinceSweep = 0;
    try {
      compactClosedBrowserPages(this.#connection);
    } catch {
      // The history stays until the next sweep; reads never depend on it.
    }
  }

  #append(
    aggregate: string,
    expectedVersion: number,
    eventName: string,
    payload: unknown,
    occurredAt: string,
  ): void {
    this.#journal.append({
      aggregate: {
        aggregateType: BROWSER_PAGE_AGGREGATE_TYPE,
        aggregateId: decodeAggregateId(aggregate),
      },
      expectedVersion: decodeAggregateVersion(expectedVersion),
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName: decodeEventName(eventName),
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: this.#actor,
          occurredAt: decodeTimestamp(occurredAt),
          payload,
        },
      ],
    });
  }
}
