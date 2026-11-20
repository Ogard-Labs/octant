import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import {
  MAX_PAIRED_BROWSER_FRAME_BYTES,
  MAX_PAIRED_BROWSER_FRAME_HEIGHT,
  MAX_PAIRED_BROWSER_FRAME_WIDTH,
  MAX_PAIRED_BROWSER_LEASES_PER_HOST,
  decodePairedBrowserChooserId,
  type PairedBrowserChooserId,
  type PairedBrowserInput,
  type PairedBrowserLeaseId,
  type PairedBrowserNativeCommand,
  type PairedBrowserNativeFileChooser,
  type PairedBrowserNativeResult,
  type PairedBrowserNativeTarget,
} from "@octant/contracts/paired-browser-control";
import { evaluatePairedBrowserFrameTarget, isForbiddenPairedBrowserKey } from "@octant/domain";
import type { BrowserSurfaceImage } from "./browserSurfaceHost";

export interface PairedControlChooserOffer {
  readonly accept: ReadonlyArray<string>;
  readonly multiple: boolean;
  readonly resolve: (paths: ReadonlyArray<string>) => Promise<boolean>;
}

export interface PairedControlPage {
  readonly identity: object;
  readonly contextId: string;
  readonly target: PairedBrowserNativeTarget;
  /**
   * Actual native viewport dimensions used to map normalized pointer
   * coordinates back onto the live view, independent of the 1920x1200 cap
   * applied to transmitted screencast frames.
   */
  readonly inputViewport?: { readonly width: number; readonly height: number };
  readonly personInputs: number;
  readonly privateCustody: boolean;
  readonly nativePromptOpen: boolean;
  readonly capture: () => Promise<BrowserSurfaceImage>;
  readonly input: (
    events: ReadonlyArray<PairedBrowserInput>,
    width: number,
    height: number,
    canContinue: () => boolean,
  ) => void | Promise<void>;
  /** Captures private-custody epochs, throwing if custody is active or overlaps. */
  readonly observe: () => () => void;
  /** Intercepts file chooser dialogs for the duration of the lease. */
  readonly startFileChooserInterception?: (
    onChooser: (offer: PairedControlChooserOffer) => void,
  ) => () => void;
}

interface PendingChooser {
  readonly view: PairedBrowserNativeFileChooser;
  readonly resolve: (paths: ReadonlyArray<string>) => Promise<boolean>;
}

interface ActiveLease {
  readonly id: PairedBrowserLeaseId;
  readonly key: string;
  readonly contextId: string;
  readonly page: object;
  readonly tabId: string;
  readonly originPolicyVersion: string;
  stopChooserInterception: (() => void) | undefined;
  lastDocumentVersion: string;
  lastWidth: number;
  lastHeight: number;
  frameId: number;
  minValidFrameId: number;
  personInputs: number;
  operationChain: Promise<void>;
  pendingChooser: PendingChooser | undefined;
}

function waitForTurn(previous: Promise<void>, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal === undefined) return previous.then(() => true);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void previous.finally(() => {
      signal.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      resolve(!signal.aborted);
    });
  });
}

/**
 * Volatile person-only frames and touch/scroll/key/text/IME input dispatch for
 * a paired device holding a native Browser page. Local input reclaims at once.
 */
export class BrowserPairedControl {
  readonly #page: (command: PairedBrowserNativeCommand) => PairedControlPage | undefined;
  readonly #onReclaim: ((contextId: string) => void) | undefined;
  readonly #leases = new Map<string, ActiveLease>();
  readonly #reclaimedLeases = new Set<string>();
  readonly #pages = new WeakMap<object, ActiveLease>();
  readonly #epochs = new WeakMap<object, number>();
  readonly #captures = new WeakSet<object>();
  readonly #pendingInputs = new Map<string, ActiveLease>();
  readonly #inputPages = new WeakSet<object>();

