import { CANVAS_DESIGN_PAGE_PATH } from "@octant/contracts/canvas";
import { describe, expect, it, vi } from "vitest";
import type { CanvasPrototypeHostCommand, CanvasPrototypeHostEvent } from "./canvasPrototypeHost";
import {
  createCanvasPrototypeSurface,
  decodeCanvasPrototypeInput,
  designPageTicket,
  type CanvasPrototypeHostConnection,
  type CanvasPrototypeOwner,
  type CanvasPrototypeSurfaceEvent,
} from "./canvasPrototypeSurface";

const server = "http://127.0.0.1:3773";
const ticket = "a".repeat(43);
const page = `${server}${CANVAS_DESIGN_PAGE_PATH}?ticket=${ticket}`;
const surfaceId = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";

function fakeHost() {
  const sent: Array<CanvasPrototypeHostCommand> = [];
  let emit: ((event: CanvasPrototypeHostEvent) => void) | undefined;
  let exit: (() => void) | undefined;
  const stop = vi.fn();
  const connection: CanvasPrototypeHostConnection = {
    send: (command) => sent.push(command),
    onEvent: (listener) => {
      emit = listener;
    },
    onExit: (listener) => {
      exit = listener;
    },
    stop,
  };
  return {
    connection,
    sent,
    stop,
    emit: (event: CanvasPrototypeHostEvent) => emit?.(event),
    exit: () => exit?.(),
  };
}

function owner(id = 1) {
  const heard: Array<CanvasPrototypeSurfaceEvent> = [];
  const port: CanvasPrototypeOwner = { id, send: (event) => heard.push(event) };
  return { port, heard };
}

function surface(
  input: {
    readonly fetch?: typeof fetch;
    readonly serverUrl?: string | undefined;
    readonly platform?: NodeJS.Platform;
  } = {},
) {
  const hosts: Array<ReturnType<typeof fakeHost>> = [];
  const made = createCanvasPrototypeSurface({
    launchHost: () => {
      const host = fakeHost();
      hosts.push(host);
      return host.connection;
    },
    serverUrl: () => ("serverUrl" in input ? input.serverUrl : server),
    fetch: input.fetch ?? vi.fn<typeof fetch>(async () => new Response("page")),
    platform: input.platform ?? "darwin",
    readyTimeoutMs: 50,
  });
  return { surface: made, hosts };
}

async function readySurface(input: Parameters<typeof surface>[0] = {}) {
  const made = surface(input);
  const preparing = made.surface.prepare();
  made.hosts[0]?.emit({ kind: "ready" });
  await expect(preparing).resolves.toEqual({ status: "ready" });
  const host = made.hosts[0];
  if (host === undefined) throw new Error("No host was started.");
  return { ...made, host };
}

const request = (fields: Record<string, unknown> = {}) => ({
  surfaceId,
  src: page,
  width: 390,
  height: 844,
  scaleFactor: 2,
  ...fields,
});

describe("starting the prototype host", () => {
  it("is ready only once the host reads back that its network and resolver are closed", async () => {
    const { surface: made, hosts } = surface();
    const preparing = made.prepare();
    expect(hosts).toHaveLength(1);
    // Asked again while it starts, it starts no second host.
    void made.prepare();
    expect(hosts).toHaveLength(1);
    hosts[0]?.emit({ kind: "ready" });
    await expect(preparing).resolves.toEqual({ status: "ready" });
  });

  it("reports the host's refusal, stops it, and starts over on the next try", async () => {
    const { surface: made, hosts } = surface();
    const preparing = made.prepare();
    hosts[0]?.emit({ kind: "unavailable", reason: "Names still resolve." });
    await expect(preparing).resolves.toEqual({
      status: "unavailable",
      reason: "Names still resolve.",
    });
    expect(hosts[0]?.stop).toHaveBeenCalledOnce();
    const again = made.prepare();
    expect(hosts).toHaveLength(2);
    hosts[1]?.emit({ kind: "ready" });
    await expect(again).resolves.toEqual({ status: "ready" });
  });

  it("is unavailable when the host says nothing in time or exits before it is ready", async () => {
    const silent = surface();
    await expect(silent.surface.prepare()).resolves.toMatchObject({ status: "unavailable" });
    expect(silent.hosts[0]?.stop).toHaveBeenCalledOnce();

    const exiting = surface();
    const preparing = exiting.surface.prepare();
    exiting.hosts[0]?.exit();
    await expect(preparing).resolves.toMatchObject({ status: "unavailable" });
  });
});

