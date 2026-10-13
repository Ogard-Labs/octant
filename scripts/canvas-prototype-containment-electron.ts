// Electron side of the Canvas prototype containment probe.
//
// `smoke-canvas-prototype-containment.ts` bundles this file and runs it in the
// Electron the desktop app ships. It draws one hostile running prototype in
// the way `OCTANT_PROBE_MODE` names and prints what the page managed to do as
// one `OCTANT_PROBE_RESULT` line. What reached the listeners is counted by the
// orchestrator, not here, so a page cannot be believed about its own escape.
//
// Modes:
// - `uncontained-frame`: the page in a sandboxed frame of the app window with
//   the WebRTC policy the renderer set before prototypes had their own
//   surface. It is the control: if it reaches nothing, the probe could not
//   have seen an escape.
// - `contained`: the page in the desktop app's contained prototype surface.
//
// Not shipped: it runs only under the probe, from a throwaway user data
// directory.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, netLog, protocol, session, webContents } from "electron";
import { CANVAS_DESIGN_VIEWPORT } from "../packages/contracts/src/canvas";

const mode = process.env.OCTANT_PROBE_MODE ?? "";
const contained = mode === "contained" || mode === "contained-pointer";
const issueUrl = process.env.OCTANT_PROBE_ISSUE_URL ?? "";
const serverUrl = process.env.OCTANT_PROBE_SERVER_URL ?? "";
const beaconUrl = process.env.OCTANT_PROBE_BEACON_URL ?? "";
const preloadPath = process.env.OCTANT_PROBE_PRELOAD ?? "";
const watchMs = Number(process.env.OCTANT_PROBE_WATCH_MS ?? "9000");
const escapes: Array<string> = [];

app.setPath("userData", mkdtempSync(join(tmpdir(), "octant-prototype-probe-")));

const surfaceModule = contained
  ? await import("../apps/desktop/src/canvasPrototypeSurface")
  : undefined;
surfaceModule?.registerCanvasPrototypeScheme(protocol);

interface BridgeRecord {
  readonly channel: string;
  readonly args: ReadonlyArray<unknown>;
}

async function ticketUrl(query = ""): Promise<string> {
  return (await (await fetch(`${issueUrl}${query}`)).text()).trim();
}

function finish(result: Record<string, unknown>): never {
  console.log(`OCTANT_PROBE_RESULT ${JSON.stringify(result)}`);
  app.exit(0);
  throw new Error("unreachable");
}

/** Hostnames the page asked the resolver for, read from the network log. */
function resolvedCanaries(logPath: string): ReadonlyArray<string> {
  const log = JSON.parse(readFileSync(logPath, "utf8")) as {
    readonly constants: { readonly logEventTypes: Readonly<Record<string, number>> };
    readonly events: ReadonlyArray<{ readonly type: number; readonly params?: unknown }>;
  };
  const names = new Map<number, string>(
    Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]),
  );
  const found = new Set<string>();
  for (const event of log.events) {
    const type = names.get(event.type) ?? "";
    // A resolver job, not just a request: a request that never became a job
    // was refused before any lookup (an image sent to the proxy, for one).
    if (
      !/^(?:HOST_RESOLVER_MANAGER_JOB|HOST_RESOLVER_SYSTEM_TASK|HOST_RESOLVER_DNS_TASK|DNS_TRANSACTION)/.test(
        type,
      )
    ) {
      continue;
    }
    for (const match of JSON.stringify(event.params ?? {}).match(/[a-z-]+\.canary\.example/g) ??
      []) {
      found.add(match);
    }
  }
  return [...found].sort();
}

/**
 * A phone-sized prototype scaled down the way the renderer scales a running
 * one (a clipped box the size of the scaled page, the page at its viewport
 * with `transform: scale` from the top left), clicked with real pointer
 * events routed through the window as a person's would be. The page reports
 * which element took each click and where, in its own pixels.
 */