  constructor(input: {
    readonly page: (command: PairedBrowserNativeCommand) => PairedControlPage | undefined;
    readonly onReclaim?: (contextId: string) => void;
  }) {
    this.#page = input.page;
    this.#onReclaim = input.onReclaim;
  }

  async execute(
    command: PairedBrowserNativeCommand,
    signal?: AbortSignal,
  ): Promise<PairedBrowserNativeResult> {
    const key = JSON.stringify([command.contextId, command.owner.windowId, command.owner.threadId]);
    if (command.operation === "release") {
      const held = this.#leases.get(command.leaseId);
      const wasReclaimed = this.#reclaimedLeases.delete(command.leaseId);
      const current = held !== undefined && held.key === key;
      if (held !== undefined && held.key === key) this.#forget(held);
      if (this.#pendingInputs.get(command.leaseId)?.key === key) {
        return { status: "refused", reason: "unavailable" };
      }
      if (command.disposition === "hand-back" && !current) {
        return {
          status: "refused",
          reason: wasReclaimed ? "reclaimed-locally" : "unavailable",
        };
      }
      return { status: "released" };
    }
    if (signal?.aborted) return { status: "refused", reason: "unavailable" };
    const page = this.#page(command);
    if (page === undefined) {
      if (command.operation !== "inspect" && this.#reclaimedLeases.has(command.leaseId)) {
        return { status: "refused", reason: "reclaimed-locally" };
      }
      return { status: "refused", reason: "unavailable" };
    }
    if (command.operation === "inspect") {
      return { status: "target", target: page.target };
    }
    if (command.operation === "claim") {
      if (
        page.target.tabId !== command.target.tabId ||
        page.target.documentVersion !== command.target.documentVersion ||
        page.target.originPolicyVersion !== command.target.originPolicyVersion ||
        this.#leases.size + this.#pendingInputs.size >= MAX_PAIRED_BROWSER_LEASES_PER_HOST ||
        this.active(page.identity) ||
        this.#inputPages.has(page.identity) ||
        this.#leases.has(command.leaseId)
      ) {
        return { status: "refused", reason: "unavailable" };
      }
      const viewport = page.inputViewport ?? page.target.viewport;
      const held: ActiveLease = {
        id: command.leaseId,
        key,
        contextId: page.contextId,
        page: page.identity,
        tabId: page.target.tabId,
        originPolicyVersion: page.target.originPolicyVersion,
        stopChooserInterception: undefined,
        lastDocumentVersion: page.target.documentVersion,
        lastWidth: viewport.width,
        lastHeight: viewport.height,
        frameId: 0,
        minValidFrameId: 1,
        personInputs: page.personInputs,
        operationChain: Promise.resolve(),
        pendingChooser: undefined,
      };
      this.#leases.set(held.id, held);
      this.#pages.set(page.identity, held);
      this.#epochs.set(page.identity, (this.#epochs.get(page.identity) ?? 0) + 1);
      held.stopChooserInterception = page.startFileChooserInterception?.((offer) => {
        if (this.#leases.get(held.id) !== held) return;
        const chooserId: PairedBrowserChooserId = decodePairedBrowserChooserId(randomUUID());
        held.pendingChooser = {
          view: {
            chooserId,
            accept: offer.accept.slice(0, 32),
            multiple: offer.multiple,
          },
          resolve: offer.resolve,
        };
      });
      return { status: "claimed" };
    }

    const held = this.#leases.get(command.leaseId);
    if (held === undefined) {
      return {
        status: "refused",
        reason: this.#reclaimedLeases.has(command.leaseId) ? "reclaimed-locally" : "unavailable",
      };
    }
    if (held.key !== key || !this.#isLeaseLiveOnPage(held, page)) {
      return { status: "refused", reason: "unavailable" };
    }

    // Serialize frame capture, input dispatch, and file chooser resolution on
    // the same lease so transient overlap (such as input arriving during a
    // streamed capture) waits its turn instead of returning unavailable.
    const previous = held.operationChain;
    let releaseTurn: () => void = () => undefined;
    const currentTurn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    held.operationChain = currentTurn;
    const acquired = await waitForTurn(previous, signal);
    if (!acquired) {
      void previous.finally(releaseTurn);
      return { status: "refused", reason: "unavailable" };
    }

    try {
      const livePage = this.#page(command);
      if (livePage === undefined || this.#leases.get(command.leaseId) !== held) {
        return {
          status: "refused",
          reason: this.#reclaimedLeases.has(command.leaseId) ? "reclaimed-locally" : "unavailable",
        };
      }
      if (held.key !== key || !this.#isLeaseLiveOnPage(held, livePage)) {
        return { status: "refused", reason: "unavailable" };
      }

      if (command.operation === "file-choice") {
        const pending = held.pendingChooser;
        if (pending === undefined || String(pending.view.chooserId) !== String(command.chooserId)) {
          return { status: "refused", reason: "unavailable" };
        }
        for (const filePath of command.paths) {
          const info = await lstat(filePath).catch(() => undefined);
          if (info?.isFile() !== true) return { status: "refused", reason: "unavailable" };
        }
        try {
          held.pendingChooser = undefined;
          const applied = await pending.resolve(command.paths);
          if (applied) {
            // Account for the remote file selection on the lease's input counter
            // so subsequent frames and inputs stay in lockstep with owned.personInputs.
            held.personInputs += 1;
            return { status: "file-chosen" };
          }
          return { status: "refused", reason: "unavailable" };
        } catch {
          return { status: "refused", reason: "unavailable" };
        }
      }

      const outsideDocument =
        livePage.target.tabId !== held.tabId ||
        livePage.target.originPolicyVersion !== held.originPolicyVersion;

      if (command.operation === "frame") {
        const fileChooser = held.pendingChooser?.view;
        if (outsideDocument) {
          held.minValidFrameId = held.frameId + 1;
          return {
            status: "withheld",
            reason: "outside-document",
            ...(fileChooser === undefined ? {} : { fileChooser }),
          };
        }
        if (livePage.nativePromptOpen) {
          return {
            status: "withheld",
            reason: "native-prompt",
            ...(fileChooser === undefined ? {} : { fileChooser }),
          };
        }
        let checkCustody: () => void;
        try {
          if (livePage.privateCustody) {
            return {
              status: "withheld",
              reason: "private-custody",
              ...(fileChooser === undefined ? {} : { fileChooser }),
            };
          }
          checkCustody = livePage.observe();
        } catch {
          return {
            status: "withheld",
            reason: "private-custody",
            ...(fileChooser === undefined ? {} : { fileChooser }),
          };
        }
        if (this.#captures.has(livePage.identity)) {
          return { status: "refused", reason: "unavailable" };
        }
        this.#captures.add(livePage.identity);
        try {
          let image = await livePage.capture();
          const latestPage = this.#page(command);
          if (
            signal?.aborted ||
            latestPage === undefined ||
            !this.#isLeaseLiveOnPage(held, latestPage)
          ) {
            return {
              status: "refused",
              reason: this.#reclaimedLeases.has(held.id) ? "reclaimed-locally" : "unavailable",
            };
          }
          if (
            latestPage.target.tabId !== held.tabId ||
            latestPage.target.originPolicyVersion !== held.originPolicyVersion
          ) {
            held.minValidFrameId = held.frameId + 1;
            return { status: "withheld", reason: "outside-document" };
          }
          if (latestPage.nativePromptOpen) return { status: "withheld", reason: "native-prompt" };
          try {
            if (latestPage.privateCustody) {
              return { status: "withheld", reason: "private-custody" };
            }
            checkCustody();
          } catch {
            return { status: "withheld", reason: "private-custody" };
          }
          if (image.isEmpty()) return { status: "refused", reason: "unavailable" };
          let size = image.getSize?.();
          if (size === undefined || size.width < 1 || size.height < 1) {
            return { status: "refused", reason: "unavailable" };
          }
          const scale = Math.min(
            1,
            MAX_PAIRED_BROWSER_FRAME_WIDTH / size.width,
            MAX_PAIRED_BROWSER_FRAME_HEIGHT / size.height,
          );
          if (scale < 1) {
            if (image.resize === undefined) return { status: "refused", reason: "unavailable" };
            image = image.resize({ width: Math.max(1, Math.floor(size.width * scale)) });
            size = image.getSize?.();
          }
          if (
            size === undefined ||
            size.width > MAX_PAIRED_BROWSER_FRAME_WIDTH ||
            size.height > MAX_PAIRED_BROWSER_FRAME_HEIGHT
          ) {
            return { status: "refused", reason: "unavailable" };
          }
          const bytes = image.toJPEG(70);
          if (bytes.byteLength > MAX_PAIRED_BROWSER_FRAME_BYTES) {
            return { status: "refused", reason: "unavailable" };
          }
          try {
            checkCustody();
          } catch {
            return { status: "withheld", reason: "private-custody" };
          }
          if (signal?.aborted || !this.#isLeaseLiveOnPage(held, this.#page(command))) {
            return {
              status: "refused",
              reason: this.#reclaimedLeases.has(held.id) ? "reclaimed-locally" : "unavailable",
            };
          }
          const latestViewport = latestPage.inputViewport ?? latestPage.target.viewport;
          const nextFrameId = held.frameId + 1;
          if (
            latestPage.target.documentVersion !== held.lastDocumentVersion ||
            latestViewport.width !== held.lastWidth ||
            latestViewport.height !== held.lastHeight
          ) {
            held.lastDocumentVersion = latestPage.target.documentVersion;
            held.lastWidth = latestViewport.width;
            held.lastHeight = latestViewport.height;
            held.minValidFrameId = nextFrameId;
          }
          held.frameId = nextFrameId;
          const latestChooser = held.pendingChooser?.view;
          return {
            status: "frame",
            frame: {
              frameId: nextFrameId,
              documentVersion: latestPage.target.documentVersion,
              viewport: { width: size.width, height: size.height },
              devicePixelRatio: latestPage.target.devicePixelRatio,
              jpegBase64: Buffer.from(bytes).toString("base64"),
            },
            ...(latestChooser === undefined ? {} : { fileChooser: latestChooser }),
          };
        } catch {
          return { status: "refused", reason: "unavailable" };
        } finally {
          this.#captures.delete(livePage.identity);
        }
      }

      // Input operation
      if (outsideDocument) {
        held.minValidFrameId = held.frameId + 1;
        return { status: "refused", reason: "outside-document" };
      }
      if (livePage.privateCustody || livePage.nativePromptOpen) {
        return { status: "refused", reason: "unavailable" };
      }
      const inputViewport = livePage.inputViewport ?? livePage.target.viewport;
      if (
        livePage.target.documentVersion !== held.lastDocumentVersion ||
        inputViewport.width !== held.lastWidth ||
        inputViewport.height !== held.lastHeight
      ) {
        held.lastDocumentVersion = livePage.target.documentVersion;
        held.lastWidth = inputViewport.width;
        held.lastHeight = inputViewport.height;
        held.minValidFrameId = held.frameId + 1;
      }
      const frameCheck = evaluatePairedBrowserFrameTarget({
        events: command.events,
        minValidFrameId: held.minValidFrameId,
        latestFrameId: held.frameId,
      });
      if (frameCheck.status === "refused") {
        return { status: "refused", reason: "stale-frame" };
      }
      for (const event of command.events) {
        if (event.kind === "key" && isForbiddenPairedBrowserKey(event)) {
          return { status: "refused", reason: "unavailable" };
        }
      }

      try {
        const checkCustody = livePage.observe();
        if (!this.#isLeaseLiveOnPage(held, this.#page(command)) || signal?.aborted) {
          return { status: "refused", reason: "unavailable" };
        }
        checkCustody();
        // Keep the lease's person-input counter in lockstep with remote input
        // dispatch so remote input does not self-reclaim, while genuine local
        // input increments page.personInputs independently and triggers reclaim.
        held.personInputs += 1;
        this.#pendingInputs.set(held.id, held);
        this.#inputPages.add(livePage.identity);
        const batchDocumentVersion = livePage.target.documentVersion;
        let batchStale = false;
        try {
          await livePage.input(command.events, inputViewport.width, inputViewport.height, () => {
            checkCustody();
            const live = this.#page(command);
            if (
              signal?.aborted ||
              live === undefined ||
              !this.#isLeaseLiveOnPage(held, live) ||
              live.privateCustody ||
              live.nativePromptOpen
            ) {
              return false;
            }
            if (
              live.target.tabId !== held.tabId ||
              live.target.originPolicyVersion !== held.originPolicyVersion
            ) {
              held.minValidFrameId = held.frameId + 1;
              batchStale = true;
              return false;
            }
            const liveViewport = live.inputViewport ?? live.target.viewport;
            if (
              live.target.documentVersion !== batchDocumentVersion ||
              liveViewport.width !== inputViewport.width ||
              liveViewport.height !== inputViewport.height
            ) {
              held.lastDocumentVersion = live.target.documentVersion;
              held.lastWidth = liveViewport.width;
              held.lastHeight = liveViewport.height;
              held.minValidFrameId = held.frameId + 1;
              batchStale = true;
              return false;
            }
            return true;
          });
        } catch {
          return { status: "input", effect: "possible" };
        } finally {
          this.#pendingInputs.delete(held.id);
          this.#inputPages.delete(livePage.identity);
        }
        return { status: "input", effect: batchStale ? "possible" : "completed" };
      } catch {
        return { status: "refused", reason: "unavailable" };
      }
    } finally {
      releaseTurn();
    }
  }

  #isLeaseLiveOnPage(held: ActiveLease, page: PairedControlPage | undefined): boolean {
    return (
      this.#leases.get(held.id) === held &&
      page !== undefined &&
      page.identity === held.page &&
      page.personInputs === held.personInputs
    );
  }

