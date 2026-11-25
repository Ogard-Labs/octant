import {
  BrowserContextId,
  type BrowserPageClaimResult,
  type BrowserPageDismissResult,
  type BrowserPageOfferCommand,
  type BrowserPageReleaseResult,
  type BrowserPageReopenOffer,
  type BrowserProfile,
  type BrowserThreadId,
  type EventActor,
  type WindowId,
} from "@octant/contracts";
import { Schema } from "effect";
import { browserPageOfferProfile } from "@octant/domain";
import type { OpenBrowserPage } from "../persistence/browserPageProjection";
import type { BrowserPageSessions } from "./browserPageSessions";

const decodeContextId = Schema.decodeUnknownSync(BrowserContextId);

/**
 * How long a window or device may hold a page's reservation without opening.
 * A backstop only: a failed or abandoned open gives it back at once, and a
 * window that goes away gives back everything it held.
 */
const RESERVATION_MS = 120_000;

/** What the host knows of a profile: it exists, it is gone, or the list could not be read now. */
export type BrowserProfileState = "exists" | "gone" | "unknown";

export interface BrowserPageOffersOptions {
  readonly sessions: Pick<BrowserPageSessions, "page" | "ended" | "openOfThread" | "carries">;
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
  readonly profileState: (profile: BrowserProfile) => Promise<BrowserProfileState>;
  readonly now?: () => number;
}

interface Reservation {
  readonly holder: string;
  readonly until: number;
}

/**
 * The page a restart or crash took, offered back in the thread's Browser pane.
 * The offer exists only for the host's person: the route that calls this has
 * already refused a restricted, below-Full or hub-introduced device, and every
 * check here runs before anything is changed.
 *
 * A claim is a short exclusive reservation held in memory by one window or
 * device. The offer ends only when the open that reservation was for succeeds
 * (that open ends the record as reopened), or on dismiss, archive or delete, so
 * a declined approval, a failed open or a reload loses nothing.
 */
export class BrowserPageOffers {
  readonly #options: BrowserPageOffersOptions;
  readonly #offered: Set<string>;
  readonly #reservations = new Map<string, Reservation>();
  readonly #now: () => number;

  constructor(options: BrowserPageOffersOptions) {
    this.#options = options;
    this.#offered = new Set(options.offeredAtStart);
    this.#now = options.now ?? Date.now;
  }

