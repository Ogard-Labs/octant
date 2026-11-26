import { describe, expect, it, vi } from "vitest";
import { visitorViewer } from "./visitorViewer";

const LINK_ID = "link-1";

/** Just enough IndexedDB for the viewer's key and scope: every request answers on a later tick. */
function memoryIndexedDb() {
  const data = new Map<string, unknown>();
  const database = {
    createObjectStore: () => undefined,
    transaction: () => {
      let pending = 0;
      const transaction: { oncomplete?: () => void; objectStore: () => unknown } = {
        objectStore: () => store,
      };
      const answer = (read: () => unknown) => {
        pending += 1;
        const request: { result?: unknown; onsuccess?: () => void } = {};
        setTimeout(() => {
          request.result = read();
          request.onsuccess?.();
          pending -= 1;
          if (pending === 0) setTimeout(() => transaction.oncomplete?.());
        });
        return request;
      };
      const store = {
        get: (key: string) => answer(() => data.get(key)),
        put: (value: unknown, key: string) => answer(() => void data.set(key, value)),
      };
      return transaction;
    },
  };
  return {
    open: () => {
      const request: { result: unknown; onsuccess?: () => void } = { result: database };
      setTimeout(() => request.onsuccess?.());
      return request;
    },
  };
}

/** Runs the viewer's script against a page at `/v/link-1#k=secret` and the given answers. */
function openViewer(
  answer: (path: string, call: number, signal?: AbortSignal) => Response | Promise<Response>,
) {
  const script = [...visitorViewer().assets.values()].find((asset) =>
    asset.type.startsWith("text/javascript"),
  );
  if (script === undefined) throw new Error("The viewer has no script.");
  const status = { textContent: "Opening…" };
  const element = () => ({
    textContent: "",
    hidden: true,
    replaceChildren: () => undefined,
    addEventListener: () => undefined,
    querySelector: () => ({ textContent: "", value: "" }),
  });
  const elements: Record<string, unknown> = {
    status,
    thread: element(),
    title: element(),
    comment: element(),
  };
  const calls: Array<string> = [];
  const replaceState = vi.fn();
  const run = new Function(
    "document",
    "location",
    "history",
    "fetch",
    "indexedDB",
    "setTimeout",
    String(script.body),
  );
  run(
    { getElementById: (id: string) => elements[id], title: "" },
    { pathname: `/v/${LINK_ID}`, hash: "#k=secret" },
    { replaceState },
    async (path: string, init?: { readonly signal?: AbortSignal }) => {
      calls.push(path);
      return answer(path, calls.filter((called) => called === path).length, init?.signal);
    },
    memoryIndexedDb(),
    // The viewer's waits run a thousand times faster here.
    (resume: () => void, ms: number) => setTimeout(resume, ms / 1000),
  );
  return { status, calls, replaceState };
}

const OPEN = `/v/${LINK_ID}/open`;
const STREAM = `/v/${LINK_ID}/stream`;
const ended = () => new Response(null, { status: 410 });

describe("the visitor viewer's first open", () => {
  it.each([
    [
      401,
      "This link could not be checked. Make sure this device's clock is set correctly, then reload.",
    ],
    [404, "This link does not exist."],
  ])(
    "keeps the secret in the address after a %i, so a reload can still open the link",
    async (refusal, message) => {
      const viewer = openViewer(() => new Response(null, { status: refusal }));
      await vi.waitFor(() => expect(viewer.status.textContent).toBe(message));
      expect(viewer.replaceState).not.toHaveBeenCalled();
    },
  );

  it("drops the secret once the link is open in another browser", async () => {
    const viewer = openViewer(() => Response.json({ error: "bound" }, { status: 403 }));
    await vi.waitFor(() =>
      expect(viewer.status.textContent).toMatch(/^This link is open in another browser/),
    );
    expect(viewer.replaceState).toHaveBeenCalledOnce();
  });

  it.each([503, 429])(
    "tries again on its own after a %i, then follows the thread",
    async (busy) => {
      const viewer = openViewer((path, call) => {
        if (path === OPEN) {
          return call === 1
            ? new Response(null, { status: busy })
            : Response.json({ scope: "read" });
        }
        return ended();
      });
      await vi.waitFor(() => expect(viewer.status.textContent).toBe("This link has ended."));
      expect(viewer.calls.filter((path) => path === OPEN)).toHaveLength(2);
      expect(viewer.calls).toContain(STREAM);
      expect(viewer.replaceState).toHaveBeenCalledOnce();
    },
  );

  it("gives up on a first open that hangs, and tries again", async () => {
    const viewer = openViewer((path, call, signal) => {
      if (path !== OPEN) return ended();
      if (call > 1) return Response.json({ scope: "read" });
      // A front that holds the connection open and never answers.
      return new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    });
    await vi.waitFor(() => expect(viewer.status.textContent).toBe("This link has ended."));
    expect(viewer.calls.filter((path) => path === OPEN)).toHaveLength(2);
  });

  it.each([200, 403])(
    "gives up on a first open whose %i answer stalls after its headers, and tries again",
    async (status) => {
      const viewer = openViewer((path, call, signal) => {
        if (path !== OPEN) return ended();
        if (call > 1) return Response.json({ scope: "read" });
        // Headers arrive at once; the body never does, until the page gives up.
        const body = new ReadableStream({
          start(controller) {
            signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          },
        });
        return new Response(body, { status, headers: { "content-type": "application/json" } });
      });
      await vi.waitFor(() => expect(viewer.status.textContent).toBe("This link has ended."));
      expect(viewer.calls.filter((path) => path === OPEN)).toHaveLength(2);
    },
  );
});
