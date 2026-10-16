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
//   the WebRTC policy the renderer set before prototypes left the window. It
//   is the control: if it reaches nothing, the probe could not have seen an
//   escape.
// - `contained`: the page in the desktop app's prototype host, started and
//   driven by the desktop's own surface code, as the app's main process does.
// - `contained-pointer`: a benign page in the prototype host, clicked through
//   the surface's input path, with what it drew read back.
//
// Not shipped: it runs only under the probe, from a throwaway user data
// directory.

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, netLog } from "electron";
import { CANVAS_DESIGN_VIEWPORT } from "../packages/contracts/src/canvas";
import {
  createCanvasPrototypeSurface,
  spawnCanvasPrototypeHost,
  type CanvasPrototypeOwner,
  type CanvasPrototypeSurfaceEvent,
} from "../apps/desktop/src/canvasPrototypeSurface";

const mode = process.env.OCTANT_PROBE_MODE ?? "";
const contained = mode === "contained" || mode === "contained-pointer";
const issueUrl = process.env.OCTANT_PROBE_ISSUE_URL ?? "";
const serverUrl = process.env.OCTANT_PROBE_SERVER_URL ?? "";
const beaconUrl = process.env.OCTANT_PROBE_BEACON_URL ?? "";
const hostEntry = process.env.OCTANT_PROBE_HOST ?? "";
const watchMs = Number(process.env.OCTANT_PROBE_WATCH_MS ?? "9000");

app.setPath("userData", mkdtempSync(join(tmpdir(), "octant-prototype-probe-")));
const hostLogPath = join(app.getPath("userData"), "host-net.json");

interface BridgeRecord {
  readonly type?: string;
  readonly height?: number;
  readonly message?: string;
}

async function ticketUrl(query = ""): Promise<string> {
  return (await (await fetch(`${issueUrl}${query}`)).text()).trim();
}

function finish(result: Record<string, unknown>): never {
  console.log(`OCTANT_PROBE_RESULT ${JSON.stringify(result)}`);
  app.exit(0);
  throw new Error("unreachable");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface LogReading {
  /** Whether the log holds the given address at all: the page's own requests were logged. */
  readonly sawAddress: boolean;
  /** Page-chosen names a resolver was asked for. */
  readonly lookups: ReadonlyArray<string>;
  /** Page-chosen names that appear in any event, looked up or not. */
  readonly mentioned: ReadonlyArray<string>;
  readonly events: number;
}

/** Hostnames asked of a resolver, read from a network log. */
function resolvedCanaries(logPath: string, address: string): LogReading {
  if (!existsSync(logPath)) return { sawAddress: false, lookups: [], mentioned: [], events: 0 };
  let text = readFileSync(logPath, "utf8").trim();
  const sawAddress = text.includes(address);
  // A process that was stopped leaves its log without the closing brackets.
  if (!text.endsWith("}")) text = `${text.replace(/,\s*$/, "")}]}`;
  const log = JSON.parse(text) as {
    readonly constants: { readonly logEventTypes: Readonly<Record<string, number>> };
    readonly events: ReadonlyArray<{ readonly type: number; readonly params?: unknown }>;
  };
  const names = new Map<number, string>(
    Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]),
  );
  const found = new Set<string>();
  const mentioned = new Set<string>();
  for (const event of log.events) {
    const type = names.get(event.type) ?? "";
    for (const match of JSON.stringify(event.params ?? {}).match(/[a-z-]+\.canary\.example/g) ??
      []) {
      mentioned.add(match);
    }
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
  return {
    sawAddress,
    lookups: [...found].sort(),
    mentioned: [...mentioned].sort(),
    events: log.events.length,
  };
}

