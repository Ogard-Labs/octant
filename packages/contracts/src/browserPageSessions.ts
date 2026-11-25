import { Schema } from "effect";
import {
  BrowserAccountProfileId,
  BrowserContextId,
  BrowserProfile,
  BrowserThreadId,
} from "./browserAutomation";
import { UtcTimestamp } from "./events";
import { ProjectId } from "./projects";
import { WindowId } from "./shell";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * A Browser session is the person's open page in a thread's Browser pane. The
 * host records that one opened and that it ended, so that after a restart or
 * crash a start with no end is the page the restart took, and the pane can
 * offer to open a blank page in the same profile again.
 *
 * One aggregate per page (aggregate id = page id), so the pair of events of a
 * closed page can leave the journal together and a claim is one append at the
 * version the open left. Nothing here names an address, title, or content of
 * the page: the record exists to open a blank page, never to restore one.
 */
export const BROWSER_PAGE_AGGREGATE_TYPE = "browser-page";
export const BROWSER_PAGE_OPENED = "browser.page-opened@1";
export const BROWSER_PAGE_CLOSED = "browser.page-closed@1";

/** The kind of profile the page lived in; a Private page is recorded as this and nothing more. */
export const BrowserPageProfileKind = Schema.Literal("private", "project", "personal", "account");
export type BrowserPageProfileKind = typeof BrowserPageProfileKind.Type;

export const BrowserPageOpened = Schema.Struct({
  /** The id of the page's browsing context. */
  pageId: BrowserContextId,
  threadId: BrowserThreadId,
  windowId: WindowId,
  mode: Schema.Literal("work", "code"),
  profileKind: BrowserPageProfileKind,
  /** The Project of the thread: what a Project erase takes, and what a Project profile means. */
  projectId: ProjectId,
  /** Present only for the named account profile the page lived in. */
  accountId: Schema.optional(BrowserAccountProfileId),
  openedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (opened) => (opened.profileKind === "account") === (opened.accountId !== undefined),
    ),
  );
export type BrowserPageOpened = typeof BrowserPageOpened.Type;
export const decodeBrowserPageOpened = Schema.decodeUnknownSync(BrowserPageOpened);

/**
 * Why a page's record ended. Every reason but the last three is the page
 * ending by an ordinary act; `reopened`, `dismissed`, and `superseded` end the
 * offer that a restart left, never a live page.
 */
export const BrowserPageCloseReason = Schema.Literal(
  "closed-by-person",
  "closed-by-agent",
  "expired",
  "runtime-lost",
  "authority-ended",
  "thread-ended",
  "profile-removed",
  "reopened",
  "dismissed",
  "superseded",
);
export type BrowserPageCloseReason = typeof BrowserPageCloseReason.Type;

export const BrowserPageClosed = Schema.Struct({
  pageId: BrowserContextId,
  /** Repeated so a thread purge finds the event by the thread it names. */
  threadId: BrowserThreadId,
  reason: BrowserPageCloseReason,
  closedAt: UtcTimestamp,
}).annotations(strict);
export type BrowserPageClosed = typeof BrowserPageClosed.Type;
export const decodeBrowserPageClosed = Schema.decodeUnknownSync(BrowserPageClosed);

/**
 * The offer on the thread's Browser read. `offered` carries the profile the
 * blank page opens in; `profile-gone` says the profile no longer exists, so
 * the pane explains instead of offering, and only Dismiss is left.
 */
export const BrowserPageReopenOffer = Schema.Struct({
  pageId: BrowserContextId,
  status: Schema.Literal("offered", "profile-gone"),
  profile: BrowserProfile,
}).annotations(strict);
export type BrowserPageReopenOffer = typeof BrowserPageReopenOffer.Type;

export const BrowserPageOfferCommand = Schema.Struct({
  threadId: BrowserThreadId,
  mode: Schema.Literal("work", "code"),
  pageId: BrowserContextId,
}).annotations(strict);
export type BrowserPageOfferCommand = typeof BrowserPageOfferCommand.Type;
export const decodeBrowserPageOfferCommand = Schema.decodeUnknownSync(BrowserPageOfferCommand);

export const BrowserPageOfferRefusalReason = Schema.Literal(
  /** Another window claimed it, it was dismissed, or the restart did not take that page. */
  "not-offered",
  "profile-gone",
  "not-allowed",
);
export type BrowserPageOfferRefusalReason = typeof BrowserPageOfferRefusalReason.Type;

export const BrowserPageClaimResult = Schema.Union(
  Schema.Struct({ status: Schema.Literal("claimed"), profile: BrowserProfile }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: BrowserPageOfferRefusalReason,
  }).annotations(strict),
);
export type BrowserPageClaimResult = typeof BrowserPageClaimResult.Type;
export const decodeBrowserPageClaimResult = Schema.decodeUnknownSync(BrowserPageClaimResult);

export const BrowserPageDismissResult = Schema.Union(
  Schema.Struct({ status: Schema.Literal("dismissed") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: BrowserPageOfferRefusalReason,
  }).annotations(strict),
);
export type BrowserPageDismissResult = typeof BrowserPageDismissResult.Type;
export const decodeBrowserPageDismissResult = Schema.decodeUnknownSync(BrowserPageDismissResult);
