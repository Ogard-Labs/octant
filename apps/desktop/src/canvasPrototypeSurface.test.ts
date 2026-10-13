import { readFileSync } from "node:fs";
import type { WebPreferences } from "electron";
import {
  CANVAS_DESIGN_BRIDGE_CHANNEL,
  CANVAS_DESIGN_PAGE_PATH,
  CANVAS_DESIGN_SURFACE_BRIDGE_EVENT,
} from "@octant/contracts/canvas";
import { describe, expect, it, vi } from "vitest";
import {
  CANVAS_FRAME_FOCUS_ESCAPE_CHANNEL,
  CANVAS_PROTOTYPE_PARTITION,
  CANVAS_PROTOTYPE_SCHEME,
  createCanvasPrototypeSurface,
  designPageTicket,
  type CanvasPrototypeGuestPort,
  type CanvasPrototypeHostPort,
  type CanvasPrototypeKeyInput,
  type CanvasPrototypeSessionPort,
} from "./canvasPrototypeSurface";

const server = "http://127.0.0.1:3773";
const ticket = "a".repeat(43);
const page = `${server}${CANVAS_DESIGN_PAGE_PATH}?ticket=${ticket}`;
const surfaceAddress = `${CANVAS_PROTOTYPE_SCHEME}://page/?ticket=${ticket}`;
const NO_ROUTE = "SOCKS5 127.0.0.1:1";

function fakeSession(routes: Record<string, string> = {}) {
  let serve: ((request: Request) => Promise<Response>) | undefined;
  const session = {
    setProxy: vi.fn<CanvasPrototypeSessionPort["setProxy"]>(async () => undefined),
    resolveProxy: vi.fn<CanvasPrototypeSessionPort["resolveProxy"]>(
      async (url) => routes[url] ?? NO_ROUTE,
    ),
    refuseEverythingAsked: vi.fn(),
    serve: vi.fn((handler: (request: Request) => Promise<Response>) => {
      serve = handler;
    }),
  } satisfies CanvasPrototypeSessionPort;
  return { session, answer: (request: Request) => serve?.(request) };
}

function surface(
  input: {
    readonly session?: ReturnType<typeof fakeSession>["session"];
    readonly serverUrl?: string | undefined;
    readonly fetch?: typeof fetch;
    readonly platform?: NodeJS.Platform;
  } = {},
) {
  const made = fakeSession();
  const session = input.session ?? made.session;
  const created = createCanvasPrototypeSurface({
    session,
    serverUrl: () => ("serverUrl" in input ? input.serverUrl : server),
    fetch: input.fetch ?? vi.fn<typeof fetch>(async () => new Response("page")),
    preloadPath: "/app/canvasPrototypePreload.cjs",
    platform: input.platform ?? "darwin",
  });
  return { surface: created, session };
}

function host() {
  let attach:
    | ((
        event: { readonly preventDefault: () => void },
        webPreferences: WebPreferences,
        params: Record<string, string>,
      ) => void)
    | undefined;
  const port: CanvasPrototypeHostPort = {
    onWillAttachWebview: (listener) => {
      attach = listener;
    },
  };
  const tryAttach = (params: Record<string, string>, webPreferences: WebPreferences = {}) => {
    let cancelled = false;
    attach?.({ preventDefault: () => (cancelled = true) }, webPreferences, params);
    return { cancelled, params, webPreferences };
  };
  return { port, tryAttach };
}

