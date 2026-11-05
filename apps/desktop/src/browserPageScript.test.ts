import { afterEach } from "vitest";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { BrowserPageScript, pageScriptKernel } from "./browserPageScript";

function realm() {
  const context = createContext({ TextEncoder });
  runInContext(pageScriptKernel, context, { timeout: 500 });
  return (source: string) =>
    JSON.parse(
      runInContext(`this.__octantBoundedScript(${JSON.stringify(source)})`, context, {
        timeout: 150,
      }),
    );
}

describe("bounded page scripts", () => {
  afterEach(() => vi.useRealTimers());
  it("keeps its serializer private and usable after a previous script poisons globals", () => {
    const run = realm();
    expect(
      run(`JSON.stringify=()=>{while(true){}};
      Object.create=()=>{while(true){}}; Object.keys=()=>{while(true){}};
      WeakSet.prototype.has=()=>{while(true){}}; Math.min=()=>{while(true){}};
      Object.prototype.toJSON=()=>{while(true){}}; ({ok:true})`).status,
    ).toBe("completed");
    expect(run("({answer:42})")).toMatchObject({
      status: "completed",
      value: { type: "object", entries: { answer: 42 } },
    });
  });

  it("bounds escaped Unicode results and refuses promises and getters without invoking them", () => {
    const run = realm();
    const large = run('"\\u0000😀".repeat(100000)');
    expect(run("({['x'.repeat(200)]:1})").status).toBe("truncated");
    expect(run("({['x'.repeat(200)+'a']:1,['x'.repeat(200)+'b']:2})").status).toBe("truncated");
    expect(large.status).toBe("truncated");
    expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThanOrEqual(24 * 1024);
    expect(run("new Promise(()=>{})").status).toBe("unsupported-result");
    expect(run('throw new Error("Execution was terminated")').status).toBe("script-failed");
    expect(run("({get value(){while(true){}}})").status).toBe("unsupported-result");
    expect(run("42")).toMatchObject({ status: "completed", value: 42 });
  });

  it("does not start cancelled or stale attempts and keeps its hold until native execution settles", async () => {
    const abort = new AbortController();
    let settle: ((value: unknown) => void) | undefined;
    const native = new Promise<unknown>((resolve) => {
      settle = resolve;
    });
    const send = vi.fn(async (_method: string, params: Readonly<Record<string, unknown>>) =>
      params.expression === pageScriptKernel ? { result: { value: true } } : native,
    );
    const page = new BrowserPageScript();
    let held = false;
    const release = vi.fn(() => {
      held = false;
    });
    const target = {
      document: {},
      uniqueContextId: "owned-document-unique-id",
      current: () => true,
      send,
      reserve: () => {
        held = true;
        return release;
      },
    };
    const result = page.run(target, "42", abort.signal);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    abort.abort();
    expect(held).toBe(true);
    settle?.({ result: { value: '{"status":"completed","value":42}' } });
    expect(await result).toEqual({ status: "cancelled", effect: "possible" });
    expect(release).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[1]?.[1]).toMatchObject({
      uniqueContextId: target.uniqueContextId,
      timeout: 150,
      awaitPromise: false,
      returnByValue: true,
      userGesture: false,
      allowUnsafeEvalBlockedByCSP: false,
    });
    expect(await page.run(target, "42", abort.signal)).toEqual({
      status: "cancelled",
      effect: "none",
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("never dispatches agent source after its total deadline expired during realm preparation", async () => {
    vi.useFakeTimers();
    let initialize: ((value: unknown) => void) | undefined;
    const pending = new Promise<unknown>((resolve) => {
      initialize = resolve;
    });
    const send = vi.fn(async () => pending);
    const release = vi.fn();
    const target = {
      document: {},
      uniqueContextId: "document",
      current: () => true,
      reserve: () => release,
      send,
    };
    const run = new BrowserPageScript().run(
      target,
      "document.body.dataset.effect='ran'",
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(await run).toEqual({ status: "execution-uncertain", effect: "none" });
    expect(release).not.toHaveBeenCalled();
    initialize?.({ result: { value: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledOnce();
  });
  it("quarantines a dispatched attempt after transport failure until its document is destroyed", async () => {
    const release = vi.fn();
    const target = {
      document: {},
      uniqueContextId: "owned-document",
      current: () => true,
      reserve: () => release,
      send: vi.fn(async (_method: string, params: Readonly<Record<string, unknown>>) => {
        if (params.expression === pageScriptKernel) return { result: { value: true } };
        throw new Error("transport disconnected");
      }),
    };
    const controller = new BrowserPageScript();
    expect(await controller.run(target, "while(true){}", new AbortController().signal)).toEqual({
      status: "execution-uncertain",
      effect: "possible",
    });
    expect(release).not.toHaveBeenCalled();
    expect(await controller.run(target, "42", new AbortController().signal)).toEqual({
      status: "refused",
      effect: "none",
    });
    controller.documentDestroyed(target.document);
    controller.documentDestroyed(target.document);
    expect(release).toHaveBeenCalledOnce();
  });

  it("distinguishes the native termination reply from unrelated native exceptions", async () => {
    const release = vi.fn();
    let mode: "terminated" | "exception" = "terminated";
    const target = {
      document: {},
      uniqueContextId: "owned-document",
      current: () => true,
      reserve: () => release,
      send: async (_method: string, params: Readonly<Record<string, unknown>>) => {
        if (params.expression === pageScriptKernel) return { result: { value: true } };
        if (mode === "terminated") throw new Error("Execution was terminated");
        return { exceptionDetails: { text: "Uncaught unrelated failure" } };
      },
    };
    const controller = new BrowserPageScript();
    expect(await controller.run(target, "while(true){}", new AbortController().signal)).toEqual({
      status: "timed-out",
      effect: "possible",
    });
    mode = "exception";
    expect(await controller.run(target, "42", new AbortController().signal)).toEqual({
      status: "script-failed",
      effect: "possible",
    });
    expect(release).toHaveBeenCalledTimes(2);
  });
  it("pins one prepared source to its document and owner and refuses reuse or expired preparation", async () => {
    vi.useFakeTimers();
    const context = createContext({ TextEncoder });
    const target = {
      document: {},
      uniqueContextId: "owned",
      current: () => true,
      reserve: () => () => undefined,
      send: async (_method: string, params: Readonly<Record<string, unknown>>) => ({
        result: { value: runInContext(String(params.expression), context, { timeout: 150 }) },
      }),
    };
    const controller = new BrowserPageScript();
    const prepared = await controller.prepare(
      target,
      "globalThis.runs=(globalThis.runs??0)+1;42",
      "owner",
      new AbortController().signal,
    );
    if (prepared.status !== "prepared") throw new Error("expected prepared script");
    expect(runInContext("globalThis.runs", context)).toBeUndefined();
    expect(
      await controller.execute(
        prepared.planId,
        target,
        "other-owner",
        new AbortController().signal,
      ),
    ).toEqual({ status: "refused", effect: "none" });
    expect(
      await controller.execute(prepared.planId, target, "owner", new AbortController().signal),
    ).toMatchObject({ status: "completed", effect: "possible", valueJson: "42" });
    expect(
      await controller.execute(prepared.planId, target, "owner", new AbortController().signal),
    ).toEqual({ status: "refused", effect: "none" });
    expect(runInContext("globalThis.runs", context)).toBe(1);
    const expired = await controller.prepare(
      target,
      "globalThis.runs++",
      "owner",
      new AbortController().signal,
    );
    if (expired.status !== "prepared") throw new Error("expected prepared script");
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      await controller.execute(expired.planId, target, "owner", new AbortController().signal),
    ).toEqual({ status: "refused", effect: "none" });
    expect(runInContext("globalThis.runs", context)).toBe(1);
    const start = performance.now();
    const delayed = await controller.prepare(
      target,
      "globalThis.runs++",
      "owner",
      new AbortController().signal,
    );
    if (delayed.status !== "prepared") throw new Error("expected prepared script");
    const clock = vi.spyOn(performance, "now").mockReturnValue(start + 2001);
    try {
      expect(
        await controller.execute(delayed.planId, target, "owner", new AbortController().signal),
      ).toEqual({ status: "refused", effect: "none" });
      expect(runInContext("globalThis.runs", context)).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });
});