  active(identity: object): boolean {
    return this.#pages.get(identity) !== undefined;
  }

  holdsPage(identity: object): boolean {
    return this.active(identity) || this.#inputPages.has(identity);
  }

  observation(identity: object): () => void {
    const epoch = this.#epochs.get(identity) ?? 0;
    const check = () => {
      if (
        this.active(identity) ||
        this.#inputPages.has(identity) ||
        (this.#epochs.get(identity) ?? 0) !== epoch
      ) {
        throw new Error("Paired Browser hold pauses agent observations.");
      }
    };
    check();
    return check;
  }

  reclaim(identity: object): void {
    const held = this.#pages.get(identity);
    if (held === undefined) return;
    this.#reclaimedLeases.add(held.id);
    if (this.#reclaimedLeases.size > 64) {
      const oldest = this.#reclaimedLeases.values().next().value;
      if (oldest !== undefined) this.#reclaimedLeases.delete(oldest);
    }
    this.#forget(held);
    this.#onReclaim?.(held.contextId);
  }

  #forget(held: ActiveLease): void {
    try {
      held.stopChooserInterception?.();
    } catch {
      /* Ignore debugger cleanup errors on a destroyed view. */
    }
    held.pendingChooser = undefined;
    if (this.#leases.get(held.id) === held) this.#leases.delete(held.id);
    if (this.#pages.get(held.page) === held) this.#pages.delete(held.page);
  }

  close(): void {
    for (const held of [...this.#leases.values()]) this.#forget(held);
    this.#reclaimedLeases.clear();
  }
}
