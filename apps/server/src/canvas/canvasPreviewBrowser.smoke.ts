// Canvas preview browser evidence smoke.
//
// Screenshots a real Canvas through the host's headless Chromium, from the built
// web app's Canvas preview page, and writes the PNG the preview operation would
// return, so the picture is inspected rather than trusted. A second look draws
// designs: it checks that a static frame's overflow and faint text are
// measured, that a running prototype runs and its error is read, and that the
// prototype's fetch, XHR, WebSocket, image, self-navigation, and WebRTC reach
// nothing on this machine. Needs the web app
// built (`bun run build` in apps/web). Exits non-zero with an explanatory status
// when no Chromium executable is found, the same way the other Canvas browser
// smokes do.

import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeCanvasDefinition } from "@octant/contracts/canvas";
import { createSocket } from "node:dgram";
import { createServer, type AddressInfo } from "node:net";
import { renderCanvasDesignPage } from "./canvasDesignPage";
import { createPlaywrightCanvasPreviewRenderer } from "./canvasPreviewRenderer";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../../../");

const definition = decodeCanvasDefinition({
  schemaVersion: 7,
  title: "Signed Q3 report",
  provenance: {
    hostId: "host-1",
    projectId: "22222222-2222-4222-8222-222222222222",
    mode: "chat",
    threadId: "33333333-3333-4333-8333-333333333333",
    actor: { kind: "agent", actorId: "44444444-4444-4444-8444-444444444444" },
    providerInstanceId: "55555555-5555-4555-8555-555555555555",
    modelId: "model",
    createdAt: "2026-10-07T00:00:00.000Z",
  },
  sourceManifest: [],
  blocks: [
    {
      blockId: "overview",
      schemaVersion: 1,
      kind: "heading",
      level: 2,
      text: "Q3 Overview",
    },
    {
      blockId: "revenue",
      schemaVersion: 1,
      kind: "chart",
      chartType: "grouped-bar",
      series: [
        {
          seriesId: "this-year",
          label: "This year",
          points: [
            { x: "Jul", y: 1_240 },
            { x: "Aug", y: 1_460 },
            { x: "Sep", y: 1_690 },
          ],
        },
        {
          seriesId: "last-year",
          label: "Last year",
          points: [
            { x: "Jul", y: 1_010 },
            { x: "Aug", y: 1_120 },
            { x: "Sep", y: 1_330 },
          ],
        },
      ],
    },
    {
      blockId: "shipped",
      schemaVersion: 1,
      kind: "metric",
      label: "Shipped",
      value: 12_345,
      goodDirection: "up",
    },
  ],
});

function pngSize(png: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  // PNG: 8-byte signature, then a length/type IHDR chunk whose payload starts
  // with the width and height as big-endian uint32 at byte offset 16.
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 24 || signature.some((byte, index) => png[index] !== byte)) return undefined;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const renderer = createPlaywrightCanvasPreviewRenderer({
  webAssetsPath: join(repoRoot, "apps/web/dist"),
});
if (!(await renderer.available())) {
  console.error(
    JSON.stringify({ status: "skipped", reason: "no supported Chromium executable was found" }),
  );
  process.exit(2);
}

const width = 760;
const rendered = await renderer.render({
  definition,
  width,
  theme: "light",
  placement: "document",
});

if (rendered.kind !== "rendered") {
  console.error(JSON.stringify({ status: "failed", reason: rendered.reason }));
  process.exit(1);
}

// A second look, at designs: a static screen that overflows and has faint
// text, and a running prototype that throws and then tries every way out.
// Listeners on this machine record anything that arrives, over HTTP, raw TCP,
// or UDP, because WebRTC is the one channel request interception cannot see.
const arrivals: string[] = [];
const beacon = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(incoming, server) {
    arrivals.push(`http ${new URL(incoming.url).pathname}`);
    if (server.upgrade(incoming)) return undefined;
    return new Response("beacon", { headers: { "access-control-allow-origin": "*" } });
  },
  websocket: { message() {} },
});
const tcp = createServer((socket) => {
  arrivals.push("tcp connection");
  socket.destroy();
});
await new Promise<void>((done) => tcp.listen(0, "127.0.0.1", done));
const tcpPort = (tcp.address() as AddressInfo).port;
const udp = createSocket("udp4");
udp.on("message", () => arrivals.push("udp datagram"));
await new Promise<void>((done) => udp.bind(0, "127.0.0.1", done));
const udpPort = udp.address().port;
const beaconOrigin = `http://127.0.0.1:${String(beacon.port)}`;

/**
 * A string as script source inside a page: JSON, with every character that
 * could end the script element or a line written as an escape.
 */
