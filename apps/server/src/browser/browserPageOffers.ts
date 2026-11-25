import {
  BrowserContextId,
  type BrowserPageClaimResult,
  type BrowserPageDismissResult,
  type BrowserPageOfferCommand,
  type BrowserPageReopenOffer,
  type BrowserProfile,
  type BrowserThreadId,
  type WindowId,
} from "@octant/contracts";
import { Schema } from "effect";
import { browserPageOfferProfile } from "@octant/domain";
import type { OpenBrowserPage } from "../persistence/browserPageProjection";
import type { BrowserPageSessions } from "./browserPageSessions";

const decodeContextId = Schema.decodeUnknownSync(BrowserContextId);

export interface BrowserPageOffersOptions {
  readonly sessions: Pick<BrowserPageSessions, "page" | "ended" | "open">;
  /** The pages the previous run left open and the start kept offered. */
  readonly offeredAtStart: ReadonlySet<string>;
  /** Whether the thread is live for this window now: not archived, not deleted, Project not archived. */
  readonly canOpenBrowser: (
    windowId: WindowId,
    threadId: BrowserThreadId,
    mode: "work" | "code",
  ) => boolean;
  /** Whether the thread already has a page of its own Browser pane open. */
  readonly hasOpenPage: (threadId: BrowserThreadId) => boolean;
  readonly profileExists: (profile: BrowserProfile) => Promise<boolean>;
}

/**
 * The page a restart or crash took, offered back in the thread's Browser pane.
 * The offer exists only for the host's person: the route that calls this has
 * already refused a restricted, below-Full or hub-introduced device, and every
 * check here runs before the record is changed.
 */
export class BrowserPageOffers {
  readonly #options: BrowserPageOffersOptions;
  readonly #offered: Set<string>;

  constructor(options: BrowserPageOffersOptions) {
    this.#options = options;
    this.#offered = new Set(options.offeredAtStart);
  }

  /** The offer for a thread, or nothing when it has none to show. */
  async read(
    windowId: WindowId,
    threadId: BrowserThreadId,
  ): Promise<BrowserPageReopenOffer | undefined> {
    const page = this.#offeredPageOf(threadId);
    if (page === undefined) return undefined;
    if (!this.#options.canOpenBrowser(windowId, threadId, page.mode)) return undefined;
    if (this.#options.hasOpenPage(threadId)) return undefined;
    const profile = browserPageOfferProfile(page);
    return {
      pageId: decodeContextId(page.pageId),
      status: (await this.#options.profileExists(profile)) ? "offered" : "profile-gone",
      profile,
    };
  }

  /**
   * One claim per page: the end is written at the version the start left, so of
   * two windows that claim together exactly one is told the profile to open.
   */
  async claim(
    windowId: WindowId,
    command: BrowserPageOfferCommand,
  ): Promise<BrowserPageClaimResult> {
    const page = this.#claimable(windowId, command);
    if (page === undefined) return { status: "refused", reason: "not-offered" };
    if (page === "not-allowed") return { status: "refused", reason: "not-allowed" };
    const profile = browserPageOfferProfile(page);
    if (!(await this.#options.profileExists(profile)))
      return { status: "refused", reason: "profile-gone" };
    // Checked again after the wait: a second window may have claimed meanwhile.
    const again = this.#claimable(windowId, command);
    if (again === undefined || again === "not-allowed" || again.pageId !== page.pageId)
      return { status: "refused", reason: "not-offered" };
    if (!this.#options.sessions.ended(page.pageId, page.threadId, "reopened"))
      return { status: "refused", reason: "not-offered" };
    this.#offered.delete(page.pageId);
    return { status: "claimed", profile };
  }

  dismiss(windowId: WindowId, command: BrowserPageOfferCommand): BrowserPageDismissResult {
    const page = this.#claimable(windowId, command);
    if (page === undefined) return { status: "refused", reason: "not-offered" };
    if (page === "not-allowed") return { status: "refused", reason: "not-allowed" };
    if (!this.#options.sessions.ended(page.pageId, page.threadId, "dismissed"))
      return { status: "refused", reason: "not-offered" };
    this.#offered.delete(page.pageId);
    return { status: "dismissed" };
  }

  #offeredPageOf(threadId: BrowserThreadId): OpenBrowserPage | undefined {
    return this.#options.sessions
      .open()
      .find((page) => String(page.threadId) === String(threadId) && this.#offered.has(page.pageId));
  }

  #claimable(
    windowId: WindowId,
    command: BrowserPageOfferCommand,
  ): OpenBrowserPage | "not-allowed" | undefined {
    if (!this.#offered.has(String(command.pageId))) return undefined;
    const page = this.#options.sessions.page(String(command.pageId));
    if (page === undefined || page.threadId !== String(command.threadId)) return undefined;
    if (page.mode !== command.mode) return undefined;
    if (!this.#options.canOpenBrowser(windowId, command.threadId, page.mode)) return "not-allowed";
    if (this.#options.hasOpenPage(command.threadId)) return undefined;
    return page;
  }
}
