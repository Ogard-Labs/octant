import { describe, expect, it, vi } from "vitest";
import { createRequestCoordinator } from "./requestCoordinator";

describe("createRequestCoordinator", () => {
  it("keeps the live browser fetch bound to its realm", async () => {
    const original = globalThis.fetch;
    try {
      const realmFetch = vi.fn(function (this: unknown) {
        if (this !== globalThis) throw new TypeError("Illegal invocation");
        return Promise.resolve(Response.json({ ok: true }));
      }) as unknown as typeof globalThis.fetch;
      globalThis.fetch = realmFetch;
      const coordinated = createRequestCoordinator({ fetch: globalThis.fetch });

      await expect(coordinated("http://127.0.0.1/api/code/navigation")).resolves.toMatchObject({
        status: 200,
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects concurrency settings that could deadlock reads", () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;

    expect(() => createRequestCoordinator({ fetch, maxConcurrent: 0 })).toThrow(
      "Request concurrency must be positive.",
    );
    expect(() => createRequestCoordinator({ fetch, maxBackground: 0 })).toThrow(
      "Background request concurrency must be positive.",
    );
  });

  it("coalesces simultaneous identical reads and gives each caller its own response", async () => {
    const release = deferred<Response>();
    const fetch = vi.fn(() => release.promise);
    const coordinated = createRequestCoordinator({ fetch: fetch as typeof globalThis.fetch });

    const first = coordinated("http://127.0.0.1/api/code/navigation");
    const second = coordinated("http://127.0.0.1/api/code/navigation");
    expect(fetch).toHaveBeenCalledOnce();
    const response = Response.json({ value: 1 });
    const bodyRead = vi.spyOn(response, "arrayBuffer");
    release.resolve(response);

    await expect((await first).json()).resolves.toEqual({ value: 1 });
    await expect((await second).json()).resolves.toEqual({ value: 1 });
    expect(bodyRead).toHaveBeenCalledOnce();
  });

  it("coalesces identical conversation evidence batches as foreground reads", async () => {
    const release = deferred<Response>();
    const fetch = vi.fn(() => release.promise);
    const coordinated = createRequestCoordinator({ fetch: fetch as typeof globalThis.fetch });
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "thread", items: [] }),
    };

    const first = coordinated("http://127.0.0.1/api/code/evidence/batch", init);
    const second = coordinated("http://127.0.0.1/api/code/evidence/batch", init);
    expect(fetch).toHaveBeenCalledOnce();
    release.resolve(Response.json({ threadId: "thread", items: [] }));

    await expect((await first).json()).resolves.toMatchObject({ threadId: "thread" });
    await expect((await second).json()).resolves.toMatchObject({ threadId: "thread" });
  });

  it("coalesces identical schema-declared POST queries without treating mutations as reads", async () => {
    const boardRelease = deferred<Response>();
    const fetch = vi.fn((input: RequestInfo | URL) =>
      String(input).endsWith("/api/work/board")
        ? boardRelease.promise
        : Promise.resolve(Response.json({ status: "accepted" })),
    );
    const coordinated = createRequestCoordinator({ fetch: fetch as typeof globalThis.fetch });
    const query = { method: "POST", body: JSON.stringify({ projectId: "project" }) };

    const first = coordinated("http://127.0.0.1/api/work/board", query);
    const second = coordinated("http://127.0.0.1/api/work/board", query);
    const mutation = coordinated("http://127.0.0.1/api/work/threads/commands", query);
    expect(fetch).toHaveBeenCalledTimes(2);
    boardRelease.resolve(Response.json({ cards: [] }));

    await Promise.all([first, second, mutation]);
    expect(
      fetch.mock.calls.filter(([input]) => String(input).endsWith("/api/work/board")),
    ).toHaveLength(1);
  });

  it("starts a foreground transcript before queued background observations", async () => {
    const active = deferred<Response>();
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return url.endsWith("/first") ? active.promise : Promise.resolve(new Response(url));
    });
    const coordinated = createRequestCoordinator({
      fetch: fetch as typeof globalThis.fetch,
      maxConcurrent: 1,
    });

    const first = coordinated("http://127.0.0.1/api/code/first");
    const background = coordinated("http://127.0.0.1/api/code/navigation");
    const foreground = coordinated("http://127.0.0.1/api/code/threads/thread/conversation");
    active.resolve(new Response("first"));
    await first;
    await foreground;
    await background;

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "http://127.0.0.1/api/code/first",
      "http://127.0.0.1/api/code/threads/thread/conversation",
      "http://127.0.0.1/api/code/navigation",
    ]);
  });

  it("coalesces unauthorized renewal without replaying mutations", async () => {
    const renew = deferred<void>();
    const onUnauthorized = vi.fn(() => renew.promise);
    const fetch = vi.fn(async () => new Response(null, { status: 401 }));
    const coordinated = createRequestCoordinator({
      fetch: fetch as typeof globalThis.fetch,
      onUnauthorized,
    });

    const first = coordinated("http://127.0.0.1/api/code/commands", { method: "POST" });
    const second = coordinated("http://127.0.0.1/api/work/turns", { method: "POST" });
    await Promise.resolve();
    expect(onUnauthorized).toHaveBeenCalledOnce();
    renew.resolve();

    await expect(first).resolves.toMatchObject({ status: 401 });
    await expect(second).resolves.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns the original unauthorized response when renewal itself fails", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 401 }));
    const coordinated = createRequestCoordinator({
      fetch: fetch as typeof globalThis.fetch,
      onUnauthorized: () => {
        throw new Error("host is restarting");
      },
    });

    await expect(coordinated("http://127.0.0.1/api/code/navigation")).resolves.toMatchObject({
      status: 401,
    });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
