import { describe, expect, it, vi } from "vitest";
import type { CodeCheckoutId, CodeRelativePath, CodeThreadId } from "@octant/contracts";
import {
  createCodeFileListingClient,
  CodeFileListingClientFailure,
  isRefusedCodeFileWatch,
} from "./codeFileListingClient";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const threadId = "00000000-0000-4000-8000-000000000903" as CodeThreadId;
const checkoutId = "00000000-0000-4000-8000-000000000902" as CodeCheckoutId;

const listedResult = {
  status: "listed",
  listing: {
    kind: "code-file-listing",
    threadId,
    checkoutId,
    entries: [{ kind: "directory", path: "apps" }],
    truncated: false,
    observedAt: "2026-08-14T08:00:00.000Z",
  },
};

function client(fetchImpl: typeof globalThis.fetch) {
  return createCodeFileListingClient({
    baseUrl: "http://127.0.0.1:4319",
    fetch: fetchImpl,
    windowCapability: capability,
  });
}

describe("code file listing client", () => {
  it("multiplexes sixteen extra folders and duplicate panes through one connection", async () => {
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              output = controller;
            },
          }),
        ),
    );
    const shared = client(fetchImpl);
    const folders = [
      undefined,
      ...Array.from({ length: 16 }, (_, index) => `/approved/folder-${index}`),
      undefined,
    ];
    const signals = folders.map(() => new AbortController());
    const streams = folders.map((folder, index) =>
      shared.watch(
        { threadId, checkoutId, ...(folder === undefined ? {} : { folder }) },
        signals[index]?.signal ?? AbortSignal.abort(),
      ),
    );
    const initial = await Promise.all(streams.map((stream) => stream.next()));
    expect(initial.every((frame) => frame.value?.truncated)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(JSON.parse(url.searchParams.get("folders") ?? "[]")).toHaveLength(17);
    const target = streams[16];
    if (target === undefined) throw new Error("Missing fixture reader");
    const next = target.next();
    output?.enqueue(
      new TextEncoder().encode(
        `${JSON.stringify({ kind: "code-file-change", threadId, checkoutId, folder: folders[16], paths: ["changed.txt"], truncated: false, observedAt: "2026-11-06T12:00:00.000Z" })}\n`,
      ),
    );
    expect((await next).value).toMatchObject({ folder: folders[16], paths: ["changed.txt"] });
    signals[0]?.abort();
    await streams[0]?.return(undefined);
    expect(fetchImpl).toHaveBeenCalledOnce();
    for (const signal of signals) signal.abort();
    await Promise.all(streams.map((stream) => stream.return(undefined)));
  });
  it("requests the listing for a thread checkout and decodes it", async () => {
    const fetchImpl = vi.fn(async () => Response.json(listedResult));
    const result = await client(fetchImpl as unknown as typeof globalThis.fetch).list({
      threadId,
      checkoutId,
    });

    expect(result.status).toBe("listed");
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain("/api/code/files/listing?");
    expect(url).toContain(`threadId=${String(threadId)}`);
    expect(url).toContain(`checkoutId=${String(checkoutId)}`);
  });

  it("passes a subdirectory through when one is requested", async () => {
    const fetchImpl = vi.fn(async () => Response.json(listedResult));
    await client(fetchImpl as unknown as typeof globalThis.fetch).list({
      threadId,
      checkoutId,
      directory: "apps/web" as CodeRelativePath,
    });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain("directory=apps%2Fweb");
  });

  it("returns a typed failure result rather than throwing", async () => {
    const failed = {
      status: "failed",
      failure: { category: "unavailable", message: "Code file listing is unavailable." },
    };
    const result = await client(
      vi.fn(async () => Response.json(failed)) as unknown as typeof globalThis.fetch,
    ).list({ threadId, checkoutId });
    expect(result).toEqual(failed);
  });

  it("surfaces the server message on an HTTP failure", async () => {
    const failing = vi.fn(async () =>
      Response.json({ message: "Code request is unauthorized." }, { status: 401 }),
    );
    await expect(
      client(failing as unknown as typeof globalThis.fetch).list({ threadId, checkoutId }),
    ).rejects.toMatchObject({ status: 401, message: "Code request is unauthorized." });
  });

  it("asks the host to watch an extra folder by its absolute path", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    await client(fetchImpl as unknown as typeof globalThis.fetch)
      .watch({ threadId, checkoutId, folder: "/Users/me/notes" }, new AbortController().signal)
      .next();

    const url = new URL(String((fetchImpl.mock.calls[0] as unknown as [string])[0]));
    expect(url.searchParams.get("folder")).toBe("/Users/me/notes");
  });

  it("tells a refused watch apart from a dropped one", async () => {
    const unauthorized = new Response("", { status: 401 });
    const unavailable = new Response("", { status: 503 });
    const dropped = new Response("", { status: 200 });
    const controller = new AbortController();

    const refusal = await client((async () => unauthorized) as unknown as typeof globalThis.fetch)
      .watch({ threadId, checkoutId }, controller.signal)
      .next()
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // The host said no. Reopening the watch would only be refused again, so
    // the caller has to be able to see that rather than reconnect forever.
    expect(refusal).toBeInstanceOf(CodeFileListingClientFailure);
    expect(isRefusedCodeFileWatch(refusal)).toBe(true);
    expect((refusal as CodeFileListingClientFailure).status).toBe(401);

    const missing = await client((async () => unavailable) as unknown as typeof globalThis.fetch)
      .watch({ threadId, checkoutId }, controller.signal)
      .next()
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(isRefusedCodeFileWatch(missing)).toBe(true);
    expect((missing as CodeFileListingClientFailure).status).toBe(503);

    // A stream that opened and ended is an ordinary drop, unchanged.
    const stream = client((async () => dropped) as unknown as typeof globalThis.fetch).watch(
      { threadId, checkoutId },
      controller.signal,
    );
    expect((await stream.next()).value).toMatchObject({ truncated: true, paths: [] });
    const drop = await stream.next();
    expect(drop.done).toBe(true);
    expect(isRefusedCodeFileWatch(drop.value)).toBe(false);
  });

  it("refuses a base URL that is not loopback", () => {
    expect(() =>
      createCodeFileListingClient({
        baseUrl: "https://example.com",
        fetch: globalThis.fetch,
        windowCapability: capability,
      }),
    ).toThrow(CodeFileListingClientFailure);
  });
});
