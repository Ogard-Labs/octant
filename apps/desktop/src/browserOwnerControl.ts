import { Buffer } from "node:buffer";
import {
  MAX_OWNER_BROWSER_CONTROL_MS,
  MAX_OWNER_BROWSER_FRAME_BYTES,
  MAX_OWNER_BROWSER_FRAME_HEIGHT,
  MAX_OWNER_BROWSER_FRAME_WIDTH,
  type OwnerBrowserControlId,
  type OwnerBrowserInput,
  type OwnerBrowserNativeCommand,
  type OwnerBrowserNativeResult,
  type OwnerBrowserNativeTarget,
} from "@octant/contracts/owner-browser";
import type { BrowserSurfaceImage } from "./browserSurfaceHost";

export interface OwnerControlPage {
  readonly identity: object;
  readonly target: OwnerBrowserNativeTarget;
  readonly personInputs: number;
  readonly width: number;
  readonly height: number;
  readonly capture: () => Promise<BrowserSurfaceImage>;
  readonly input: (
    input: OwnerBrowserInput,
    width: number,
    height: number,
    current: () => boolean,
  ) => void | Promise<void>;
  /** Captures the independent private-custody epochs, including acquire then release. */
  readonly observe: () => () => void;
}

interface Controller {
  readonly id: OwnerBrowserControlId;
  readonly key: string;
  readonly page: object;
  readonly target: OwnerBrowserNativeTarget;
  readonly deadline: number;
  readonly timer: ReturnType<typeof setTimeout>;
  next: number;
  frame: number;
  personInputs: number;
  busy: boolean;
}

/** Volatile person-only frames and fixed input. It owns neither profiles nor the agent person hold. */
export class BrowserOwnerControl {
  readonly #page: (command: OwnerBrowserNativeCommand) => OwnerControlPage | undefined;
  readonly #now: () => number;
  readonly #controllers = new Map<string, Controller>();
  readonly #pages = new WeakMap<object, Controller>();
  readonly #epochs = new WeakMap<object, number>();
  readonly #captures = new WeakSet<object>();
  readonly #pendingInputs = new Map<string, Controller>();
  readonly #inputPages = new WeakSet<object>();

  constructor(input: {
    readonly page: (command: OwnerBrowserNativeCommand) => OwnerControlPage | undefined;
    readonly now?: () => number;
  }) {
    this.#page = input.page;
    this.#now = input.now ?? Date.now;
  }

