import { readFileSync } from "node:fs";
import { CANVAS_DESIGN_BRIDGE_CHANNEL } from "@octant/contracts/canvas";
import { describe, expect, it, vi } from "vitest";
import {
  CANVAS_PROTOTYPE_HOST_CHROMIUM_SWITCHES,
  CANVAS_PROTOTYPE_PAGE_BRIDGE_CHANNEL,
  CANVAS_PROTOTYPE_SCHEME,
  createCanvasPrototypeHost,
  type CanvasPrototypeCancellable,
  type CanvasPrototypeHostEvent,
  type CanvasPrototypeHostPagePort,
  type CanvasPrototypeHostSessionPort,
  type CanvasPrototypeInput,
  type CanvasPrototypePaint,
  type CanvasPrototypeRectangle,
  MAX_BRIDGE_MESSAGES_PER_SECOND,
} from "./canvasPrototypeHost";

const NO_ROUTE = "SOCKS5 127.0.0.1:1";
const surfaceId = "11111111-1111-4111-8111-111111111111";
const address = `${CANVAS_PROTOTYPE_SCHEME}://page/${surfaceId}`;

function fakeSession(
  input: { readonly routes?: Record<string, string>; readonly resolves?: boolean } = {},
) {
  let serve: ((request: Request) => Promise<Response>) | undefined;
  const session = {
    setProxy: vi.fn<CanvasPrototypeHostSessionPort["setProxy"]>(async () => undefined),
    resolveProxy: vi.fn<CanvasPrototypeHostSessionPort["resolveProxy"]>(
      async (url) => input.routes?.[url] ?? NO_ROUTE,
    ),
    resolveHost: vi.fn<CanvasPrototypeHostSessionPort["resolveHost"]>(async () => {
      if (input.resolves === true) return { endpoints: [{ address: "127.0.0.1" }] };
      throw new Error("net::ERR_NAME_NOT_RESOLVED");
    }),
    refuseEverythingAsked: vi.fn(),
    serve: vi.fn((handler: (request: Request) => Promise<Response>) => {
      serve = handler;
    }),
  } satisfies CanvasPrototypeHostSessionPort;
  return { session, answer: (request: Request) => serve?.(request) };
}

function fakePage() {
  let navigate: ((event: CanvasPrototypeCancellable) => void) | undefined;
  let gone: (() => void) | undefined;
  let bridge: ((payload: unknown) => void) | undefined;
  let paint: ((paint: CanvasPrototypePaint) => void) | undefined;
  const inputs: Array<CanvasPrototypeInput> = [];
  const port = {
    onPaint: (listener: (painted: CanvasPrototypePaint) => void) => {
      paint = listener;
    },
    onCursor: vi.fn(),
    onBridge: (listener: (payload: unknown) => void) => {
      bridge = listener;
    },
    onGone: (listener: () => void) => {
      gone = listener;
    },
    onNavigation: (listener: (event: CanvasPrototypeCancellable) => void) => {
      navigate = listener;
    },
    refuseNewWindows: vi.fn(),
    refuseNonProxiedUdp: vi.fn(),
    refuseUnloadPrompts: vi.fn(),
    load: vi.fn(),
    input: (input: CanvasPrototypeInput) => inputs.push(input),
    setSize: vi.fn(),
    close: vi.fn(),
  } satisfies CanvasPrototypeHostPagePort;
  return {
    port,
    inputs,
    navigate: () => {
      let cancelled = false;
      navigate?.({ preventDefault: () => (cancelled = true) });
      return cancelled;
    },
    bridge: (payload: unknown) => bridge?.(payload),
    paint: (painted: CanvasPrototypePaint) => paint?.(painted),
    gone: () => gone?.(),
  };
}

function host(session = fakeSession().session) {
  const sent: Array<CanvasPrototypeHostEvent> = [];
  const pages: Array<ReturnType<typeof fakePage>> = [];
  const made = createCanvasPrototypeHost({
    session,
    send: (event) => sent.push(event),
    createPage: () => {
      const page = fakePage();
      pages.push(page);
      return page.port;
    },
  });
  return { host: made, sent, pages };
}

const open = {
  kind: "open" as const,
  surfaceId,
  page: {
    status: 200,
    headers: { "content-type": "text/html", "content-security-policy": "default-src 'none'" },
    body: new TextEncoder().encode("<p>design</p>"),
  },
  width: 390,
  height: 844,
  scaleFactor: 2,
};

