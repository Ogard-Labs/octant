import { createHash, randomUUID } from "node:crypto";
import {
  decodeBrowserPresentationId,
  type BrowserPresentationId,
  MAX_HUMAN_FRAME_BYTES,
  MAX_HUMAN_FRAME_HEIGHT,
  MAX_HUMAN_FRAME_WIDTH,
  type HumanBrowserInput,
  type HumanBrowserLayout,
  type HumanBrowserResult,
} from "@octant/contracts/browser-presentation";

export interface HumanBrowserImage {
  getSize(): { readonly width: number; readonly height: number };
  toJPEG(quality: number): Uint8Array;
}
export interface HumanBrowserSource {
  readonly frames: (listener: (image: HumanBrowserImage) => void) => () => void;
  readonly visible: (visible: boolean) => void;
  readonly bounds: (width: number, height: number) => void;
  readonly input: (input: HumanBrowserInput) => void;
  /**
   * The native caret at a host-observed UTF16 selection in the focused field,
   * in the page's CSS pixels. The host observes the field before and after.
   */
  readonly caret?: (
    start: number,
    end: number,
  ) =>
    | { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    | undefined;
}
interface Attached {
  readonly id: BrowserPresentationId;
  readonly source: HumanBrowserSource;
  readonly current: () => boolean;
  remove: () => void;
  visible: boolean;
  inputReady: boolean;
  sequence: number;
  layoutEpoch: number;
  lastImageHash: string | undefined;
  acknowledged: number;
  width: number;
  height: number;
  published: Extract<HumanBrowserResult, { status: "frame" }> | undefined;
  pending: HumanBrowserImage | undefined;
  readonly keys: Set<string>;
  readonly buttons: Map<string, { readonly x: number; readonly y: number }>;
}

/** Human pixels are never recorded as agent observations or credential custody. */
export class BrowserPresentation {
  #attached: Attached | undefined;

  attach(source: HumanBrowserSource, current: () => boolean): BrowserPresentationId {
    this.close();
    const owned: Attached = {
      id: decodeBrowserPresentationId(randomUUID()),
      source,
      current,
      remove: () => {},
      visible: false,
      inputReady: false,
      sequence: 0,
      layoutEpoch: 0,
      lastImageHash: undefined,
      acknowledged: 0,
      width: 800,
      height: 600,
      published: undefined,
      pending: undefined,
      keys: new Set(),
      buttons: new Map(),
    };
    this.#attached = owned;
    owned.remove = source.frames((image) => {
      if (this.#current(owned.id) !== owned || !owned.visible) return;
      const { width, height } = image.getSize();
      // Bound native pixel memory before retaining or encoding the image.
      if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > MAX_HUMAN_FRAME_WIDTH ||
        height > MAX_HUMAN_FRAME_HEIGHT
      )
        return;
      owned.pending = image;
    });
    return owned.id;
  }

  get visible(): boolean {
    const owned = this.#attached;
    return owned !== undefined && this.#current(owned.id) === owned && owned.visible;
  }

  layout(id: string, layout: HumanBrowserLayout): boolean {
    const owned = this.#current(id);
    if (owned === undefined) return false;
    if (
      !Number.isInteger(layout.width) ||
      !Number.isInteger(layout.height) ||
      layout.width < 1 ||
      layout.height < 1 ||
      layout.width > MAX_HUMAN_FRAME_WIDTH ||
      layout.height > MAX_HUMAN_FRAME_HEIGHT
    )
      return false;
    // A layout change retires the old coordinate space and releases its input.
    owned.visible = false;
    owned.layoutEpoch++;
    owned.lastImageHash = undefined;
    owned.inputReady = false;
    owned.published = undefined;
    owned.pending = undefined;
    owned.keys.clear();
    owned.buttons.clear();
    owned.source.visible(false);
    owned.width = layout.width;
    owned.height = layout.height;
    owned.source.bounds(layout.width, layout.height);
    owned.visible = layout.visible;
    owned.source.visible(layout.visible);
    return true;
  }

