import { randomUUID } from "node:crypto";
import {
  decodeBrowserCompositionId,
  type BrowserEditorId,
  type HumanBrowserComposition,
  type HumanBrowserEditor,
  type HumanBrowserResult,
} from "@octant/contracts/browser-presentation";

type Edit = Exclude<HumanBrowserComposition, { readonly phase: "begin" }>;
export interface BrowserTextSource {
  readonly editor: () => Promise<HumanBrowserEditor | undefined>;
  readonly apply: (
    editorId: BrowserEditorId,
    edit: Edit,
    authorized: () => boolean,
  ) => Promise<boolean>;
}
interface OwnedComposition {
  readonly id: Extract<Edit, { readonly phase: "cancel" }>["compositionId"];
  readonly editorId: BrowserEditorId;
  readonly source: BrowserTextSource;
}

interface BrowserTextCompositionOptions {
  readonly current: () => boolean;
  readonly source: () => BrowserTextSource;
}

/** One current field transaction, with cleanup serialized ahead of its successor. */
export class BrowserTextComposition {
  readonly #options: BrowserTextCompositionOptions;
  #owned: OwnedComposition | undefined;
  #generation = 0;
  #pending = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: BrowserTextCompositionOptions) {
    this.#options = options;
  }

  async editor(): Promise<HumanBrowserEditor | undefined> {
    const generation = this.#generation;
    if (!this.#options.current()) return undefined;
    const editor = await this.#options
      .source()
      .editor()
      .catch(() => undefined);
    return generation === this.#generation && this.#options.current() ? editor : undefined;
  }

  execute(
    edit: HumanBrowserComposition,
    authorized: () => boolean = () => true,
  ): Promise<HumanBrowserResult> {
    const generation = this.#generation;
    if (this.#pending >= 4) return Promise.resolve({ status: "refused" });
    this.#pending++;
    const result = this.#tail.then(async (): Promise<HumanBrowserResult> => {
      if (generation !== this.#generation || !this.#options.current() || !authorized())
        return { status: "refused" };
      if (edit.phase === "begin") {
        if (this.#owned !== undefined) return { status: "refused" };
        const source = this.#options.source();
        const editor = await source.editor().catch(() => undefined);
        // A password field never composes through Nightly's input context.
        if (
          editor === undefined ||
          "secure" in editor ||
          editor.id !== edit.editorId ||
          generation !== this.#generation ||
          !this.#options.current() ||
          !authorized()
        )
          return { status: "refused" };
        const id = decodeBrowserCompositionId(randomUUID());
        this.#owned = { id, editorId: editor.id, source };
        return { status: "composition-started", compositionId: id };
      }
      const owned = this.#owned;
      if (owned?.id !== edit.compositionId) return { status: "refused" };
      if (edit.phase !== "update") this.#owned = undefined;
      const applied = await owned.source
        .apply(
          owned.editorId,
          edit,
          () => generation === this.#generation && this.#options.current() && authorized(),
        )
        .catch(() => false);
      if (!applied && this.#owned === owned) this.#owned = undefined;
      return applied && generation === this.#generation && this.#options.current()
        ? { status: "accepted" }
        : { status: "refused" };
    });
    this.#tail = result.then(
      () => {
        this.#pending--;
      },
      () => {
        this.#pending--;
      },
    );
    return result.catch(() => ({ status: "refused" }));
  }

  close(): Promise<boolean> {
    const owned = this.#owned;
    this.#owned = undefined;
    this.#generation++;
    const result = this.#tail.then(async () => {
      if (owned === undefined) return true;
      // Cleanup may run after hide/revocation. The fixed source must still bind
      // cancellation to this exact view and field, never the next focused field.
      return owned.source
        .apply(owned.editorId, { phase: "cancel", compositionId: owned.id }, () => true)
        .catch(() => false);
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.catch(() => false);
  }
}
