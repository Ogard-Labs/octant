import { randomUUID } from "node:crypto";
import {
  decodeBrowserEditMenuId,
  type BrowserEditMenuId,
  type BrowserEditorId,
  type BrowserEditFlags,
  type BrowserEditAction,
  type HumanBrowserResult,
} from "@octant/contracts/browser-presentation";

interface MenuSource {
  readonly current: () => boolean;
  readonly editor: () => Promise<BrowserEditorId | undefined>;
  readonly apply: (action: BrowserEditAction) => void;
}
interface OwnedMenu {
  readonly editorId: BrowserEditorId;
  readonly source: MenuSource;
  readonly retired: AbortController;
  readonly offered:
    | { readonly id: BrowserEditMenuId; readonly flags: BrowserEditFlags }
    | undefined;
}
/** A native gesture captures its field before dispatch, never a later focused successor. */
export class BrowserPageEditMenu {
  #owned: OwnedMenu | undefined;

  arm(editorId: BrowserEditorId, source: MenuSource): void {
    this.close();
    this.#owned = { editorId, source, retired: new AbortController(), offered: undefined };
  }

  offer(flags: BrowserEditFlags): void {
    const owned = this.#owned;
    if (owned === undefined || !owned.source.current()) return this.close();
    this.#owned = {
      ...owned,
      retired: new AbortController(),
      offered: { id: decodeBrowserEditMenuId(randomUUID()), flags },
    };
    owned.retired.abort();
  }

  async #current(id?: BrowserEditMenuId): Promise<OwnedMenu | undefined> {
    const owned = this.#owned;
    if (
      owned === undefined ||
      owned.offered === undefined ||
      (id !== undefined && owned.offered.id !== id)
    )
      return undefined;
    const offered = owned.offered;
    const editor = await owned.source.editor().catch(() => undefined);
    if (this.#owned !== owned || owned.offered !== offered) return undefined;
    if (!owned.source.current() || editor !== owned.editorId) {
      this.close();
      return undefined;
    }
    return owned;
  }

  async read(): Promise<HumanBrowserResult> {
    const owned = await this.#current();
    return owned !== this.#owned || owned?.offered === undefined
      ? { status: "idle" }
      : { status: "edit-menu", menuId: owned.offered.id, flags: owned.offered.flags };
  }

  async act(
    id: BrowserEditMenuId,
    action: BrowserEditAction,
    authorized: () => boolean = () => true,
  ): Promise<boolean> {
    const owned = await this.#current(id);
    if (
      owned !== this.#owned ||
      owned?.offered?.id !== id ||
      owned.offered.flags[action] !== true ||
      !authorized()
    )
      return false;
    this.close();
    try {
      owned.source.apply(action);
      return true;
    } catch {
      return false;
    }
  }

  async watch(id: BrowserEditMenuId, signal?: AbortSignal): Promise<boolean> {
    const owned = await this.#current(id);
    if (owned === undefined || owned !== this.#owned || signal?.aborted) return false;
    await new Promise<void>((done) => {
      const finish = () => {
        clearTimeout(timer);
        owned.retired.signal.removeEventListener("abort", finish);
        signal?.removeEventListener("abort", finish);
        done();
      };
      const timer = setTimeout(finish, 250);
      owned.retired.signal.addEventListener("abort", finish, { once: true });
      signal?.addEventListener("abort", finish, { once: true });
      if (owned.retired.signal.aborted || signal?.aborted) finish();
    });
    return !signal?.aborted && (await this.#current(id)) === owned;
  }

  dismiss(id: BrowserEditMenuId): boolean {
    if (this.#owned?.offered?.id !== id) return false;
    this.close();
    return true;
  }

  close(): void {
    const owned = this.#owned;
    this.#owned = undefined;
    owned?.retired.abort();
  }
}