  async execute(
    command: OwnerBrowserNativeCommand,
    signal?: AbortSignal,
  ): Promise<OwnerBrowserNativeResult> {
    const key = JSON.stringify([command.contextId, command.owner.windowId, command.owner.threadId]);
    if (command.operation === "release") {
      const held = this.#controllers.get(command.controlId);
      const current = held !== undefined && held.key === key && this.#now() < held.deadline;
      if (held !== undefined && held.key === key) this.#forget(held);
      if (this.#pendingInputs.get(command.controlId)?.key === key) return { status: "refused" };
      // Local person input reclaims the controller here without the server knowing,
      // so a later remote hand-back would otherwise resume the agent while the person
      // is using the page. Revocation stays idempotent cleanup.
      if (command.disposition === "hand-back" && !current) return { status: "refused" };
      return { status: "released" };
    }
    if (signal?.aborted) return { status: "refused" };
    const page = this.#page(command);
    if (page === undefined) return { status: "refused" };
    try {
      page.observe();
    } catch {
      return { status: "refused" };
    }
    if (command.operation === "inspect") return { status: "target", target: page.target };
    if (command.operation === "claim") {
      const deadline = Date.parse(command.expiresAt);
      if (
        !sameTarget(page.target, command.target) ||
        !Number.isFinite(deadline) ||
        deadline <= this.#now() ||
        deadline > this.#now() + MAX_OWNER_BROWSER_CONTROL_MS ||
        this.#controllers.size + this.#pendingInputs.size >= 16 ||
        this.active(page.identity) ||
        this.#inputPages.has(page.identity) ||
        this.#controllers.has(command.controlId)
      )
        return { status: "refused" };
      const timer = setTimeout(() => {
        const held = this.#controllers.get(command.controlId);
        if (held !== undefined) this.#forget(held);
      }, deadline - this.#now());
      timer.unref?.();
      const held: Controller = {
        id: command.controlId,
        key,
        page: page.identity,
        target: page.target,
        deadline,
        timer,
        next: 1,
        frame: 0,
        personInputs: page.personInputs,
        busy: false,
      };
      this.#controllers.set(held.id, held);
      this.#pages.set(page.identity, held);
      this.#epochs.set(page.identity, (this.#epochs.get(page.identity) ?? 0) + 1);
      return { status: "claimed" };
    }
    const held = this.#controllers.get(command.controlId);
    if (
      held === undefined ||
      held.key !== key ||
      held.busy ||
      held.next !== command.sequence ||
      !this.#current(held, page) ||
      (command.operation === "input" && (held.frame === 0 || held.frame !== command.expectedFrame))
    )
      return { status: "refused" };
    held.busy = true;
    held.next += 1;
    try {
      const observation = page.observe();
      if (command.operation === "input") {
        if (!this.#current(held, this.#page(command)) || signal?.aborted)
          return { status: "refused" };
        observation();
        // The fixed native port records person input before forwarding it to Chromium.
        held.personInputs += 1;
        held.frame = 0;
        this.#pendingInputs.set(held.id, held);
        this.#inputPages.add(page.identity);
        try {
          await page.input(command.input, page.width, page.height, () => {
            observation();
            return !signal?.aborted && this.#current(held, this.#page(command));
          });
        } catch {
          return { status: "input", effect: "possible" };
        } finally {
          this.#pendingInputs.delete(held.id);
          this.#inputPages.delete(page.identity);
        }
        return { status: "input", effect: "completed" };
      }
      if (this.#captures.has(page.identity)) return { status: "refused" };
      this.#captures.add(page.identity);
      let image;
      try {
        image = await page.capture();
      } finally {
        this.#captures.delete(page.identity);
      }
      observation();
      if (signal?.aborted || !this.#current(held, this.#page(command)) || image.isEmpty())
        return { status: "refused" };
      let size = image.getSize?.();
      if (size === undefined || size.width < 1 || size.height < 1) return { status: "refused" };
      const scale = Math.min(
        1,
        MAX_OWNER_BROWSER_FRAME_WIDTH / size.width,
        MAX_OWNER_BROWSER_FRAME_HEIGHT / size.height,
      );
      if (scale < 1) {
        if (image.resize === undefined) return { status: "refused" };
        image = image.resize({ width: Math.max(1, Math.floor(size.width * scale)) });
        size = image.getSize?.();
      }
      if (
        size === undefined ||
        size.width > MAX_OWNER_BROWSER_FRAME_WIDTH ||
        size.height > MAX_OWNER_BROWSER_FRAME_HEIGHT
      )
        return { status: "refused" };
      const bytes = image.toJPEG(70);
      if (bytes.byteLength > MAX_OWNER_BROWSER_FRAME_BYTES) return { status: "refused" };
      observation();
      if (signal?.aborted || !this.#current(held, this.#page(command)))
        return { status: "refused" };
      held.frame = command.sequence;
      return {
        status: "frame",
        frame: {
          sequence: command.sequence,
          documentRevision: held.target.documentRevision,
          width: size.width,
          height: size.height,
          dataUrl: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`,
        },
      };
    } catch {
      return { status: "refused" };
    } finally {
      held.busy = false;
    }
  }

  #current(held: Controller, page: OwnerControlPage | undefined): boolean {
    return (
      this.#controllers.get(held.id) === held &&
      this.#now() < held.deadline &&
      page !== undefined &&
      page.identity === held.page &&
      page.personInputs === held.personInputs &&
      sameTarget(page.target, held.target)
    );
  }
  active(identity: object): boolean {
    const held = this.#pages.get(identity);
    if (held === undefined) return false;
    if (this.#now() >= held.deadline) {
      this.#forget(held);
      return false;
    }
    return true;
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
      )
        throw new Error("Owner Browser control holds agent observations.");
    };
    check();
    return check;
  }
  reclaim(identity: object): void {
    const held = this.#pages.get(identity);
    if (held !== undefined) this.#forget(held);
  }
  #forget(held: Controller): void {
    clearTimeout(held.timer);
    if (this.#controllers.get(held.id) === held) this.#controllers.delete(held.id);
    if (this.#pages.get(held.page) === held) this.#pages.delete(held.page);
  }
  close(): void {
    for (const held of this.#controllers.values()) this.#forget(held);
  }
}

function sameTarget(a: OwnerBrowserNativeTarget, b: OwnerBrowserNativeTarget): boolean {
  return (
    a.targetVersion === b.targetVersion &&
    a.documentRevision === b.documentRevision &&
    a.origin === b.origin
  );
}