function inScript(value: string): string {
  return JSON.stringify(value).replace(
    /[<>/\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

const hostile = `
fetch(${inScript(`${beaconOrigin}/fetch`)}).catch(() => undefined);
try { const x = new XMLHttpRequest(); x.open("GET", ${inScript(`${beaconOrigin}/xhr`)}); x.send(); } catch (_) {}
try { new WebSocket(${inScript(`ws://127.0.0.1:${String(beacon.port)}/ws`)}); } catch (_) {}
new Image().src = ${inScript(`${beaconOrigin}/image`)};
try {
  const peer = new RTCPeerConnection({ iceServers: [
    { urls: "stun:127.0.0.1:${String(udpPort)}" },
    { urls: "turn:127.0.0.1:${String(tcpPort)}?transport=tcp", username: "u", credential: "p" },
    { urls: "turn:127.0.0.1:${String(udpPort)}?transport=udp", username: "u", credential: "p" },
  ] });
  peer.createDataChannel("out");
  peer.createOffer().then((offer) => peer.setLocalDescription(offer)).catch(() => undefined);
} catch (_) {}
setTimeout(() => { location.href = ${inScript(`${beaconOrigin}/self-navigation`)}; }, 300);
missingFunction();
`;
const designs = decodeCanvasDefinition({
  ...definition,
  schemaVersion: 18,
  blocks: [
    {
      blockId: "static-screen",
      schemaVersion: 18,
      kind: "design",
      title: "Static screen",
      size: "phone",
      styles:
        "body { margin: 0; background: #ffffff; } .wide { width: 900px; } .faint { color: #cccccc; }",
      frames: [
        {
          frameId: "home",
          title: "Home",
          html: '<div class="wide">A row wider than the phone.</div><p class="faint">Fine print nobody can read.</p>',
        },
      ],
    },
    {
      blockId: "prototype",
      schemaVersion: 18,
      kind: "design",
      title: "Prototype",
      size: "phone",
      runsScript: true,
      frames: [
        { frameId: "start", title: "Start", html: `<p>prototype</p><script>${hostile}</script>` },
      ],
    },
  ],
});
const prototype = designs.blocks.find((block) => String(block.blockId) === "prototype");
if (prototype?.kind !== "design") throw new Error("Fixture is not a design.");
const looked = await renderer.render({
  definition: designs,
  width,
  theme: "light",
  placement: "document",
  designPages: [{ blockId: "prototype", html: renderCanvasDesignPage(prototype, "start", []) }],
});
// Give a connection that got out time to arrive before the listeners close.
await new Promise((done) => setTimeout(done, 500));
beacon.stop(true);
tcp.close();
udp.close();
if (looked.kind !== "rendered") {
  console.error(JSON.stringify({ status: "failed", reason: `designs: ${looked.reason}` }));
  process.exit(1);
}
const screen = looked.designs.find((design) => design.blockId === "static-screen");
const ran = looked.designs.find((design) => design.blockId === "prototype");

const evidenceDir = join(repoRoot, ".canvas-preview-browser-evidence");
await Bun.$`mkdir -p ${evidenceDir}`.quiet();
const pngPath = join(evidenceDir, "canvas-preview.png");
await Bun.write(pngPath, rendered.png);

const size = pngSize(rendered.png);
const results = {
  pngHasSignature: size !== undefined,
  pngMatchesRequestedWidth: size?.width === width,
  pngMatchesReportedHeight: size?.height === rendered.height,
  pngWithinImageCeiling: (size?.width ?? Number.POSITIVE_INFINITY) <= 1_600,
  // A drawn document with a heading, a chart, and a metric is far taller than
  // an empty page's padding.
  pageDrewTheDocument: rendered.height > 200,
  // The static screen is 390px wide and holds a 900px row and #cccccc text.
  staticFrameOverflowMeasured:
    screen?.overflow[0]?.frameId === "home" && (screen.overflow[0]?.overflowPx ?? 0) >= 500,
  staticFrameFaintTextMeasured:
    screen?.contrast[0]?.foreground === "#cccccc" && screen.contrast[0]?.target === 4.5,
  prototypeRanAndReportedItsError:
    ran?.scriptErrors.some((message) => message.includes("missingFunction")) === true,
  nothingLeftThePreviewBrowser: arrivals.length === 0,
};
const failed = Object.entries(results).filter(([, ok]) => !ok);
console.log(
  JSON.stringify(
    {
      status: failed.length === 0 ? "passed" : "failed",
      pngPath,
      bytes: rendered.png.byteLength,
      size,
      designs: looked.designs,
      arrivals,
      assertions: results,
      failures: failed.map(([name]) => name),
    },
    null,
    2,
  ),
);
process.exit(failed.length === 0 ? 0 : 1);
