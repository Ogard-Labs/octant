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
  readOpenBrowserPage,
  readOpenBrowserPages,
  readOpenBrowserPagesOfThread,
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
 * How many pages a restart may leave offered at once. The projection holds only
 * pages with a start and no end, and the journal history of ended pages leaves
 * at the persistence start, so this bounds what a long run of crashes can offer.
 */
const MAX_CARRIED_PAGES = 25;

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
 * windows that both try to end the same page, one append wins. A run never
 * deletes journal rows: ended pages leave at the next persistence start.
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
  /** The pages the previous run left, which this run may still offer. */
  #carried: ReadonlySet<string> = new Set();

  constructor(options: BrowserPageSessionsOptions) {
    this.#journal = options.journal;
    this.#connection = options.connection;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#actor = options.actor;
  }

  /**
   * Records that a page opened, by the request's actor, and ends what it
   * replaces: the page it reopens, and any other page the last run left for
   * this thread. Never throws.
   */
  opened(
    page: Omit<BrowserPageOpened, "openedAt">,
    options: { readonly actor?: EventActor; readonly reopens?: string } = {},
  ): void {
    const actor = options.actor ?? this.#actor;
    try {
      const payload = decodeBrowserPageOpened({ ...page, openedAt: this.#clock() });
      this.#append(
        String(payload.pageId),
        0,
        BROWSER_PAGE_OPENED,
        payload,
        payload.openedAt,
        actor,
      );
    } catch {
      // A page that cannot be recorded is never offered back; it opens as usual.
      return;
    }
    const threadId = String(page.threadId);
    for (const older of readOpenBrowserPagesOfThread(this.#connection, threadId)) {
      const reopened = older.pageId === options.reopens;
      if (older.pageId === String(page.pageId) || (!reopened && !this.#carried.has(older.pageId)))
        continue;
      this.ended(older.pageId, threadId, reopened ? "reopened" : "superseded", actor);
    }
  }

  /**
   * Records that a page ended. True only for the call that wrote the end: a
   * page never recorded, one already ended, and a lost race all answer false.
   * Never throws.
   */
  ended(
    pageId: string,
    threadId: string,
    reason: BrowserPageCloseReason,
    actor: EventActor = this.#actor,
  ): boolean {
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
        actor,
      );
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

  openOfThread(threadId: string): ReadonlyArray<OpenBrowserPage> {
    return readOpenBrowserPagesOfThread(this.#connection, threadId);
  }

  page(pageId: string): OpenBrowserPage | undefined {
    return readOpenBrowserPage(this.#connection, pageId);
  }

  /**
   * Settles what the previous run left, once, before the host serves a
   * command. Every page still recorded open is a page that run did not end.
   * One whose thread is archived or deleted is ended; one whose thread merely
   * cannot open a Browser now (a mode off, a Project archived) stays, unseen
   * until it can. Of the rest only the newest of a thread stays, and no more
   * than a fixed number in all. Returns the ids that stay offered.
   */
  settleAtStart(threadEnded: (page: OpenBrowserPage) => boolean): ReadonlySet<string> {
    const kept: OpenBrowserPage[] = [];
    for (const page of this.open()) {
      if (threadEnded(page)) this.ended(page.pageId, page.threadId, "thread-ended");
      else kept.push(page);
    }
    const chosen = chooseBrowserPageOffers(kept);
    for (const page of chosen.superseded) this.ended(page.pageId, page.threadId, "superseded");
    const newest = [...chosen.offered]
      .reverse()
      .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
    for (const page of newest.slice(MAX_CARRIED_PAGES))
      this.ended(page.pageId, page.threadId, "superseded");
    this.#carried = new Set(newest.slice(0, MAX_CARRIED_PAGES).map((page) => page.pageId));
    return this.#carried;
  }

  #append(
    aggregate: string,
    expectedVersion: number,
    eventName: string,
    payload: unknown,
    occurredAt: string,
    actor: EventActor,
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
          actor,
          occurredAt: decodeTimestamp(occurredAt),
          payload,
        },
      ],
    });
  }
}