  guard(id: string): () => boolean {
    const owned = this.#current(id);
    const epoch = owned?.layoutEpoch;
    return () =>
      owned !== undefined &&
      this.#current(id) === owned &&
      owned.visible &&
      owned.layoutEpoch === epoch;
  }

  current(id: string): boolean {
    return this.#current(id) !== undefined;
  }

  frame(id: string, acknowledgement: number): HumanBrowserResult {
    const owned = this.#current(id);
    if (owned === undefined || !owned.visible) return { status: "refused" };
    // A lost HTTP/IPC response retransmits the same bounded published image.
    if (owned.published !== undefined && acknowledgement === owned.sequence - 1)
      return owned.published;
    if (acknowledgement !== owned.sequence) return { status: "refused" };
    owned.acknowledged = acknowledgement;
    owned.published = undefined;
    const image = owned.pending;
    if (image === undefined) return { status: "idle" };
    owned.pending = undefined;
    const { width, height } = image.getSize();
    const bytes = image.toJPEG(75);
    if (this.#current(id) !== owned || !owned.visible || bytes.byteLength > MAX_HUMAN_FRAME_BYTES)
      return { status: "refused" };
    // Hidden ordinary windows are captured at a bounded cadence, even when no
    // pixels changed. Re-publishing identical images needlessly invalidates a
    // person's displayed input frame while it is being decoded.
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (owned.lastImageHash === hash) return { status: "idle" };
    owned.lastImageHash = hash;
    owned.sequence += 1;
    owned.inputReady = true;
    owned.published = {
      status: "frame",
      sequence: owned.sequence,
      width,
      height,
      dataUrl: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`,
    };
    return owned.published;
  }

  input(id: string, input: HumanBrowserInput, frameSequence: number): boolean {
    return this.reserveInput(id, input, frameSequence)?.() ?? false;
  }

  /** Coordinates come from the owned native caret, never a request payload. */
  contextMenuAtCaret(
    id: string,
    point: { readonly x: number; readonly y: number },
    authorized: () => boolean,
  ): boolean {
    return this.#buttonPair(id, point, "right", authorized);
  }

  /**
   * A left click at a page point Stable computed for a mirrored node, sent as
   * the person's own press and release through the same native input.
   */
  pressAt(
    id: string,
    point: { readonly x: number; readonly y: number },
    authorized: () => boolean,
  ): boolean {
    return this.#buttonPair(id, point, "left", authorized);
  }

  /** One key press and release, as the person's own; refused while that key is held. */
  keyPress(id: string, keyCode: string, authorized: () => boolean): boolean {
    const owned = this.#current(id);
    if (
      owned === undefined ||
      !owned.visible ||
      !owned.inputReady ||
      !authorized() ||
      owned.keys.has(keyCode) ||
      owned.buttons.size !== 0
    )
      return false;
    const epoch = owned.layoutEpoch;
    const current = () =>
      this.#current(id) === owned && owned.visible && owned.layoutEpoch === epoch && authorized();
    let accepted = false;
    owned.keys.add(keyCode);
    try {
      owned.source.input({ type: "keyDown", keyCode, modifiers: [] });
      accepted = current();
    } catch {
      /* A partial native press still needs its matching release. */
    } finally {
      try {
        owned.source.input({ type: "keyUp", keyCode, modifiers: [] });
      } catch {
        accepted = false;
      }
      owned.keys.delete(keyCode);
    }
    return accepted && current();
  }

  #buttonPair(
    id: string,
    point: { readonly x: number; readonly y: number },
    button: "left" | "right",
    authorized: () => boolean,
  ): boolean {
    const owned = this.#current(id);
    if (
      owned === undefined ||
      !owned.visible ||
      !owned.inputReady ||
      !authorized() ||
      !Number.isInteger(point.x) ||
      !Number.isInteger(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x >= owned.width ||
      point.y >= owned.height ||
      owned.buttons.size !== 0
    )
      return false;
    const epoch = owned.layoutEpoch;
    const current = () =>
      this.#current(id) === owned && owned.visible && owned.layoutEpoch === epoch && authorized();
    let accepted = false;
    owned.buttons.set(button, point);
    try {
      owned.source.input({
        type: "mouseDown",
        button,
        ...point,
        clickCount: 1,
        modifiers: [],
      });
      accepted = current();
    } catch {
      /* A partial native press still needs its matching release. */
    } finally {
      const release = current() ? point : { x: -1, y: -1 };
      try {
        owned.source.input({
          type: "mouseUp",
          button,
          ...release,
          clickCount: 1,
          modifiers: [],
        });
      } catch {
        accepted = false;
      }
      owned.buttons.delete(button);
    }
    return accepted && current();
  }

  /** Admission precedes awaited composition cleanup; dispatch keeps its exact layout epoch. */
  reserveInput(
    id: string,
    input: HumanBrowserInput,
    frameSequence: number,
  ): (() => boolean) | undefined {
    const owned = this.#current(id);
    if (owned === undefined || !owned.visible) return undefined;
    const releaseKey = input.type === "keyUp" && owned.keys.has(input.keyCode);
    const releaseButton = input.type === "mouseUp" ? owned.buttons.get(input.button) : undefined;
    const heldCharacter =
      input.type === "char" &&
      (owned.keys.has(input.keyCode) ||
        (input.keyCode === "\r" && (owned.keys.has("Enter") || owned.keys.has("Return"))));
    if (input.type === "char" && input.keyCode === "\r" && !heldCharacter) return undefined;
    const currentFrame = owned.inputReady && owned.sequence > 0 && frameSequence === owned.sequence;
    if (!currentFrame && !releaseKey && releaseButton === undefined && !heldCharacter)
      return undefined;
    if (
      (input.type === "keyUp" && !releaseKey) ||
      (input.type === "mouseUp" && releaseButton === undefined)
    )
      return undefined;
    if (input.type === "keyDown" && owned.keys.size >= 32 && !owned.keys.has(input.keyCode))
      return undefined;
    // A stale release cancels capture outside the current page, never a new click.
    const delivered =
      !currentFrame && input.type === "mouseUp" && releaseButton !== undefined
        ? { ...input, x: -1, y: -1 }
        : input;
    if ("x" in delivered && (delivered.x >= owned.width || delivered.y >= owned.height))
      return undefined;
    const epoch = owned.layoutEpoch;
    let consumed = false;
    return () => {
      if (consumed) return false;
      consumed = true;
      if (this.#current(id) !== owned || !owned.visible || owned.layoutEpoch !== epoch)
        return false;
      owned.source.input(delivered);
      if (input.type === "keyDown") owned.keys.add(input.keyCode);
      if (input.type === "keyUp") owned.keys.delete(input.keyCode);
      if (input.type === "mouseDown") owned.buttons.set(input.button, { x: input.x, y: input.y });
      if (input.type === "mouseUp") owned.buttons.delete(input.button);
      return true;
    };
  }

  detach(id: string): boolean {
    if (this.#attached?.id !== id) return false;
    return this.close();
  }

  close(): boolean {
    const owned = this.#attached;
    if (owned === undefined) return true;
    this.#attached = undefined;
    owned.visible = false;
    owned.pending = undefined;
    owned.published = undefined;
    let closed = true;
    try {
      owned.remove();
    } catch {
      closed = false;
    }
    try {
      owned.source.visible(false);
    } catch {
      closed = false;
    }
    if (!closed) console.warn("Octant could not finish embedded Browser presentation cleanup.");
    return closed;
  }

  #current(id: string): Attached | undefined {
    const owned = this.#attached;
    if (owned === undefined || owned.id !== id) return undefined;
    if (!owned.current()) {
      this.close();
      return undefined;
    }
    return owned;
  }
}
