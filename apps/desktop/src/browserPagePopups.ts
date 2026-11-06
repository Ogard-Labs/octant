import { randomUUID } from "node:crypto";
import {
  decodeBrowserPagePopupId,
  type BrowserPagePopupId,
  type HumanBrowserPagePopup,
  type HumanBrowserPopupAnswer,
  type HumanBrowserResult,
} from "@octant/contracts/browser-presentation";

type Draft<T> = T extends unknown ? Omit<T, "id"> : never;
export type BrowserPagePopupDraft = Draft<HumanBrowserPagePopup>;

export interface BrowserPagePopupSource {
  /** The same page document still holds the popup. */
  readonly current: () => boolean;
  /** Apply the person's answer on Stable's page; false when the page refused it. */
  readonly answer: (answer: HumanBrowserPopupAnswer) => Promise<boolean>;
  /** Close the popup unanswered: a dialog is dismissed, a select keeps its value. */
  readonly dismiss: () => void;
}
interface Owned {
  readonly popup: HumanBrowserPagePopup;
  readonly source: BrowserPagePopupSource;
  /** Aborted once the popup is answered, dismissed, replaced or retired. */
  readonly retired: AbortController;
}

/**
 * At most one captured page popup per tab, offered to the person's presentation
 * and answered once. A page dialog is modal in Chromium, so a later popup never
 * replaces one; any other popup is replaced by its successor, which dismisses it.
 */
export class BrowserPagePopups {
  #owned: Owned | undefined;
  readonly #waiters = new Set<() => void>();

  offer(
    draft: BrowserPagePopupDraft,
    source: BrowserPagePopupSource,
  ): BrowserPagePopupId | undefined {
    if (this.#owned !== undefined && this.#owned.source.current()) {
      if (this.#owned.popup.kind === "dialog") {
        source.dismiss();
        return undefined;
      }
    }
    this.close();
    const id = decodeBrowserPagePopupId(randomUUID());
    this.#owned = {
      popup: { ...draft, id } as HumanBrowserPagePopup,
      source,
      retired: new AbortController(),
    };
    for (const wake of this.#waiters) wake();
    return id;
  }

  read(): HumanBrowserPagePopup | undefined {
    const owned = this.#owned;
    if (owned === undefined) return undefined;
    if (!owned.source.current()) {
      this.close();
      return undefined;
    }
    return owned.popup;
  }

  /** Wait a bounded time for a popup, so the presenter can poll without a busy loop. */
  async next(signal: AbortSignal | undefined, timeoutMs: number): Promise<HumanBrowserResult> {
    const ready = this.read();
    if (ready !== undefined) return { status: "popup", popup: ready };
    if (signal?.aborted) return { status: "refused" };
    await new Promise<void>((done) => {
      const finish = () => {
        clearTimeout(timer);
        this.#waiters.delete(finish);
        signal?.removeEventListener("abort", finish);
        done();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.#waiters.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
    if (signal?.aborted) return { status: "refused" };
    const popup = this.read();
    return popup === undefined ? { status: "idle" } : { status: "popup", popup };
  }

  async answer(
    id: BrowserPagePopupId,
    answer: HumanBrowserPopupAnswer,
    authorized: () => boolean = () => true,
  ): Promise<boolean> {
    const owned = this.#owned;
    if (
      owned === undefined ||
      owned.popup.id !== id ||
      owned.popup.kind !== answer.kind ||
      !owned.source.current() ||
      !authorized() ||
      !answerFits(owned.popup, answer)
    )
      return false;
    // Single use: the ticket is spent before the page sees the answer.
    this.#take();
    try {
      return await owned.source.answer(answer);
    } catch {
      return false;
    }
  }

  dismiss(id: BrowserPagePopupId): boolean {
    if (this.#owned?.popup.id !== id) return false;
    this.close();
    return true;
  }

  /** Retire the pending popup of one kind, as when the page closed its own dialog. */
  retire(kind: HumanBrowserPagePopup["kind"]): void {
    if (this.#owned?.popup.kind === kind) this.#take();
  }

  /**
   * Hold a bounded time while this popup is still pending, so Nightly can close
   * its own sheet or menu as soon as Stable retires the popup.
   */
  async watch(
    id: BrowserPagePopupId,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<boolean> {
    const owned = this.#owned;
    if (owned === undefined || owned.popup.id !== id || this.read() !== owned.popup) return false;
    await new Promise<void>((done) => {
      const finish = () => {
        clearTimeout(timer);
        owned.retired.signal.removeEventListener("abort", finish);
        signal?.removeEventListener("abort", finish);
        done();
      };
      const timer = setTimeout(finish, timeoutMs);
      owned.retired.signal.addEventListener("abort", finish, { once: true });
      signal?.addEventListener("abort", finish, { once: true });
      if (owned.retired.signal.aborted || signal?.aborted) finish();
    });
    return signal?.aborted !== true && this.read() === owned.popup;
  }

  #take(): Owned | undefined {
    const owned = this.#owned;
    this.#owned = undefined;
    owned?.retired.abort();
    return owned;
  }

  close(): void {
    const owned = this.#take();
    try {
      owned?.source.dismiss();
    } catch {
      /* A gone page has nothing left to dismiss. */
    }
  }
}

function answerFits(popup: HumanBrowserPagePopup, answer: HumanBrowserPopupAnswer): boolean {
  if (popup.kind === "select" && answer.kind === "select")
    return answer.index < popup.options.length && popup.options[answer.index]?.disabled === false;
  if (popup.kind === "context" && answer.kind === "context")
    return answer.action === "open-link" || answer.action === "copy-link"
      ? popup.link
      : popup.image;
  if (popup.kind === "file" && answer.kind === "file")
    return popup.multiple || answer.paths.length === 1;
  if (popup.kind === "notice") return false;
  return popup.kind === "dialog" && answer.kind === "dialog";
}