/** What the window that opened the prototypes hears, and the page it was drawn as. */
function recordingOwner() {
  const bridge: Array<BridgeRecord> = [];
  const frames = { count: 0, width: 0, height: 0, pixels: new Uint8Array() };
  const gone: Array<string> = [];
  const owner: CanvasPrototypeOwner = {
    id: 1,
    send: (event: CanvasPrototypeSurfaceEvent) => {
      if (event.kind === "bridge") bridge.push(event.payload as BridgeRecord);
      else if (event.kind === "gone") gone.push(event.surfaceId);
      else if (event.kind === "frame") {
        frames.count += 1;
        if (frames.width !== event.frameWidth || frames.height !== event.frameHeight) {
          frames.width = event.frameWidth;
          frames.height = event.frameHeight;
          frames.pixels = new Uint8Array(event.frameWidth * event.frameHeight * 4);
        }
        for (let row = 0; row < event.height; row += 1) {
          const from = row * event.width * 4;
          frames.pixels.set(
            event.pixels.subarray(from, from + event.width * 4),
            ((event.y + row) * frames.width + event.x) * 4,
          );
        }
      }
    },
  };
  /** The colour drawn at a point of the page, in its own pixels. */
  const colourAt = (x: number, y: number, scale: number) => {
    const index = (Math.round(y * scale) * frames.width + Math.round(x * scale)) * 4;
    return [...frames.pixels.subarray(index, index + 3)];
  };
  return { owner, bridge, frames, gone, colourAt };
}

function surfaceFor() {
  return createCanvasPrototypeSurface({
    launchHost: () =>
      spawnCanvasPrototypeHost({
        executable: process.execPath,
        args: [hostEntry, `--log-net-log=${hostLogPath}`, "--net-log-capture-mode=Everything"],
      }),
    serverUrl: () => serverUrl,
    fetch: globalThis.fetch,
    platform: process.platform,
  });
}

/**
 * A phone-sized benign page in the prototype host, clicked through the input
 * path a person's pointer takes. The page reports which element took each
 * click, and where, in its own pixels; the frames it painted are read back.
 */
async function pointerRun(): Promise<never> {
  const surface = surfaceFor();
  const recorded = recordingOwner();
  const prepared = await surface.prepare(recorded.owner);
  if (prepared.status !== "ready") finish({ mode, prepared });
  const surfaceId = randomUUID();
  const viewport = CANVAS_DESIGN_VIEWPORT.phone;
  const opened = await surface.open(recorded.owner, {
    surfaceId,
    src: await ticketUrl("?block=pointer"),
    width: viewport.width,
    height: viewport.height,
    scaleFactor: 2,
  });
  if (opened.status !== "open") finish({ mode, prepared, opened });
  await sleep(4000);
  const taken = () =>
    recorded.bridge
      .splice(0)
      .filter((message) => message.type === "error")
      .map((message) => message.message ?? "");
  taken();
  const click = async (x: number, y: number): Promise<ReadonlyArray<string>> => {
    for (const type of ["mouseMove", "mouseDown", "mouseUp"] as const) {
      surface.input(recorded.owner, surfaceId, {
        type,
        x,
        y,
        button: "left",
        clickCount: type === "mouseMove" ? 0 : 1,
      });
      await sleep(60);
    }
    await sleep(300);
    return taken();
  };
  const results = {
    viewport,
    target: await click(260, 660),
    decoy: await click(50, 50),
    frames: recorded.frames.count,
    frameSize: [recorded.frames.width, recorded.frames.height],
    decoyColour: recorded.colourAt(50, 50, recorded.frames.width / viewport.width),
    targetColour: recorded.colourAt(260, 660, recorded.frames.width / viewport.width),
  };
  surface.stop();
  finish({ mode, pointer: results });
}

