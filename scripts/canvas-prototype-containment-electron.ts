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

const mode = process.env.OCTANT_PROBE_MODE ?? "";
const issueUrl = process.env.OCTANT_PROBE_ISSUE_URL ?? "";
const serverUrl = process.env.OCTANT_PROBE_SERVER_URL ?? "";
const beaconUrl = process.env.OCTANT_PROBE_BEACON_URL ?? "";
const preloadPath = process.env.OCTANT_PROBE_PRELOAD ?? "";
const watchMs = Number(process.env.OCTANT_PROBE_WATCH_MS ?? "9000");

app.setPath("userData", mkdtempSync(join(tmpdir(), "octant-prototype-probe-")));

const surfaceModule =
  mode === "contained" ? await import("../apps/desktop/src/canvasPrototypeSurface") : undefined;
surfaceModule?.registerCanvasPrototypeScheme(protocol);

interface BridgeRecord {
  readonly channel: string;
  readonly args: ReadonlyArray<unknown>;
}

async function ticketUrl(): Promise<string> {
  return (await (await fetch(issueUrl)).text()).trim();
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

app.whenReady().then(async () => {
  const logPath = join(app.getPath("userData"), "net.json");
  await netLog.startLogging(logPath, { captureMode: "everything" });
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: mode === "contained",
    },
  });

  let refusals: Record<string, unknown> = {};
  let proxy: unknown;
  if (mode === "contained" && surfaceModule !== undefined) {
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
        surface.guardGuest(surfaceModule.canvasPrototypeGuestPort(contents, surfaceSession));
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
  const url = await ticketUrl();
  await window.webContents.executeJavaScript(`
    window.__bridge = [];
    window.__mount = (src) => {
      ${
        mode === "contained"
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

  if (mode === "contained") {
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