describe("opening a prototype", () => {
  it("fetches the ticketed design page itself and hands the host the page and its own policy", async () => {
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
    const { surface: made, host } = await readySurface({ fetch: fetchPage });
    await expect(made.open(owner().port, request())).resolves.toEqual({ status: "open" });
    expect(String(fetchPage.mock.calls[0]?.[0])).toBe(page);
    expect(fetchPage.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    const opened = host.sent[0];
    if (opened?.kind !== "open") throw new Error("The host was not asked to open the page.");
    expect(opened).toMatchObject({ surfaceId, width: 390, height: 844, scaleFactor: 2 });
    expect(new TextDecoder().decode(opened.page.body)).toBe("<p>design</p>");
    expect(opened.page.headers).toEqual({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "sandbox allow-scripts; default-src 'none'",
    });
  });

  it("refuses any address but a ticketed design page on this host, without asking the host", async () => {
    const fetchPage = vi.fn<typeof fetch>(async () => new Response("page"));
    const { surface: made, host } = await readySurface({ fetch: fetchPage });
    for (const src of [
      "https://example.com/",
      `${server}/api/not-the-design-page?ticket=${ticket}`,
      `http://127.0.0.1:9999${CANVAS_DESIGN_PAGE_PATH}?ticket=${ticket}`,
      `${page}&path=/api/secret`,
      `${server}${CANVAS_DESIGN_PAGE_PATH}?ticket=short`,
    ]) {
      await expect(made.open(owner().port, request({ src }))).resolves.toMatchObject({
        status: "refused",
      });
    }
    for (const malformed of [
      request({ surfaceId: "not-an-id" }),
      request({ width: 0 }),
      request({ height: 100_000 }),
      request({ scaleFactor: 8 }),
      undefined,
    ]) {
      await expect(made.open(owner().port, malformed)).resolves.toMatchObject({
        status: "refused",
      });
    }
    expect(fetchPage).not.toHaveBeenCalled();
    expect(host.sent).toEqual([]);
  });

  it("opens nothing before the host is ready, or when the host cannot be reached", async () => {
    const unprepared = surface();
    await expect(unprepared.surface.open(owner().port, request())).resolves.toMatchObject({
      status: "refused",
    });
    const unreachable = await readySurface({
      fetch: vi.fn<typeof fetch>(async () => {
        throw new Error("connection refused");
      }),
    });
    await expect(unreachable.surface.open(owner().port, request())).resolves.toMatchObject({
      status: "refused",
    });
    expect(unreachable.host.sent).toEqual([]);
  });
});

describe("a prototype's window", () => {
  it("alone hears its prototype's pixels, bridge messages, and cursor", async () => {
    const { surface: made, host } = await readySurface();
    const first = owner(1);
    const second = owner(2);
    await made.open(first.port, request());
    await made.open(second.port, request({ surfaceId: other }));
    host.emit({
      kind: "frame",
      surfaceId,
      frameWidth: 1,
      frameHeight: 1,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      pixels: new Uint8Array(4),
    });
    host.emit({ kind: "bridge", surfaceId, payload: { type: "heartbeat" } });
    host.emit({ kind: "cursor", surfaceId: other, cursor: "pointer" });
    expect(first.heard.map((event) => event.kind)).toEqual(["frame", "bridge"]);
    expect(second.heard).toEqual([{ kind: "cursor", surfaceId: other, cursor: "pointer" }]);
  });

  it("forwards its own input, size, and close, and nothing for a prototype another window opened", async () => {
    const { surface: made, host } = await readySurface();
    const first = owner(1);
    const second = owner(2);
    await made.open(first.port, request());
    host.sent.length = 0;
    const click = { type: "mouseDown", x: 10.4, y: 20, button: "left", clickCount: 1 };
    made.input(second.port, surfaceId, click);
    made.resize(second.port, surfaceId, 100, 100);
    made.close(second.port, surfaceId);
    expect(host.sent).toEqual([]);

    made.input(first.port, surfaceId, click);
    made.resize(first.port, surfaceId, 390, 900);
    made.close(first.port, surfaceId);
    expect(host.sent).toEqual([
      {
        kind: "input",
        surfaceId,
        input: { type: "mouseDown", x: 10, y: 20, button: "left", clickCount: 1, modifiers: [] },
      },
      { kind: "resize", surfaceId, width: 390, height: 900 },
      { kind: "close", surfaceId },
    ]);
  });

  it("loses its prototypes when the window goes, and hears they are gone when the host exits", async () => {
    const { surface: made, host } = await readySurface();
    const first = owner(1);
    await made.open(first.port, request());
    await made.open(owner(2).port, request({ surfaceId: other }));
    made.closeOwnedBy(2);
    expect(host.sent.at(-1)).toEqual({ kind: "close", surfaceId: other });
    host.exit();
    expect(first.heard).toEqual([{ kind: "gone", surfaceId }]);
    await expect(made.open(first.port, request())).resolves.toMatchObject({ status: "refused" });
  });
});

describe("a person's input", () => {
  it("never hands the page the reserved shortcut: Command-Escape on macOS, Control-Escape elsewhere", () => {
    const key = (modifiers: ReadonlyArray<string>) => ({
      type: "keyDown",
      keyCode: "Escape",
      modifiers,
    });
    expect(decodeCanvasPrototypeInput(key(["meta"]), "darwin")).toBeUndefined();
    expect(decodeCanvasPrototypeInput(key(["control"]), "linux")).toBeUndefined();
    expect(decodeCanvasPrototypeInput(key([]), "darwin")).toEqual(key([]));
    expect(decodeCanvasPrototypeInput(key(["control"]), "darwin")).toEqual(key(["control"]));
    expect(decodeCanvasPrototypeInput(key(["meta"]), "linux")).toEqual(key(["meta"]));
  });

  it("takes only the pointer, wheel, key, focus, and edit commands a person can give", () => {
    for (const refused of [
      { type: "contextMenu", x: 0, y: 0 },
      { type: "mouseDown", x: Number.NaN, y: 0 },
      { type: "mouseDown", x: 0, y: 0, button: "back" },
      { type: "mouseDown", x: 0, y: 0, clickCount: 9 },
      { type: "keyDown", keyCode: "" },
      { type: "keyDown", keyCode: "a", modifiers: ["leftbuttondown"] },
      { type: "edit", command: "print" },
      { type: "mouseWheel", x: 0, y: 0, deltaX: 0, deltaY: Number.POSITIVE_INFINITY },
      "click",
    ]) {
      expect(decodeCanvasPrototypeInput(refused, "darwin")).toBeUndefined();
    }
    expect(decodeCanvasPrototypeInput({ type: "edit", command: "paste" }, "darwin")).toEqual({
      type: "edit",
      command: "paste",
    });
    expect(
      decodeCanvasPrototypeInput(
        { type: "mouseWheel", x: 1, y: 2, deltaX: 0, deltaY: 40 },
        "darwin",
      ),
    ).toEqual({ type: "mouseWheel", x: 1, y: 2, deltaX: 0, deltaY: 40, modifiers: [] });
  });
});

describe("design page addresses", () => {
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
