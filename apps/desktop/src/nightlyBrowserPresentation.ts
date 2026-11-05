import {
  decodeHumanBrowserRequest,
  type HumanBrowserRequest,
  type HumanBrowserResult,
  type HumanBrowserLayout,
} from "@octant/contracts/browser-presentation";

interface Presentation {
  readonly contextId: HumanBrowserRequest["contextId"];
  readonly threadId: HumanBrowserRequest["threadId"];
  readonly presentationId: Extract<HumanBrowserResult, { status: "attached" }>["presentationId"];
  layout: HumanBrowserLayout;
}
interface NightlyBrowserPresentationOptions {
  readonly current: () => boolean;
  readonly visible: () => boolean;
  readonly focused: () => boolean;
  readonly execute: (
    request: HumanBrowserRequest,
    signal: AbortSignal,
  ) => Promise<HumanBrowserResult>;
}
interface Pending {
  request: HumanBrowserRequest;
  readonly internal: boolean;
  readonly promise: Promise<HumanBrowserResult>;
  readonly resolve: (result: HumanBrowserResult) => void;
}
const refused = (): HumanBrowserResult => ({ status: "refused" });
const MAX_QUEUED_REQUESTS = 4;
const MAX_QUEUED_DISCRETE_INPUTS = 64;

/** Only an actual owned window can submit human display and input requests. */
export class NightlyBrowserPresentation {
  readonly #options: NightlyBrowserPresentationOptions;
  readonly #presentations = new Map<string, Presentation>();
  readonly #lifetime = new AbortController();
  readonly #queue: Pending[] = [];
  readonly #held = new Map<string, Extract<HumanBrowserRequest, { kind: "input" }>>();
  #active: Pending | undefined;
  #running: Promise<void> | undefined;
  #hide: Promise<void> | undefined;
  #hidden = false;
  #visibilityEpoch = 0;

  constructor(options: NightlyBrowserPresentationOptions) {
    this.#options = options;
  }

  invoke(raw: unknown): Promise<HumanBrowserResult> {
    try {
      return this.#enqueue(decodeHumanBrowserRequest(raw), false);
    } catch {
      return Promise.resolve(refused());
    }
  }