describe("the prototype host process", () => {
  it("is started with the agent's preview browser's no-route switches, a resolver that answers nothing among them", () => {
    expect(
      CANVAS_PROTOTYPE_HOST_CHROMIUM_SWITCHES.map(([name, value]) => `--${name}=${value}`),
    ).toEqual([
      "--proxy-server=socks5://127.0.0.1:1",
      "--proxy-bypass-list=<-loopback>",
      "--host-resolver-rules=MAP * ~NOTFOUND",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    ]);
  });

  it("says it is ready only after reading back a dead proxy for public and loopback addresses and that names do not resolve", async () => {
    const made = fakeSession();
    const { host: started, sent } = host(made.session);
    await started.start();
    expect(made.session.setProxy).toHaveBeenCalledWith({
      proxyRules: "socks5://127.0.0.1:1",
      proxyBypassRules: "<-loopback>",
    });
    expect(made.session.resolveProxy).toHaveBeenCalledWith("https://example.com/");
    expect(made.session.resolveProxy).toHaveBeenCalledWith("http://127.0.0.1:9/");
    expect(made.session.resolveHost).toHaveBeenCalledWith("localhost");
    expect(made.session.refuseEverythingAsked).toHaveBeenCalledOnce();
    expect(sent).toEqual([{ kind: "ready" }]);
  });

  it("is unavailable, and serves nothing, when a name still resolves or an address would leave", async () => {
    const resolving = fakeSession({ resolves: true });
    const named = host(resolving.session);
    await named.host.start();
    expect(named.sent).toEqual([{ kind: "unavailable", reason: expect.stringMatching(/names/) }]);
    expect(resolving.session.serve).not.toHaveBeenCalled();

    for (const route of ["DIRECT", "SOCKS5 127.0.0.1:1; DIRECT", "PROXY 127.0.0.1:8080", ""]) {
      const routed = fakeSession({ routes: { "http://127.0.0.1:9/": route } });
      const leaking = host(routed.session);
      await leaking.host.start();
      expect(leaking.sent[0]?.kind).toBe("unavailable");
      expect(routed.session.serve).not.toHaveBeenCalled();
    }
  });
});

describe("a page in the prototype host", () => {
  it("is served once, as the app handed it over, and nothing else is served", async () => {
    const made = fakeSession();
    const { host: started, pages } = host(made.session);
    await started.start();
    started.receive(open);
    expect(pages[0]?.port.load).toHaveBeenCalledWith(address);
    const response = await made.answer(new Request(address));
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("<p>design</p>");
    expect(response?.headers.get("content-security-policy")).toBe("default-src 'none'");
    // A second load of the same address gets nothing.
    expect((await made.answer(new Request(address)))?.status).toBe(404);
    for (const elsewhere of [
      `${CANVAS_PROTOTYPE_SCHEME}://page/22222222-2222-4222-8222-222222222222`,
      `${CANVAS_PROTOTYPE_SCHEME}://other/${surfaceId}`,
      `${address}?x=1`,
    ]) {
      expect((await made.answer(new Request(elsewhere)))?.status).toBe(404);
    }
  });

  it("refuses new windows and non-proxied UDP, and cancels every navigation the page starts", async () => {
    const { host: started, pages } = host();
    await started.start();
    started.receive(open);
    const page = pages[0];
    expect(page?.port.refuseNewWindows).toHaveBeenCalledOnce();
    expect(page?.port.refuseNonProxiedUdp).toHaveBeenCalledOnce();
    // A page's `beforeunload` cannot keep it, or the host, from closing.
    expect(page?.port.refuseUnloadPrompts).toHaveBeenCalledOnce();
    expect(page?.navigate()).toBe(true);
  });

  it("passes on the page's bridge messages and input, and says when the page is gone", async () => {
    const { host: started, sent, pages } = host();
    await started.start();
    started.receive(open);
    sent.length = 0;
    pages[0]?.bridge({ channel: CANVAS_DESIGN_BRIDGE_CHANNEL, type: "heartbeat" });
    started.receive({ kind: "input", surfaceId, input: { type: "focus" } });
    expect(pages[0]?.inputs).toEqual([{ type: "focus" }]);
    pages[0]?.gone();
    expect(sent).toEqual([
      {
        kind: "bridge",
        surfaceId,
        payload: { channel: CANVAS_DESIGN_BRIDGE_CHANNEL, type: "heartbeat" },
      },
      { kind: "gone", surfaceId },
    ]);
    expect(pages[0]?.port.close).toHaveBeenCalledOnce();
  });
});