async function containedRun(): Promise<never> {
  const surface = surfaceFor();
  const recorded = recordingOwner();
  const prepared = await surface.prepare(recorded.owner);
  if (prepared.status !== "ready") finish({ mode, prepared });
  // The renderer is not trusted to choose what the host shows: anything but
  // a ticketed design page on this host is refused.
  const refused: Array<string> = [];
  for (const src of [
    `${beaconUrl}/renderer-chosen`,
    `${serverUrl}/api/not-the-design-page`,
    "https://example.com/",
  ]) {
    const result = await surface.open(recorded.owner, {
      surfaceId: randomUUID(),
      src,
      width: 375,
      height: 667,
      scaleFactor: 1,
    });
    if (result.status === "refused") refused.push(src);
  }
  const surfaceId = randomUUID();
  const opened = await surface.open(recorded.owner, {
    surfaceId,
    src: await ticketUrl(),
    width: 375,
    height: 667,
    scaleFactor: 1,
  });
  if (opened.status !== "open") finish({ mode, prepared, opened });
  await sleep(watchMs);
  // The reserved shortcut and a plain Escape, sent as a person's keys would
  // be. The page listens for both and reports what it saw.
  const reserved = process.platform === "darwin" ? "meta" : "control";
  surface.input(recorded.owner, surfaceId, { type: "focus" });
  surface.input(recorded.owner, surfaceId, {
    type: "keyDown",
    keyCode: "Escape",
    modifiers: [reserved],
  });
  surface.input(recorded.owner, surfaceId, { type: "keyDown", keyCode: "Escape", modifiers: [] });
  await sleep(500);
  // The host leaves when its channel closes, and writes out its network log.
  surface.stop();
  await sleep(2000);
  finish({
    mode,
    prepared,
    refusals: { refusedAddresses: refused.length, opened: opened.status },
    painted: recorded.frames.count,
    bridge: {
      heartbeats: recorded.bridge.filter((message) => message.type === "heartbeat").length,
      sizes: recorded.bridge
        .filter((message) => message.type === "size")
        .map((message) => message.height),
      attempts: recorded.bridge
        .filter((message) => message.type === "error")
        .map((message) => message.message),
    },
    ...(() => {
      const reading = resolvedCanaries(hostLogPath, new URL(beaconUrl).host);
      return {
        dnsLookups: reading.lookups,
        namesInLog: reading.mentioned,
        logEvents: reading.events,
        beaconInLog: reading.sawAddress,
      };
    })(),
  });
}

async function uncontainedRun(): Promise<ReadonlyArray<BridgeRecord>> {
  const window = new BrowserWindow({
    show: false,
    width: 800,
    height: 900,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // What the renderer set before prototypes left the window.
  window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  await window.loadURL("data:text/html,<!doctype html><title>host</title><body></body>");
  const url = await ticketUrl();
  await window.webContents.executeJavaScript(`
    window.__bridge = [];
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.src = ${JSON.stringify(url)};
    addEventListener("message", (event) => { if (event.source === frame.contentWindow) window.__bridge.push(event.data); });
    document.body.append(frame);
    0`);
  await sleep(watchMs);
  return (await window.webContents.executeJavaScript(
    "window.__bridge",
  )) as ReadonlyArray<BridgeRecord>;
}

app.whenReady().then(async () => {
  if (mode === "contained-pointer") await pointerRun();
  if (contained) await containedRun();
  // The control runs in this process, so its lookups are in this process's log.
  const logPath = join(app.getPath("userData"), "net.json");
  await netLog.startLogging(logPath, { captureMode: "everything" });
  const bridge = await uncontainedRun();
  await netLog.stopLogging();
  finish({
    mode,
    bridge: {
      heartbeats: bridge.filter((message) => message.type === "heartbeat").length,
      sizes: bridge.filter((message) => message.type === "size").map((message) => message.height),
      attempts: bridge
        .filter((message) => message.type === "error")
        .map((message) => message.message),
    },
    ...(() => {
      const reading = resolvedCanaries(logPath, new URL(beaconUrl).host);
      return {
        dnsLookups: reading.lookups,
        namesInLog: reading.mentioned,
        logEvents: reading.events,
        beaconInLog: reading.sawAddress,
      };
    })(),
  });
});