  surfaceCommand(raw: unknown, kind: "command" | "tab"): Promise<HumanBrowserResult> {
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("contextId" in raw) ||
      !("threadId" in raw) ||
      !("command" in raw) ||
      typeof raw.contextId !== "string" ||
      typeof raw.threadId !== "string" ||
      Object.keys(raw).some((key) => !["contextId", "threadId", "command"].includes(key))
    )
      return Promise.resolve(refused());
    const owned = this.#presentations.get(raw.contextId);
    if (owned === undefined || String(owned.threadId) !== raw.threadId)
      return Promise.resolve(refused());
    return this.invoke({
      contextId: owned.contextId,
      threadId: owned.threadId,
      presentationId: owned.presentationId,
      kind,
      command: raw.command,
    });
  }

  #enqueue(request: HumanBrowserRequest, internal: boolean): Promise<HumanBrowserResult> {
    if (this.#lifetime.signal.aborted) return Promise.resolve(refused());
    const replaceable = replaceableKey(request);
    const existing =
      replaceable === undefined
        ? undefined
        : this.#queue.find((pending) => replaceableKey(pending.request) === replaceable);
    if (existing !== undefined) {
      existing.request = request;
      return existing.promise;
    }
    const release = releaseKey(request);
    if (release !== undefined) {
      const held =
        this.#held.has(release) ||
        downKey(this.#active?.request) === release ||
        this.#queue.some((pending) => downKey(pending.request) === release);
      if (!held) return Promise.resolve(refused());
      const queued = this.#queue.find((pending) => releaseKey(pending.request) === release);
      if (queued !== undefined) return queued.promise;
    }
    // A person's discrete key, character, button and wheel events are not
    // expendable like frames and pointer motion: dropping one while a frame
    // request is slow leaves the page with incomplete text. They queue under
    // their own larger bound so a burst of typing is delivered in order, while
    // other requests keep the small bound.
    const discrete = discreteInput(request);
    if (
      !internal &&
      release === undefined &&
      this.#queue.filter(
        (pending) =>
          !pending.internal &&
          releaseKey(pending.request) === undefined &&
          discreteInput(pending.request) === discrete,
      ).length >= (discrete ? MAX_QUEUED_DISCRETE_INPUTS : MAX_QUEUED_REQUESTS)
    )
      return Promise.resolve(refused());
    let resolve: Pending["resolve"] = () => {};
    const promise = new Promise<HumanBrowserResult>((done) => {
      resolve = done;
    });
    const pending: Pending = { request, internal, promise, resolve };
    if (internal) this.#queue.unshift(pending);
    else if (release !== undefined) {
      // Preserve down/character/up order while bypassing replaceable motion.
      let after = 0;
      for (let index = 0; index < this.#queue.length; index += 1) {
        const queued = this.#queue[index];
        if (queued?.request.kind === "input" && queued.request.input.type !== "mouseMove")
          after = index + 1;
      }
      this.#queue.splice(after, 0, pending);
    } else this.#queue.push(pending);
    this.#running ??= this.#drain();
    return promise;
  }

  async #drain(): Promise<void> {
    // Defer once so assigning #running precedes a synchronously empty queue.
    await Promise.resolve();
    while (this.#queue.length > 0) {
      const pending = this.#queue.shift();
      if (pending === undefined) break;
      this.#active = pending;
      pending.resolve(await this.#dispatch(pending.request, pending.internal).catch(refused));
      this.#active = undefined;
    }
    this.#running = undefined;
  }

  async #dispatch(request: HumanBrowserRequest, internal: boolean): Promise<HumanBrowserResult> {
    if (!this.#options.current() || this.#lifetime.signal.aborted) return refused();
    const owned = this.#presentations.get(String(request.contextId));
    if (
      request.kind !== "attach" &&
      (owned?.presentationId !== request.presentationId ||
        String(owned.threadId) !== String(request.threadId))
    )
      return refused();
    const hiding = request.kind === "layout" && !request.layout.visible;
    if (!hiding && request.kind !== "detach" && (this.#hidden || !this.#options.visible()))
      return refused();
    if (
      request.kind === "input" &&
      !this.#options.focused() &&
      !(internal && releaseKey(request) !== undefined)
    )
      return refused();
    if (request.kind === "attach" && this.#presentations.size >= 16 && owned === undefined)
      return refused();
    if (downKey(request) !== undefined && this.#held.size >= 32) return refused();
    const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(2_000)]);
    const result = await new Promise<HumanBrowserResult>((resolve) => {
      const aborted = () => resolve(refused());
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) {
        signal.removeEventListener("abort", aborted);
        resolve(refused());
        return;
      }
      void this.#options
        .execute(request, signal)
        .then(resolve, () => resolve(refused()))
        .finally(() => signal.removeEventListener("abort", aborted));
    });
    if (!this.#options.current() || this.#lifetime.signal.aborted || signal.aborted)
      return refused();
    if ((result.status === "attached" && request.kind === "attach") || request.kind === "detach") {
      for (const [key, held] of this.#held)
        if (String(held.contextId) === String(request.contextId)) this.#held.delete(key);
    }
    if (result.status === "attached" && request.kind === "attach")
      this.#presentations.set(String(request.contextId), {
        contextId: request.contextId,
        threadId: request.threadId,
        presentationId: result.presentationId,
        layout: { width: 800, height: 600, visible: false },
      });
    if (request.kind === "layout" && owned !== undefined && result.status === "accepted")
      owned.layout = request.layout;
    if (request.kind === "detach") this.#presentations.delete(String(request.contextId));
    if (request.kind === "input" && result.status === "accepted") {
      const down = downKey(request);
      const up = releaseKey(request);
      if (down !== undefined) this.#held.set(down, request);
      if (up !== undefined) this.#held.delete(up);
    }
    if (
      (request.kind === "frame" || request.kind === "input") &&
      (this.#hidden ||
        !this.#options.visible() ||
        (request.kind === "input" &&
          !this.#options.focused() &&
          !(internal && releaseKey(request) !== undefined)))
    )
      return refused();
    return result;
  }

  async releaseInputs(): Promise<void> {
    for (const request of [...this.#held.values()]) {
      if (request.input.type !== "keyDown" && request.input.type !== "mouseDown") continue;
      const event = request.input;
      let result: HumanBrowserResult;
      if (event.type === "keyDown")
        result = await this.#enqueue({ ...request, input: { ...event, type: "keyUp" } }, true);
      else if (event.type === "mouseDown")
        result = await this.#enqueue({ ...request, input: { ...event, type: "mouseUp" } }, true);
      else continue;
      if (result.status !== "accepted")
        console.warn("Octant could not confirm Browser input release.");
    }
  }

  show(): void {
    this.#visibilityEpoch += 1;
    this.#hidden = false;
  }

  hide(): Promise<void> {
    if (this.#hidden && this.#hide !== undefined) return this.#hide;
    this.#hidden = true;
    const epoch = ++this.#visibilityEpoch;
    if (this.#hide !== undefined) return this.#hide.then(() => this.hide());
    this.#hide = (async () => {
      for (const owned of this.#presentations.values()) {
        if (epoch !== this.#visibilityEpoch || this.#lifetime.signal.aborted) break;
        const result = await this.#enqueue(
          {
            contextId: owned.contextId,
            threadId: owned.threadId,
            presentationId: owned.presentationId,
            kind: "layout",
            layout: { ...owned.layout, visible: false },
          },
          true,
        );
        if (result.status !== "accepted")
          console.warn("Octant could not confirm hidden Browser presentation cleanup.");
      }
      if (epoch === this.#visibilityEpoch && this.#hidden) this.#held.clear();
    })().finally(() => {
      this.#hide = undefined;
    });
    return this.#hide;
  }

  async close(): Promise<void> {
    this.#lifetime.abort();
    this.#presentations.clear();
    this.#held.clear();
    await this.#running;
    await this.#hide;
  }
}

function replaceableKey(request: HumanBrowserRequest): string | undefined {
  if (request.kind === "frame" || (request.kind === "input" && request.input.type === "mouseMove"))
    return `${request.kind}:${request.contextId}:${request.presentationId}`;
  return undefined;
}
function discreteInput(request: HumanBrowserRequest): boolean {
  return (
    request.kind === "input" &&
    request.input.type !== "mouseMove" &&
    releaseKey(request) === undefined
  );
}
function downKey(request: HumanBrowserRequest | undefined): string | undefined {
  if (request?.kind !== "input") return undefined;
  if (request.input.type === "keyDown") return `${request.contextId}:key:${request.input.keyCode}`;
  if (request.input.type === "mouseDown")
    return `${request.contextId}:button:${request.input.button}`;
  return undefined;
}
function releaseKey(request: HumanBrowserRequest): string | undefined {
  if (request.kind !== "input") return undefined;
  if (request.input.type === "keyUp") return `${request.contextId}:key:${request.input.keyCode}`;
  if (request.input.type === "mouseUp")
    return `${request.contextId}:button:${request.input.button}`;
  return undefined;
}