describe("the prototype surface's network", () => {
  it("sends every connection, loopback included, to a proxy that is never one, and reads that back before it is ready", async () => {
    const { surface: made, session } = surface();
    await expect(made.prepare()).resolves.toEqual({ status: "ready" });
    expect(session.setProxy).toHaveBeenCalledWith({
      proxyRules: "socks5://127.0.0.1:1",
      proxyBypassRules: "<-loopback>",
    });
    expect(session.resolveProxy).toHaveBeenCalledWith("https://example.com/");
    expect(session.resolveProxy).toHaveBeenCalledWith("http://127.0.0.1:9/");
    expect(session.refuseEverythingAsked).toHaveBeenCalledOnce();
    expect(session.serve).toHaveBeenCalledOnce();
    // Asked again, it does not serve or refuse twice.
    await made.prepare();
    expect(session.serve).toHaveBeenCalledOnce();
  });

  it("does not become ready, and serves nothing, when the session would still reach a public or a loopback address", async () => {
    for (const route of ["DIRECT", "SOCKS5 127.0.0.1:1; DIRECT", "PROXY 127.0.0.1:8080", ""]) {
      for (const target of ["https://example.com/", "http://127.0.0.1:9/"]) {
        const made = fakeSession({ [target]: route });
        const { surface: unprepared } = surface({ session: made.session });
        const result = await unprepared.prepare();
        expect(result.status).toBe("unavailable");
        expect(made.session.serve).not.toHaveBeenCalled();
      }
    }
  });

  it("reports a failure to close the network as a value, and starts over on the next try", async () => {
    const made = fakeSession();
    made.session.setProxy.mockRejectedValueOnce(new Error("no proxy service"));
    const { surface: unprepared } = surface({ session: made.session });
    await expect(unprepared.prepare()).resolves.toMatchObject({ status: "unavailable" });
    expect(made.session.serve).not.toHaveBeenCalled();
    await expect(unprepared.prepare()).resolves.toEqual({ status: "ready" });
    expect(made.session.serve).toHaveBeenCalledOnce();
  });
});

