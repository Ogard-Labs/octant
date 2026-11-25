import {
  BROWSER_PAGE_CLOSED,
  BrowserAccountProfileId,
  ProjectId,
  BROWSER_PAGE_OPENED,
  BROWSER_PAGE_AGGREGATE_TYPE,
  decodeBrowserPageClosed,
  decodeBrowserPageOpened,
  type BrowserPageOpened,
  type EventEnvelope,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Projection } from "./projection";
import type { SqliteConnection } from "./sqlitePort";
import { clampCheckpointsToJournalHead, reconcileAggregateHeads } from "./threadPurge";

/**
 * The Browser pages the journal records as open: an open event with no end.
 *
 * The one question asked of it is which pages a restart or crash took, so a
 * closed page leaves no row and the table holds at most the pages open now.
 * An open writes the whole row and an end deletes it, so replay lands on the
 * same state however often it runs, and a journal that holds neither event
 * rebuilds to nothing.
 */
export class BrowserPageProjection implements Projection {
  readonly name = "browser-page";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec(`DELETE FROM browser_page_projection;`);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    if (event.eventName === BROWSER_PAGE_OPENED) {
      const opened = decodeBrowserPageOpened(event.payload);
      connection
        .prepare(
          `INSERT OR REPLACE INTO browser_page_projection (
             page_id, thread_id, window_id, mode, profile_kind, account_id, project_id,
             opened_at, last_sequence
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          String(opened.pageId),
          String(opened.threadId),
          String(opened.windowId),
          opened.mode,
          opened.profileKind,
          opened.accountId === undefined ? null : String(opened.accountId),
          String(opened.projectId),
          opened.openedAt,
          event.globalSequence,
        );
      return;
    }
    if (event.eventName === BROWSER_PAGE_CLOSED) {
      const closed = decodeBrowserPageClosed(event.payload);
      connection
        .prepare(`DELETE FROM browser_page_projection WHERE page_id = ?`)
        .run(String(closed.pageId));
    }
  }
}

const decodeProjectId = Schema.decodeUnknownSync(ProjectId);
const decodeAccountId = Schema.decodeUnknownSync(BrowserAccountProfileId);

interface BrowserPageRow {
  readonly page_id: string;
  readonly thread_id: string;
  readonly window_id: string;
  readonly mode: "work" | "code";
  readonly profile_kind: BrowserPageOpened["profileKind"];
  readonly account_id: string | null;
  readonly project_id: string;
  readonly opened_at: string;
}

export interface OpenBrowserPage {
  readonly pageId: string;
  readonly threadId: string;
  readonly windowId: string;
  readonly mode: "work" | "code";
  readonly profileKind: BrowserPageOpened["profileKind"];
  readonly accountId: BrowserPageOpened["accountId"];
  readonly projectId: BrowserPageOpened["projectId"];
  readonly openedAt: string;
}

function toOpenPage(row: BrowserPageRow): OpenBrowserPage {
  return {
    pageId: row.page_id,
    threadId: row.thread_id,
    windowId: row.window_id,
    mode: row.mode,
    profileKind: row.profile_kind,
    accountId: row.account_id === null ? undefined : decodeAccountId(row.account_id),
    projectId: decodeProjectId(row.project_id),
    openedAt: row.opened_at,
  };
}

const COLUMNS = `page_id, thread_id, window_id, mode, profile_kind, account_id, project_id, opened_at`;

export function readOpenBrowserPages(connection: SqliteConnection): ReadonlyArray<OpenBrowserPage> {
  return (
    connection
      .prepare(`SELECT ${COLUMNS} FROM browser_page_projection ORDER BY last_sequence ASC`)
      .all() as ReadonlyArray<BrowserPageRow>
  ).map(toOpenPage);
}

export function readOpenBrowserPage(
  connection: SqliteConnection,
  pageId: string,
): OpenBrowserPage | undefined {
  const row = connection
    .prepare(`SELECT ${COLUMNS} FROM browser_page_projection WHERE page_id = ?`)
    .get(pageId) as BrowserPageRow | undefined;
  return row === undefined ? undefined : toOpenPage(row);
}

/**
 * Remove the journal history of pages that ended, both events of each page
 * together, so a thread that opens and closes a page a thousand times leaves
 * no more than the pages open now. Their projection rows are already gone, so
 * no projection reads what leaves. Returns how many pages left.
 */
export function compactClosedBrowserPages(connection: SqliteConnection): number {
  // Off for the deletion like a thread purge: the quarantine rows that name a
  // deleted event leave in the same transaction.
  connection.pragma("foreign_keys = OFF");
  try {
    return deleteClosedPages(connection);
  } finally {
    connection.pragma("foreign_keys = ON");
  }
}

function deleteClosedPages(connection: SqliteConnection): number {
  return connection.transaction((): number => {
    const closed = connection
      .prepare(
        `SELECT DISTINCT aggregate_id FROM event_journal
         WHERE aggregate_type = ? AND event_name = ?`,
      )
      .all(BROWSER_PAGE_AGGREGATE_TYPE, BROWSER_PAGE_CLOSED) as ReadonlyArray<{
      readonly aggregate_id: string;
    }>;
    for (const { aggregate_id } of closed) {
      connection
        .prepare(
          `DELETE FROM event_quarantine WHERE global_sequence IN (
             SELECT global_sequence FROM event_journal
             WHERE aggregate_type = ? AND aggregate_id = ?)`,
        )
        .run(BROWSER_PAGE_AGGREGATE_TYPE, aggregate_id);
      connection
        .prepare(`DELETE FROM event_journal WHERE aggregate_type = ? AND aggregate_id = ?`)
        .run(BROWSER_PAGE_AGGREGATE_TYPE, aggregate_id);
    }
    if (closed.length > 0) {
      reconcileAggregateHeads(connection);
      clampCheckpointsToJournalHead(connection);
    }
    return closed.length;
  })();
}