async function pointerRun(window: BrowserWindow): Promise<never> {
  const viewport = CANVAS_DESIGN_VIEWPORT.phone;
  const column = 195;
  const scale = Math.min(1, column / viewport.width);
  const origin = { x: 20, y: 20 };
  const url = await ticketUrl("?block=pointer");
  await window.webContents.executeJavaScript(`
    window.__bridge = [];
    const box = document.createElement("div");
    box.style.cssText = "position:absolute;overflow:hidden;left:${String(origin.x)}px;top:${String(origin.y)}px;width:${String(viewport.width * scale)}px;height:${String(viewport.height * scale)}px";
    const view = document.createElement("webview");
    view.setAttribute("src", ${JSON.stringify(url)});
    view.style.cssText = "position:absolute;left:0;top:0;width:${String(viewport.width)}px;height:${String(viewport.height)}px;transform:scale(${String(scale)});transform-origin:0 0;border:0";
    view.addEventListener("ipc-message", (event) => window.__bridge.push(event.args[0]));
    box.append(view);
    document.body.append(box);
    0`);
  await new Promise((resolve) => setTimeout(resolve, 4000));

  // Chromium routes these through the embedder to the guest under the
  // transform; `sendInputEvent` on the embedder does not reach a guest.
  window.webContents.debugger.attach("1.3");
  const taken = async (): Promise<ReadonlyArray<string>> =>
    (
      (await window.webContents.executeJavaScript("window.__bridge.splice(0)")) as ReadonlyArray<{
        readonly type?: string;
        readonly message?: string;
      }>
    )
      .filter((message) => message.type === "error")
      .map((message) => message.message ?? "");
  await taken();
  const click = async (hostX: number, hostY: number): Promise<ReadonlyArray<string>> => {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const) {
      await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
        type,
        x: hostX,
        y: hostY,
        button: type === "mouseMoved" ? "none" : "left",
        clickCount: type === "mouseMoved" ? 0 : 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    return await taken();
  };
  // A point in the page's own pixels, as the host window sees it once scaled.
  const at = (pageX: number, pageY: number) => ({
    x: origin.x + pageX * scale,
    y: origin.y + pageY * scale,
  });
  const scaledBox = {
    right: origin.x + viewport.width * scale,
    bottom: origin.y + viewport.height * scale,
  };
  const target = at(260, 660);
  const decoy = at(50, 50);
  const results = {
    scale,
    viewport,
    target: await click(target.x, target.y),
    decoy: await click(decoy.x, decoy.y),
    // Just past each edge of the scaled box, where the unclipped page would
    // reach if it were laid out unscaled.
    pastRightEdge: await click(scaledBox.right + 2, target.y),
    pastBottomEdge: await click(target.x, scaledBox.bottom + 2),
    whereUnscaledTargetWouldBe: await click(origin.x + 260, origin.y + 660),
  };
  finish({ mode, pointer: results });
}