describe("the page the surface serves", () => {
  async function ready(fetchPage: typeof fetch) {
    const made = fakeSession();
    const { surface: created } = surface({ session: made.session, fetch: fetchPage });
    await created.prepare();
    return made.answer;
  }

  it("asks the host for the ticketed design page only, keeping the page's own policy", async () => {
    const fetchPage = vi.fn<typeof fetch>(
      async () =>
        new Response("<p>design</p>", {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": "sandbox allow-scripts; default-src 'none'",
            "set-cookie": "host=secret",
            "x-other": "dropped",
          },
        }),
    );
    const answer = await ready(fetchPage);
    const response = await answer(new Request(surfaceAddress));
    expect(String(fetchPage.mock.calls[0]?.[0])).toBe(page);
    expect(fetchPage.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("<p>design</p>");
    expect(response?.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts; default-src 'none'",
    );
    expect(response?.headers.get("set-cookie")).toBeNull();
    expect(response?.headers.get("x-other")).toBeNull();
  });

  it("answers nothing else: another path, host, query, or method never reaches the host", async () => {
    const fetchPage = vi.fn<typeof fetch>(async () => new Response("page"));
    const answer = await ready(fetchPage);
    for (const address of [
      `${CANVAS_PROTOTYPE_SCHEME}://page/other?ticket=${ticket}`,
      `${CANVAS_PROTOTYPE_SCHEME}://elsewhere/?ticket=${ticket}`,
      `${CANVAS_PROTOTYPE_SCHEME}://page/?ticket=${ticket}&path=/api/secret`,
      `${CANVAS_PROTOTYPE_SCHEME}://page/?ticket=short`,
      `${CANVAS_PROTOTYPE_SCHEME}://page/`,
      `${CANVAS_PROTOTYPE_SCHEME}://page/?ticket=${ticket}#x`,
      `${CANVAS_PROTOTYPE_SCHEME}://page/favicon.ico`,
    ]) {
      expect((await answer(new Request(address)))?.status).toBe(404);
    }
    expect((await answer(new Request(surfaceAddress, { method: "POST", body: "x" })))?.status).toBe(
      405,
    );
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("reports an unreachable host as a refusal, not as a page", async () => {
    const answer = await ready(
      vi.fn<typeof fetch>(async () => {
        throw new Error("connection refused");
      }),
    );
    expect((await answer(new Request(surfaceAddress)))?.status).toBe(502);

    const made = fakeSession();
    const { surface: noHost } = surface({ session: made.session, serverUrl: undefined });
    await noHost.prepare();
    expect((await made.answer(new Request(surfaceAddress)))?.status).toBe(503);
  });
});

describe("what the renderer may attach", () => {
  it("attaches only a ticketed design page on this host, in the surface's own partition and preferences", async () => {
    const { surface: made } = surface();
    const window = host();
    made.admitWebview(window.port);
    await made.prepare();

    // Everything the element asked for, including a partition, a preload, and
    // preferences that would give the page a way out.
    const attached = window.tryAttach(
      {
        instanceId: "7",
        src: page,
        partition: "persist:chosen-by-the-renderer",
        preload: "file:///tmp/evil.js",
        webpreferences: "nodeIntegration=yes",
        allowpopups: "true",
        nodeintegration: "true",
        disablewebsecurity: "true",
        useragent: "x",
      },
      {
        nodeIntegration: true,
        nodeIntegrationInSubFrames: true,
        contextIsolation: false,
        sandbox: false,
        webSecurity: false,
        plugins: true,
        partition: "persist:chosen-by-the-renderer",
        preload: "/tmp/evil.js",
        additionalArguments: ["--x"],
        zoomFactor: 2,
      },
    );
    expect(attached.cancelled).toBe(false);
    expect(attached.params).toMatchObject({
      instanceId: "7",
      src: surfaceAddress,
      partition: CANVAS_PROTOTYPE_PARTITION,
      preload: "",
      webpreferences: "",
      allowpopups: "false",
      nodeintegration: "false",
      disablewebsecurity: "false",
      useragent: "",
    });
    expect(attached.webPreferences).toEqual({
      contextIsolation: true,
      disableBlinkFeatures: "",
      disablePopups: true,
      enableBlinkFeatures: "",
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      partition: CANVAS_PROTOTYPE_PARTITION,
      plugins: false,
      preload: "/app/canvasPrototypePreload.cjs",
      sandbox: true,
      webSecurity: true,
      zoomFactor: 2,
    });
    expect(CANVAS_PROTOTYPE_PARTITION.startsWith("persist:")).toBe(false);
  });

  it("cancels every other address, and every attach before the surface is ready", async () => {
    const { surface: made } = surface();
    const window = host();
    made.admitWebview(window.port);
    expect(window.tryAttach({ src: page }).cancelled).toBe(true);
    await made.prepare();
    for (const src of [
      "https://example.com/",
      "http://127.0.0.1:9/",
      `${server}/api/canvas/other?ticket=${ticket}`,
      `http://127.0.0.1:9999${CANVAS_DESIGN_PAGE_PATH}?ticket=${ticket}`,
      `${server}${CANVAS_DESIGN_PAGE_PATH}?ticket=${ticket}&extra=1`,
      `${server}${CANVAS_DESIGN_PAGE_PATH}`,
      `${server}${CANVAS_DESIGN_PAGE_PATH}?ticket=short`,
      `${server}${CANVAS_DESIGN_PAGE_PATH}?ticket=${ticket}#x`,
      `http://user:pass@127.0.0.1:3773${CANVAS_DESIGN_PAGE_PATH}?ticket=${ticket}`,
      surfaceAddress,
      "file:///etc/passwd",
      "",
    ]) {
      expect(window.tryAttach({ src, partition: "persist:x" }).cancelled, src).toBe(true);
    }
    expect(window.tryAttach({}).cancelled).toBe(true);
    expect(window.tryAttach({ src: page }).cancelled).toBe(false);
  });

  it("accepts the address a shared snapshot's prototype is given, built the way the client builds it", () => {
    // The client resolves the host's `/api/canvas/design-page?ticket=` path
    // against its base address, which the desktop gives with a trailing slash.
    const address = new URL(`${CANVAS_DESIGN_PAGE_PATH}?ticket=${ticket}`, `${server}/`).toString();
    expect(designPageTicket(address, `${server}/`)).toBe(ticket);
  });

  it("knows no design page while the host is unknown", () => {
    expect(designPageTicket(page, undefined)).toBeUndefined();
    expect(designPageTicket(page, server)).toBe(ticket);
    expect(designPageTicket("not a url", server)).toBeUndefined();
  });
});

describe("what a prototype's surface may do", () => {
  function guest(input: { readonly inSurface?: boolean } = {}) {
    let navigate: ((event: { readonly preventDefault: () => void }) => void) | undefined;
    let key:
      | ((event: { readonly preventDefault: () => void }, input: CanvasPrototypeKeyInput) => void)
      | undefined;
    const sent: Array<string> = [];
    const port: CanvasPrototypeGuestPort = {
      inSurfaceSession: () => input.inSurface ?? true,
      onNavigation: (listener) => {
        navigate = listener;
      },
      onKeyInput: (listener) => {
        key = listener;
      },
      refuseNewWindows: vi.fn(),
      refuseNonProxiedUdp: vi.fn(),
      sendToHost: (channel) => sent.push(channel),
    };
    const press = (fields: Partial<CanvasPrototypeKeyInput>): "swallowed" | "passed" => {
      let swallowed = false;
      key?.(
        { preventDefault: () => (swallowed = true) },
        {
          type: "keyDown",
          key: "Escape",
          meta: false,
          control: false,
          alt: false,
          shift: false,
          ...fields,
        },
      );
      return swallowed ? "swallowed" : "passed";
    };
    const moves = (): "cancelled" | "allowed" => {
      let cancelled = false;
      navigate?.({ preventDefault: () => (cancelled = true) });
      return cancelled ? "cancelled" : "allowed";
    };
    return { port, press, moves, sent };
  }

  it("refuses new windows and non-proxied UDP, and cancels every navigation after its first page", () => {
    const { surface: made } = surface();
    const held = guest();
    made.guardGuest(held.port);
    expect(held.port.refuseNewWindows).toHaveBeenCalledOnce();
    expect(held.port.refuseNonProxiedUdp).toHaveBeenCalledOnce();
    expect(held.moves()).toBe("cancelled");
  });

  it("leaves a guest outside the surface's session alone", () => {
    const { surface: made } = surface();
    const other = guest({ inSurface: false });
    made.guardGuest(other.port);
    expect(other.port.refuseNewWindows).not.toHaveBeenCalled();
    expect(other.moves()).toBe("allowed");
    expect(other.press({ meta: true })).toBe("passed");
  });

  it("reads Command-Escape on macOS and Control-Escape elsewhere before the page sees it, and tells the window", () => {
    const mac = surface({ platform: "darwin" });
    const onMac = guest();
    mac.surface.guardGuest(onMac.port);
    expect(onMac.press({ meta: true })).toBe("swallowed");
    expect(onMac.sent).toEqual([CANVAS_FRAME_FOCUS_ESCAPE_CHANNEL]);
    for (const fields of [
      { control: true },
      { meta: true, control: true },
      { meta: true, alt: true },
      { meta: true, shift: true },
      { meta: true, key: "a" },
      { meta: true, type: "keyUp" },
      {},
    ]) {
      expect(onMac.press(fields)).toBe("passed");
    }
    expect(onMac.sent).toHaveLength(1);

    const other = surface({ platform: "linux" });
    const onLinux = guest();
    other.surface.guardGuest(onLinux.port);
    expect(onLinux.press({ control: true })).toBe("swallowed");
    expect(onLinux.press({ meta: true })).toBe("passed");
  });
});

describe("the surface's preload", () => {
  it("repeats the bridge's channel and the event the embedder listens for", () => {
    const source = readFileSync(new URL("./canvasPrototypePreload.ts", import.meta.url), "utf8");
    expect(source).toContain(`const PAGE_CHANNEL = "${CANVAS_DESIGN_BRIDGE_CHANNEL}";`);
    expect(source).toContain(`const EMBEDDER_EVENT = "${CANVAS_DESIGN_SURFACE_BRIDGE_EVENT}";`);
  });
});