/** A paint of a whole frame of the tallest, widest page at twice its pixels. */
function largePaint(dirty: CanvasPrototypeRectangle, reads: Array<CanvasPrototypeRectangle>) {
  const frameWidth = 3_840;
  const frameHeight = 24_000;
  return {
    frameWidth,
    frameHeight,
    dirty,
    read: (rectangle: CanvasPrototypeRectangle) => {
      reads.push(rectangle);
      // The budget counts the rectangle's RGBA bytes; the test need not make them.
      return new Uint8Array(0);
    },
  } satisfies CanvasPrototypePaint;
}

describe("a page's frames", () => {
  it("never leave more than one frame waiting for the window, and fold paints meanwhile into the next", async () => {
    vi.useFakeTimers();
    try {
      const { host: started, sent, pages } = host();
      await started.start();
      started.receive(open);
      sent.length = 0;
      const reads: Array<CanvasPrototypeRectangle> = [];
      const page = pages[0];
      for (let index = 0; index < 500; index += 1) {
        page?.paint(largePaint({ x: index, y: index, width: 10, height: 10 }, reads));
      }
      const frames = () => sent.filter((event) => event.kind === "frame");
      // The first paint goes; the other 499 wait, read nothing, and send nothing.
      expect(frames()).toHaveLength(1);
      expect(reads).toEqual([{ x: 0, y: 0, width: 10, height: 10 }]);

      started.receive({ kind: "drawn", surfaceId });
      expect(frames()).toHaveLength(2);
      expect(reads.at(-1)).toEqual({ x: 1, y: 1, width: 508, height: 508 });
      // Drawn again with nothing new painted, nothing is sent.
      started.receive({ kind: "drawn", surfaceId });
      expect(frames()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keep to a byte budget each second, so whole-page repaints wait their turn", async () => {
    vi.useFakeTimers();
    try {
      const { host: started, sent, pages } = host();
      await started.start();
      started.receive(open);
      sent.length = 0;
      const reads: Array<CanvasPrototypeRectangle> = [];
      const whole = { x: 0, y: 0, width: 3_840, height: 24_000 };
      const frames = () => sent.filter((event) => event.kind === "frame").length;
      // A whole frame is about 370 MB, past a second's budget: it goes, and
      // the next waits until that is paid back.
      pages[0]?.paint(largePaint(whole, reads));
      started.receive({ kind: "drawn", surfaceId });
      pages[0]?.paint(largePaint(whole, reads));
      expect(frames()).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(frames()).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(frames()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a page's input and bridge", () => {
  it("runs only the six edit commands, whatever name arrives", async () => {
    const { host: started, pages } = host();
    await started.start();
    started.receive(open);
    for (const command of ["loadURL", "executeJavaScript", "constructor", "copy"]) {
      started.receive({
        kind: "input",
        surfaceId,
        input: { type: "edit", command } as CanvasPrototypeInput,
      });
    }
    expect(pages[0]?.inputs).toEqual([{ type: "edit", command: "copy" }]);
  });

  it("passes on no more bridge messages a second than shows the window a flood", async () => {
    vi.useFakeTimers();
    try {
      const { host: started, sent, pages } = host();
      await started.start();
      started.receive(open);
      sent.length = 0;
      const heartbeat = { channel: CANVAS_DESIGN_BRIDGE_CHANNEL, type: "heartbeat" };
      for (let index = 0; index < 5_000; index += 1) pages[0]?.bridge(heartbeat);
      expect(sent).toHaveLength(MAX_BRIDGE_MESSAGES_PER_SECOND);
      await vi.advanceTimersByTimeAsync(1_000);
      pages[0]?.bridge(heartbeat);
      expect(sent).toHaveLength(MAX_BRIDGE_MESSAGES_PER_SECOND + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the page's preload", () => {
  it("repeats the bridge's channel and the channel the host listens on", () => {
    const source = readFileSync(new URL("./canvasPrototypePreload.ts", import.meta.url), "utf8");
    expect(source).toContain(`const PAGE_CHANNEL = "${CANVAS_DESIGN_BRIDGE_CHANNEL}";`);
    expect(source).toContain(`const HOST_CHANNEL = "${CANVAS_PROTOTYPE_PAGE_BRIDGE_CHANNEL}";`);
  });
});
