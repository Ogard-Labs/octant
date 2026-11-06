import { randomUUID } from "node:crypto";
import {
  decodeBrowserPageScriptPlanId,
  type BrowserPageScriptPlanId,
  type BrowserPageScriptPreparation,
} from "@octant/contracts/browser-page-script";
import type { BrowserPageScriptReceipt } from "@octant/contracts/browser-page-script";

/** This realm has page DOM authority, but receives no host functions or values. */
export const pageScriptKernel = String.raw`(() => {
  const stringify = JSON.stringify, keys = Object.keys;
  const descriptor = Object.getOwnPropertyDescriptor, prototype = Object.getPrototypeOf;
  const create = Object.create, define = Object.defineProperty;
  const finite = Number.isFinite, min = Math.min, Weak = WeakSet;
  const objectPrototype = Object.prototype, arrayPrototype = Array.prototype;
  const array = Array.isArray, evaluate = (0, eval);
  const slice = Function.call.bind(String.prototype.slice);
  const has = Function.call.bind(Object.prototype.hasOwnProperty);
  const seenHas = Function.call.bind(WeakSet.prototype.has);
  const seenAdd = Function.call.bind(WeakSet.prototype.add);
  const encode = Function.call.bind(TextEncoder.prototype.encode, new TextEncoder());
  const execute = source => {
    const seen = new Weak();
    let remaining = 6000, nodes = 0, truncated = false, unsupported = false;
    function visit(value, depth) {
      if (++nodes > 128 || depth > 5) { truncated = true; return '[limit]'; }
      if (value === null || typeof value === 'boolean') return value;
      if (typeof value === 'number') return finite(value) ? value : '[nonfinite]';
      if (typeof value === 'string') {
        const text = slice(value, 0, min(remaining, 2048));
        remaining -= text.length;
        if (text.length !== value.length) truncated = true;
        return text;
      }
      if (typeof value !== 'object') { unsupported = true; return '[unsupported]'; }
      const proto = prototype(value);
      if (proto !== objectPrototype && proto !== arrayPrototype && proto !== null) {
        unsupported = true; return '[unsupported-object]';
      }
      if (seenHas(seen, value)) return '[cycle]';
      seenAdd(seen, value);
      const names = keys(value), output = create(null);
      for (let i = 0; i < names.length && i < 64 && remaining > 0; i++) {
        const key = names[i], shortKey = slice(key, 0, min(remaining, 128));
        remaining -= shortKey.length;
        if (shortKey.length !== key.length) truncated = true;
        if (has(output, shortKey)) { truncated = true; continue; }
        const field = descriptor(value, key);
        if (field === undefined) continue;
        if (has(field, 'value')) output[shortKey] = visit(field.value, depth + 1);
        else { unsupported = true; output[shortKey] = '[accessor]'; }
      }
      if (names.length > 64 || remaining <= 0) truncated = true;
      const node = create(null);
      node.type = array(value) ? 'array' : 'object'; node.entries = output;
      return node;
    }
    let value;
    try { value = evaluate(source); }
    catch { return '{"status":"script-failed"}'; }
    try {
      const envelope = create(null);
      envelope.value = visit(value, 0);
      envelope.status = unsupported ? 'unsupported-result' : truncated ? 'truncated' : 'completed';
      const result = stringify(envelope);
      return encode(result).length <= 24576 ? result : '{"status":"truncated"}';
    } catch { return '{"status":"unsupported-result"}'; }
  };
  define(this, '__octantBoundedScript', {value: execute, writable: false, configurable: false});
  return true;
})()`;

export type NativePageScriptReceipt = BrowserPageScriptReceipt;