  /** The offer for a thread, or nothing when it has none to show this holder. */
  async read(
    windowId: WindowId,
    threadId: BrowserThreadId,
  ): Promise<BrowserPageReopenOffer | undefined> {
    const page = this.#offeredPageOf(threadId);
    if (page === undefined) return undefined;
    if (!this.#options.canOpenBrowser(windowId, threadId, page.mode)) return undefined;
    if (this.#options.hasOpenPage(threadId)) return undefined;
    if (this.#heldByOther(page.pageId, windowId)) return undefined;
    const profile = browserPageOfferProfile(page);
    const state = await this.#options.profileState(profile);
    return {
      pageId: decodeContextId(page.pageId),
      status:
        state === "exists" ? "offered" : state === "gone" ? "profile-gone" : "profile-unchecked",
      profile,
    };
  }

  /**
   * Reserves the page for this window or device and says which profile to open
   * a blank page in. Of two windows that claim together, exactly one holds it:
   * the reservation is set with no wait between the last check and the write.
   */
  async claim(
    windowId: WindowId,
    command: BrowserPageOfferCommand,
  ): Promise<BrowserPageClaimResult> {
    const page = this.#claimable(windowId, command);
    if (page === undefined) return { status: "refused", reason: "not-offered" };
    if (page === "not-allowed") return { status: "refused", reason: "not-allowed" };
    const profile = browserPageOfferProfile(page);
    if ((await this.#options.profileState(profile)) === "gone")
      return { status: "refused", reason: "profile-gone" };
    // Checked again after the wait: a second window may have reserved meanwhile.
    const again = this.#claimable(windowId, command);
    if (again === undefined || again === "not-allowed" || again.pageId !== page.pageId)
      return { status: "refused", reason: "not-offered" };
    this.#reserve(page.pageId, windowId);
    return { status: "claimed", profile };
  }

  /** Whether this window or device holds the reservation the open it is making needs. */
  holds(windowId: WindowId, command: BrowserPageOfferCommand): boolean {
    const page = this.#claimable(windowId, command);
    return (
      page !== undefined &&
      page !== "not-allowed" &&
      this.#reservations.get(page.pageId)?.holder === String(windowId) &&
      !this.#expired(page.pageId)
    );
  }

  /**
   * What the open that names this page may do. A reservation that lapsed (the
   * two minutes ran out, or it was given back) is taken again here, with no
   * wait between the check and the write, unless another window or device holds
   * the page now; then the open is refused rather than run as an ordinary one.
   */
  holdForOpen(
    windowId: WindowId,
    command: BrowserPageOfferCommand,
  ): "held" | "held-by-other" | "not-offered" {
    const page = this.#offeredFor(windowId, command);
    if (page === undefined || page === "not-allowed") return "not-offered";
    if (this.#heldByOther(page.pageId, windowId)) return "held-by-other";
    if (this.#expired(page.pageId)) this.#reserve(page.pageId, windowId);
    return "held";
  }

  /** Gives the reservation back: the open failed, was declined, or was abandoned. */
  release(windowId: WindowId, command: BrowserPageOfferCommand): BrowserPageReleaseResult {
    if (!this.#options.canOpenBrowser(windowId, command.threadId, command.mode))
      return { status: "refused", reason: "not-allowed" };
    if (this.#reservations.get(String(command.pageId))?.holder === String(windowId))
      this.#reservations.delete(String(command.pageId));
    return { status: "released" };
  }

  /** A window that goes away gives back every page it held. */
  releaseWindow(windowId: WindowId): void {
    for (const [pageId, held] of this.#reservations) {
      if (held.holder === String(windowId)) this.#reservations.delete(pageId);
    }
  }

  dismiss(
    windowId: WindowId,
    command: BrowserPageOfferCommand,
    actor: EventActor,
  ): BrowserPageDismissResult {
    const page = this.#claimable(windowId, command);
    if (page === undefined) return { status: "refused", reason: "not-offered" };
    if (page === "not-allowed") return { status: "refused", reason: "not-allowed" };
    if (!this.#options.sessions.ended(page.pageId, page.threadId, "dismissed", actor))
      return { status: "refused", reason: "not-offered" };
    this.#offered.delete(page.pageId);
    this.#reservations.delete(page.pageId);
    return { status: "dismissed" };
  }

  #reserve(pageId: string, windowId: WindowId): void {
    this.#reservations.set(pageId, {
      holder: String(windowId),
      until: this.#now() + RESERVATION_MS,
    });
  }

  #expired(pageId: string): boolean {
    const held = this.#reservations.get(pageId);
    return held === undefined || held.until <= this.#now();
  }

  /** Whether another live window or device holds the page. */
  #heldByOther(pageId: string, windowId: WindowId): boolean {
    const held = this.#reservations.get(pageId);
    if (held === undefined) return false;
    if (this.#expired(pageId)) {
      this.#reservations.delete(pageId);
      return false;
    }
    return held.holder !== String(windowId);
  }

  /** Left by the previous run and kept by the start, or held by this run when its app quit. */
  #isOffered(pageId: string): boolean {
    return this.#offered.has(pageId) || this.#options.sessions.carries(pageId);
  }

  #offeredPageOf(threadId: BrowserThreadId): OpenBrowserPage | undefined {
    return this.#options.sessions
      .openOfThread(String(threadId))
      .find((page) => this.#isOffered(page.pageId));
  }

  #claimable(
    windowId: WindowId,
    command: BrowserPageOfferCommand,
  ): OpenBrowserPage | "not-allowed" | undefined {
    const page = this.#offeredFor(windowId, command);
    if (page === undefined || page === "not-allowed") return page;
    if (this.#heldByOther(page.pageId, windowId)) return undefined;
    return page;
  }

  /** The offered page a command names, whoever holds it. */
  #offeredFor(
    windowId: WindowId,
    command: BrowserPageOfferCommand,
  ): OpenBrowserPage | "not-allowed" | undefined {
    if (!this.#isOffered(String(command.pageId))) return undefined;
    const page = this.#options.sessions.page(String(command.pageId));
    if (page === undefined || page.threadId !== String(command.threadId)) return undefined;
    if (page.mode !== command.mode) return undefined;
    if (!this.#options.canOpenBrowser(windowId, command.threadId, page.mode)) return "not-allowed";
    if (this.#options.hasOpenPage(command.threadId)) return undefined;
    return page;
  }
}