app.whenReady().then(async () => {
  const logPath = join(app.getPath("userData"), "net.json");
  await netLog.startLogging(logPath, { captureMode: "everything" });
  const window = new BrowserWindow({
    show: false,
    width: 800,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: contained,
    },
  });

  let refusals: Record<string, unknown> = {};
  let proxy: unknown;
  if (contained && surfaceModule !== undefined) {
    const surfaceSession = session.fromPartition(surfaceModule.CANVAS_PROTOTYPE_PARTITION);
    const surface = surfaceModule.createCanvasPrototypeSurface({
      session: surfaceModule.canvasPrototypeSessionPort(surfaceSession),
      serverUrl: () => serverUrl,
      fetch: globalThis.fetch,
      preloadPath,
      platform: process.platform,
    });
    app.on("web-contents-created", (_event, contents) => {
      if (contents.getType() === "webview") {
        const port = surfaceModule.canvasPrototypeGuestPort(contents, surfaceSession);
        surface.guardGuest({
          ...port,
          sendToHost: (channel) => {
            escapes.push(channel);
            port.sendToHost(channel);
          },
        });
      }
    });
    surface.admitWebview(surfaceModule.canvasPrototypeHostPort(window.webContents));
    const prepared = await surface.prepare();
    proxy = prepared;
    if (prepared.status !== "ready") finish({ mode, prepared });
  } else {
    // What the renderer set before prototypes had their own surface.
    window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  }

  await window.loadURL("data:text/html,<!doctype html><title>host</title><body></body>");
  if (mode === "contained-pointer") {
    await pointerRun(window);
    return;
  }
  const url = await ticketUrl();
  await window.webContents.executeJavaScript(`
    window.__bridge = [];
    window.__mount = (src) => {
      ${
        contained
          ? `const view = document.createElement("webview");
             view.setAttribute("src", src);
             view.style.width = "375px"; view.style.height = "667px";
             view.addEventListener("ipc-message", (event) => window.__bridge.push({ channel: event.channel, args: event.args }));
             document.body.append(view);`
          : `const frame = document.createElement("iframe");
             frame.setAttribute("sandbox", "allow-scripts");
             frame.src = src;
             addEventListener("message", (event) => { if (event.source === frame.contentWindow) window.__bridge.push({ channel: "frame", args: [event.data] }); });
             document.body.append(frame);`
      }
    };
    window.__mount(${JSON.stringify(url)});
  `);

  if (contained) {
    // The renderer is not trusted to choose what the surface shows: a
    // webview pointed at anything but a ticketed design page is refused, and a
    // partition it names is ignored.
    await window.webContents.executeJavaScript(`
      for (const src of [${JSON.stringify(`${beaconUrl}/renderer-chosen`)}, ${JSON.stringify(`${serverUrl}/api/not-the-design-page`)}, "https://example.com/"]) {
        const view = document.createElement("webview");
        view.setAttribute("partition", "persist:chosen-by-renderer");
        view.setAttribute("src", src);
        document.body.append(view);
      }
    `);
  }

  await new Promise((resolve) => setTimeout(resolve, watchMs));
  const guests = webContents
    .getAllWebContents()
    .filter((contents) => contents.getType() === "webview");
  const sessions = guests.map((contents) => ({
    shared: contents.session === window.webContents.session,
    partitions: contents.session.storagePath ?? "memory",
    url: contents.getURL().replace(/ticket=[^&]+/, "ticket=…"),
  }));
  // The reserved shortcut and a plain Escape, sent to the page as a person's
  // keys would be. The page listens for both and reports what it saw.
  const reserved = process.platform === "darwin" ? "meta" : "control";
  guests[0]?.sendInputEvent({ type: "keyDown", keyCode: "Escape", modifiers: [reserved] });
  guests[0]?.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const proxyFor = async (target: string): Promise<string | undefined> =>
    guests[0]?.session.resolveProxy(target);
  refusals = {
    guests: guests.length,
    publicProxy: await proxyFor("https://example.com/"),
    loopbackProxy: await proxyFor("http://127.0.0.1:9/"),
  };
  const bridge = (await window.webContents.executeJavaScript(
    "window.__bridge",
  )) as ReadonlyArray<BridgeRecord>;
  await netLog.stopLogging();
  finish({
    mode,
    prepared: proxy,
    sessions,
    refusals,
    focusEscapes: escapes.length,
    bridge: {
      heartbeats: bridge.filter((record) =>
        JSON.stringify(record.args[0] ?? {}).includes('"heartbeat"'),
      ).length,
      sizes: bridge
        .map(
          (record) =>
            record.args[0] as { readonly type?: string; readonly height?: number } | undefined,
        )
        .filter((message) => message?.type === "size")
        .map((message) => message?.height),
      attempts: bridge
        .map(
          (record) =>
            record.args[0] as { readonly type?: string; readonly message?: string } | undefined,
        )
        .filter((message) => message?.type === "error")
        .map((message) => message?.message),
    },
    dnsLookups: resolvedCanaries(logPath),
  });
});