export interface PageScriptTarget {
  /** New identity for every document. No native context is reused across navigation. */
  readonly document: object;
  readonly uniqueContextId: string;
  readonly current: () => boolean;
  readonly send: (
    method: string,
    parameters: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>;
  /** The native owner refuses overlapping custody and returns its own independent release. */
  readonly reserve: () => (() => void) | undefined;
}

/** Owns one synchronous attempt; the document owner owns its realm and custody lifetime. */
export class BrowserPageScript {
  readonly #prepared = new Map<
    BrowserPageScriptPlanId,
    {
      readonly target: PageScriptTarget;
      readonly source: string;
      readonly ownerKey: string;
      readonly expires: number;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly #running = new Map<
    BrowserPageScriptPlanId,
    {
      readonly target: PageScriptTarget;
      readonly ownerKey: string;
      readonly abort: AbortController;
      dispatched: boolean;
    }
  >();
  readonly #initialized = new WeakMap<object, Promise<boolean>>();
  readonly #active = new WeakSet<object>();
  readonly #holds = new WeakMap<object, () => void>();
  readonly #destroyed = new WeakSet<object>();

  /** Called only after the native owner confirms this document no longer exists. */
  documentDestroyed(document: object): void {
    this.#destroyed.add(document);
    this.#initialized.delete(document);
    for (const [id, plan] of this.#prepared)
      if (plan.target.document === document) {
        clearTimeout(plan.timer);
        this.#prepared.delete(id);
      }
    for (const [id, run] of this.#running)
      if (run.target.document === document) {
        run.abort.abort();
        this.#running.delete(id);
      }
    this.#release(document);
  }

  #release(document: object): void {
    const release = this.#holds.get(document);
    this.#holds.delete(document);
    this.#active.delete(document);
    release?.();
  }

  #initialize(target: PageScriptTarget): Promise<boolean> {
    let initialized = this.#initialized.get(target.document);
    if (initialized === undefined) {
      initialized = target
        .send("Runtime.evaluate", parameters(target, pageScriptKernel))
        .then((answer) => record(answer) && record(answer.result) && answer.result.value === true);
      this.#initialized.set(target.document, initialized);
    }
    return initialized;
  }

  async prepare(
    target: PageScriptTarget,
    source: string,
    ownerKey: string,
    signal: AbortSignal,
  ): Promise<BrowserPageScriptPreparation> {
    if (
      signal.aborted ||
      !target.current() ||
      this.#destroyed.has(target.document) ||
      this.#active.has(target.document) ||
      this.#prepared.size + this.#running.size >= 32 ||
      Buffer.byteLength(source, "utf8") > 8192
    )
      return { status: "refused", effect: "none" };
    try {
      if (
        !(await this.#initialize(target)) ||
        signal.aborted ||
        !target.current() ||
        this.#destroyed.has(target.document) ||
        this.#prepared.size + this.#running.size >= 32
      )
        return { status: "refused", effect: "none" };
      const planId = decodeBrowserPageScriptPlanId(randomUUID());
      const timer = setTimeout(() => this.#prepared.delete(planId), 2000);
      timer.unref();
      this.#prepared.set(planId, {
        target,
        source,
        ownerKey,
        timer,
        expires: performance.now() + 2000,
      });
      return { status: "prepared", planId };
    } catch {
      return { status: "refused", effect: "none" };
    }
  }

  async execute(
    planId: BrowserPageScriptPlanId,
    target: PageScriptTarget,
    ownerKey: string,
    signal: AbortSignal,
  ): Promise<NativePageScriptReceipt> {
    const plan = this.#prepared.get(planId);
    if (plan !== undefined && performance.now() >= plan.expires) {
      clearTimeout(plan.timer);
      this.#prepared.delete(planId);
      return { status: "refused", effect: "none" };
    }
    if (
      plan === undefined ||
      plan.ownerKey !== ownerKey ||
      plan.target.document !== target.document ||
      !plan.target.current()
    )
      return { status: "refused", effect: "none" };
    clearTimeout(plan.timer);
    this.#prepared.delete(planId);
    const run = { target, ownerKey, abort: new AbortController(), dispatched: false };
    this.#running.set(planId, run);
    try {
      return await this.run(
        target,
        plan.source,
        AbortSignal.any([signal, run.abort.signal]),
        () => {
          run.dispatched = true;
        },
      );
    } finally {
      this.#running.delete(planId);
    }
  }

  cancel(planId: BrowserPageScriptPlanId, ownerKey: string): NativePageScriptReceipt {
    const plan = this.#prepared.get(planId);
    if (plan?.ownerKey === ownerKey) {
      clearTimeout(plan.timer);
      this.#prepared.delete(planId);
      return { status: "cancelled", effect: "none" };
    }
    const run = this.#running.get(planId);
    if (run?.ownerKey === ownerKey) {
      run.abort.abort();
      return { status: "cancelled", effect: run.dispatched ? "possible" : "none" };
    }
    return { status: "refused", effect: "none" };
  }

  async run(
    target: PageScriptTarget,
    source: string,
    signal: AbortSignal,
    onDispatch?: () => void,
  ): Promise<NativePageScriptReceipt> {
    if (signal.aborted) return { status: "cancelled", effect: "none" };
    if (
      !target.current() ||
      this.#destroyed.has(target.document) ||
      Buffer.byteLength(source, "utf8") > 8192 ||
      this.#active.has(target.document)
    )
      return { status: "refused", effect: "none" };
    const release = target.reserve();
    if (release === undefined) return { status: "refused", effect: "none" };
    this.#active.add(target.document);
    this.#holds.set(target.document, release);
    let dispatched = false;
    let expired = false;
    let quarantined = false;
    const execute = async (): Promise<NativePageScriptReceipt> => {
      try {
        if (!(await this.#initialize(target))) return { status: "refused", effect: "none" };
        if (signal.aborted || expired || this.#destroyed.has(target.document))
          return { status: "cancelled", effect: "none" };
        if (!target.current()) return { status: "refused", effect: "none" };
        dispatched = true;
        onDispatch?.();
        const answer = await target.send(
          "Runtime.evaluate",
          parameters(target, `this.__octantBoundedScript(${JSON.stringify(source)})`),
        );
        if (signal.aborted) return { status: "cancelled", effect: "possible" };
        if (!target.current()) return { status: "refused", effect: "possible" };
        return decode(answer);
      } catch (error) {
        // Electron's native Runtime.evaluate timeout returns this exact protocol error.
        // A transport failure has no such completion evidence and keeps custody quarantined.
        if (dispatched && error instanceof Error && error.message === "Execution was terminated")
          return { status: "timed-out", effect: "possible" };
        quarantined = dispatched;
        return { status: "execution-uncertain", effect: dispatched ? "possible" : "none" };
      } finally {
        if (!quarantined) this.#release(target.document);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Returning uncertainty must not release custody while an RPC may still be executing.
      return await Promise.race([
        execute(),
        new Promise<NativePageScriptReceipt>((resolve) => {
          timer = setTimeout(() => {
            expired = true;
            resolve({ status: "execution-uncertain", effect: dispatched ? "possible" : "none" });
          }, 2000);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function decode(answer: unknown): NativePageScriptReceipt {
  if (!record(answer)) return { status: "execution-uncertain", effect: "possible" };
  if (answer.exceptionDetails !== undefined) return { status: "script-failed", effect: "possible" };
  if (
    !record(answer.result) ||
    typeof answer.result.value !== "string" ||
    Buffer.byteLength(answer.result.value) > 24576
  )
    return { status: "truncated", effect: "possible" };
  try {
    const value: unknown = JSON.parse(answer.result.value);
    if (!record(value)) return { status: "unsupported-result", effect: "possible" };
    const status = value.status;
    if (
      status !== "completed" &&
      status !== "truncated" &&
      status !== "unsupported-result" &&
      status !== "script-failed"
    )
      return { status: "unsupported-result", effect: "possible" };
    if (status === "script-failed") return { status, effect: "possible" };
    const valueJson = value.value === undefined ? undefined : JSON.stringify(value.value);
    return { status, effect: "possible", ...(valueJson === undefined ? {} : { valueJson }) };
  } catch {
    return { status: "unsupported-result", effect: "possible" };
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parameters(target: PageScriptTarget, expression: string) {
  return {
    expression,
    uniqueContextId: target.uniqueContextId,
    timeout: 150,
    awaitPromise: false,
    returnByValue: true,
    userGesture: false,
    allowUnsafeEvalBlockedByCSP: false,
  };
}
