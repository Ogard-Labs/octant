// Canvas "Allow network" browser smoke.
//
// Serves a running design whose Canvas has the switch on through the real page
// and proxy routes, and draws it in a real Chromium the way the renderer does:
// a frame sandboxed to `allow-scripts` alone. The page asks for everything the
// switch must and must not give it:
//
// - a fetch of a public address, a JSON POST to one, an image, a stylesheet's
//   background image, and a font, which must arrive through the proxy, the
//   POST with the host's headers alone;
// - a POST that is not JSON, another method, markup asked for as an image,
//   which the host's script or the route must refuse;
// - another path on the host, another token's proxy path, a listener on
//   another port, an image elsewhere, a WebSocket (elsewhere and at the
//   page's own proxy path), media, and an XHR elsewhere, which the page's
//   policy must refuse before anything is sent;
// - loopback and a cloud metadata address through the proxy, which the
//   destination rule must refuse;
// - cookies, storage, and the parent's document, which the unchanged sandbox
//   must still refuse.
//
// Then the switch goes off and the same page asks again.
//
// The far side of the proxy is a stand-in transport, so nothing leaves the
// machine: this is evidence for the browser's enforcement of the page policy
// and for the route, not for the transport (see canvasNetworkProxy.test.ts).
//
// Run: bun apps/server/src/canvas/canvasNetworkBrowser.smoke.ts
// Exits 2 with an explanation if no Chromium executable is found.

import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import { chromium } from "playwright-core";
import {
  decodeCanvasBlock,
  decodeCanvasId,
  type CanvasDesignBlock,
  type CanvasProvenance,
} from "@octant/contracts/canvas";
import { DEFAULT_BROWSER_EXECUTABLE_CANDIDATES } from "../browser/playwrightBrowserRuntime";
import { createCanvasRouteHandler } from "../canvasRoutes";
import { CanvasDesignRunTickets, canvasDesignPagePath } from "./canvasDesignPage";
import { CanvasNetworkAccessService } from "./canvasNetworkAccessService";
import { CanvasNetworkProxy } from "./canvasNetworkProxy";

const results: Record<string, unknown> = {};
const step = (name: string) => console.error(`smoke: ${name}`);
// A hung page must not hang the smoke.
setTimeout(() => {
  console.error(JSON.stringify({ status: "timed-out", results }));
  process.exit(1);
}, 60_000).unref();

const canvasId = decodeCanvasId("22222222-2222-4222-8222-222222222222");
const beaconHits: Array<string> = [];
const hostHits: Array<string> = [];
const proxied: Array<{
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly body?: string;
}> = [];
// A real font and a real image, so the browser draws what the proxy passed on.
const FONT = await readFile(
  createRequire(import.meta.url).resolve("katex/dist/fonts/KaTeX_Size2-Regular.woff2"),
);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function findChromium(): Promise<string | undefined> {
  for (const candidate of DEFAULT_BROWSER_EXECUTABLE_CANDIDATES) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try the next one
    }
  }
  return undefined;
}

/** A string as script source inside a page, with nothing that could end the script element. */
function inScript(value: string): string {
  return JSON.stringify(value).replace(
    /[<>/\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function askingBlock(host: string, beacon: string): CanvasDesignBlock {
  const otherToken = `${host}/api/canvas/network/${"B".repeat(43)}/fetch?url=${encodeURIComponent("https://public.example.test/other")}`;
  const script = `
const report = (name, value) => parent.postMessage({ smoke: name, value }, "*");
const attempt = async (name, ask) => {
  try { report(name, "answered:" + String(await ask())); }
  catch (error) { report(name, "refused:" + (error && error.name ? error.name : String(error))); }
};
const read = (response) => response.text().then((text) => response.status + " " + text);
report("origin", String(self.origin));
attempt("public address", () => fetch(${inScript("https://public.example.test/data?q=1")}).then(read));
attempt("JSON POST", () => fetch(${inScript("https://public.example.test/rpc")}, {
  method: "POST",
  headers: { authorization: "Bearer page-secret", "x-api-key": "page-key", "content-type": "text/plain" },
  credentials: "include",
  body: JSON.stringify({ ask: 1 }),
}).then(read));
attempt("POST that is not JSON", () => fetch(${inScript("https://public.example.test/not-json")}, { method: "POST", body: "x" }).then(read));
attempt("PUT", () => fetch(${inScript("https://public.example.test/put")}, { method: "PUT", body: "{}" }).then(read));
const drawn = (address) => new Promise((resolve, reject) => {
  const image = document.createElement("img");
  image.onload = () => resolve("loaded " + image.naturalWidth + " " + image.getAttribute("src"));
  // The address as written is refused by the page's policy first; only an
  // error of the proxied address is the answer.
  image.onerror = () => { if ((image.getAttribute("src") || "").includes("image?url=")) reject(new Error("ImageError")); };
  image.setAttribute("src", address);
  document.body.appendChild(image);
});
const own = drawn(${inScript("https://public.example.test/logo.png")});
attempt("image through the proxy", () => own.then((value) => value.split(" ").slice(0, 2).join(" ")));
attempt("markup as an image", () => drawn(${inScript("https://public.example.test/page.html")}));
attempt("font through the proxy", () => {
  const face = new FontFace("Smoke", 'url("https://public.example.test/face.woff2") format("woff2")');
  document.fonts.add(face);
  return face.load().then(() => (face instanceof FontFace) + " " + document.fonts.check('16px "Smoke"'));
});
attempt("font in a stylesheet the script adds", () => {
  const sheet = document.createElement("style");
  sheet.textContent = '@font-face { font-family: "Sheet"; src: url("https://public.example.test/sheet.woff2") format("woff2"); } .backed { background-image: url("https://public.example.test/bg.png"); }';
  document.head.appendChild(sheet);
  return new Promise((resolve) => setTimeout(resolve, 50)).then(() => document.fonts.load('16px "Sheet"')).then((faces) => faces.length + " " + document.fonts.check('16px "Sheet"'));
});
const base = own.then((value) => value.split(" ")[2].split("image?url=")[0]);
attempt("websocket at its own proxy path", () => base.then((path) => new Promise((resolve, reject) => {
  const socket = new WebSocket(path.replace("http", "ws") + "fetch?url=" + encodeURIComponent("https://public.example.test/ws"));
  socket.onopen = () => resolve("open"); socket.onerror = () => reject(new Error("WebSocketError"));
})));
attempt("media at its own proxy path", () => base.then((path) => new Promise((resolve, reject) => {
  const media = new Audio(); media.oncanplay = () => resolve("playable"); media.onerror = () => reject(new Error("MediaError"));
  media.src = path + "image?url=" + encodeURIComponent("https://public.example.test/sound.png");
})));
attempt("form POST to its own proxy path", () => base.then((path) => fetch(path + "fetch?url=" + encodeURIComponent("https://public.example.test/form"), {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=1",
}).then(read)));
attempt("another path on the host", () => fetch(${inScript(`${host}/secret`)}).then(read));
attempt("the Canvas API", () => fetch(${inScript(`${host}/api/canvas/get?canvasId=${String(canvasId)}`)}).then(read));
attempt("another token's proxy path", () => fetch(${inScript(otherToken)}).then(read));
attempt("xhr elsewhere", () => new Promise((resolve, reject) => {
  const x = new XMLHttpRequest(); x.open("GET", ${inScript(`${beacon}/xhr`)});
  x.onload = () => resolve(x.status); x.onerror = () => reject(new Error("NetworkError")); x.send();
}));
attempt("websocket", () => new Promise((resolve, reject) => {
  const socket = new WebSocket(${inScript(`${beacon.replace("http", "ws")}/ws`)});
  socket.onopen = () => resolve("open"); socket.onerror = () => reject(new Error("WebSocketError"));
}));
attempt("image", () => new Promise((resolve, reject) => {
  const image = new Image(); image.onload = () => resolve("loaded"); image.onerror = () => reject(new Error("ImageError"));
  image.src = ${inScript(`${beacon}/image`)};
}));
attempt("loopback through the proxy", () => fetch(${inScript(`${beacon}/through-proxy`)}).then(read));
attempt("localhost through the proxy", () => fetch("http://localhost/admin").then(read));
attempt("cloud metadata through the proxy", () => fetch("http://169.254.169.254/latest/meta-data/").then(read));
attempt("cookie", () => document.cookie);
attempt("localStorage", () => localStorage.length);
attempt("parent.document", () => parent.document.title);
addEventListener("message", (event) => {
  if (event.data === "ask-again") attempt("after the switch went off", () => fetch(${inScript("https://public.example.test/again")}).then(read));
});
`;
  const block = decodeCanvasBlock({
    blockId: "asking",
    schemaVersion: 18,
    kind: "design",
    title: "Asking",
    size: "phone",
    runsScript: true,
    frames: [
      {
        frameId: "start",
        title: "Start",
        html: `<p class="backed">asking</p><script>${script}</script>`,
      },
    ],
  });
  if (block.kind !== "design") throw new Error("Fixture is not a design.");
  return block;
}

const provenance = {
  mode: "chat",
  projectId: "77777777-7777-4777-8777-777777777777",
  threadId: "88888888-8888-4888-8888-888888888888",
} as unknown as CanvasProvenance;

async function run(executable: string): Promise<void> {
  const beacon = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      beaconHits.push(new URL(request.url).pathname);
      if (server.upgrade(request)) return undefined;
      return new Response("beacon", { headers: { "access-control-allow-origin": "*" } });
    },
    websocket: { message() {} },
  });
  const beaconOrigin = `http://127.0.0.1:${String(beacon.port)}`;
  const tickets = new CanvasDesignRunTickets();
  // The switch, over a journal that keeps nothing: the smoke reads no history.
  const access = new CanvasNetworkAccessService({
    journal: { append: () => [], replayAggregate: () => [] } as unknown as ConstructorParameters<
      typeof CanvasNetworkAccessService
    >[0]["journal"],
    uuid: () => crypto.randomUUID(),
    actor: { kind: "local-user", actorId: "99999999-9999-4999-8999-999999999999" } as never,
    clock: () => new Date().toISOString() as never,
  });
  access.set(canvasId, true);
  const proxy = new CanvasNetworkProxy({
    reserved: () => ({ addresses: [], hosts: [] }),
    // Only the stand-in public name resolves to a public address; every other
    // name and literal meets the real destination rule as itself.
    resolveAll: async (hostname) =>
      hostname === "public.example.test" ? ["93.184.216.34"] : [hostname],
    connect: async (url, connection) => {
      proxied.push({
        url: url.toString(),
        headers: connection.headers,
        method: connection.method,
        ...(connection.body === undefined
          ? {}
          : { body: new TextDecoder().decode(connection.body) }),
      });
      if (url.pathname.endsWith(".png")) {
        return new Response(PNG, { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.endsWith(".woff2")) {
        return new Response(FONT, { headers: { "content-type": "font/woff2" } });
      }
      return new Response(`proxied ${url.pathname}`, {
        headers: {
          "content-type": url.pathname.endsWith(".html") ? "text/html" : "text/plain",
          "set-cookie": "far=1",
        },
      });
    },
  });
  const routes = createCanvasRouteHandler({
    designRunTickets: tickets,
    resolveDesignAssets: async () => [],
    canvasNetwork: { access, proxy },
    // The proxy route refuses a token whose Canvas is gone; this one exists.
    canvasProjection: { getById: () => ({}) },
  } as unknown as Parameters<typeof createCanvasRouteHandler>[0]);
  const host = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/") {
        return new Response(
          `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="slot"></div>
<script>
window.messages = [];
addEventListener("message", (event) => {
  const frame = document.querySelector("iframe");
  if (!frame || event.source !== frame.contentWindow) return;
  const data = event.data || {};
  if (data.smoke) window.messages.push([data.smoke, data.value]);
});
window.mount = (src) => {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.src = src;
  document.getElementById("slot").replaceChildren(frame);
};
window.askAgain = () => document.querySelector("iframe").contentWindow.postMessage("ask-again", "*");
</script></body></html>`,
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "set-cookie": "octant-smoke=parent-secret; Path=/",
            },
          },
        );
      }
      const answered = await routes(request);
      if (answered !== undefined) return answered;
      // Anything else on the host stands for the rest of Octant's API. The
      // parent tab asks for its own icon; that is not the frame's request.
      if (url.pathname !== "/favicon.ico") hostHits.push(url.pathname);
      return new Response("host secret", { headers: { "access-control-allow-origin": "*" } });
    },
  });
  const hostOrigin = `http://127.0.0.1:${String(host.port)}`;
  const block = askingBlock(hostOrigin, beaconOrigin);
  const pageAddress = `${hostOrigin}${canvasDesignPagePath(
    tickets.issue({
      canvasId,
      versionId: "33333333-3333-4333-8333-333333333333" as never,
      blockId: block.blockId,
      startFrameId: "start",
      block,
      provenance,
      network: true,
    }),
  )}`;

  step("launching");
  const browser = await chromium.launch({ executablePath: executable, headless: true });
  try {
    const page = await browser.newPage();
    step("opening the parent");
    await page.goto(`${hostOrigin}/`);
    step("running the page with the network on");
    await page.evaluate(
      (src) => (window as unknown as { mount: (s: string) => void }).mount(src),
      pageAddress,
    );
    await page.waitForTimeout(2_500);
    results.withSwitchOn = Object.fromEntries(
      await page.evaluate(
        () => (window as unknown as { messages: Array<[string, string]> }).messages,
      ),
    );
    results.proxied = [...proxied];
    results.beaconHits = [...beaconHits];
    results.hostHits = [...hostHits];

    step("turning the switch off");
    access.set(canvasId, false);
    await page.evaluate(() => (window as unknown as { askAgain: () => void }).askAgain());
    await page.waitForTimeout(1_000);
    results.afterSwitchOff = Object.fromEntries(
      await page.evaluate(
        () => (window as unknown as { messages: Array<[string, string]> }).messages,
      ),
    )["after the switch went off"];
    results.proxiedAfterSwitchOff = proxied.length - (results.proxied as typeof proxied).length;
  } finally {
    await browser.close();
    host.stop(true);
    beacon.stop(true);
  }
}

let exitCode = 1;
const executable = await findChromium();
if (executable === undefined) {
  console.error(
    JSON.stringify({ status: "skipped", reason: "no supported Chromium executable was found" }),
  );
  exitCode = 2;
} else {
  await run(executable);
  const answers = results.withSwitchOn as Record<string, string>;
  const refusedByThePage = [
    "PUT",
    "markup as an image",
    "websocket at its own proxy path",
    "media at its own proxy path",
    "another path on the host",
    "the Canvas API",
    "another token's proxy path",
    "xhr elsewhere",
    "websocket",
    "image",
    "cookie",
    "localStorage",
    "parent.document",
  ];
  const refusedByTheRule = [
    "loopback through the proxy",
    "localhost through the proxy",
    "cloud metadata through the proxy",
  ];
  const sent = results.proxied as typeof proxied;
  const bare = JSON.stringify({ accept: "*/*" });
  const posts = sent.filter((request) => request.method === "POST");
  const checks = {
    opaqueOrigin: answers.origin === "null",
    publicAddressFetchedThroughTheProxy: answers["public address"] === "answered:200 proxied /data",
    jsonPostSentThroughTheProxy: answers["JSON POST"] === "answered:200 proxied /rpc",
    // The page asked with an Authorization header, an API key, credentials,
    // and its own content type; none of it went out.
    postCarriedOnlyTheHostsHeaders:
      posts.length === 1 &&
      posts[0]?.url === "https://public.example.test/rpc" &&
      posts[0]?.body === '{"ask":1}' &&
      JSON.stringify(posts[0]?.headers) ===
        JSON.stringify({ accept: "*/*", "content-type": "application/json" }),
    postThatIsNotJsonRefused:
      answers["POST that is not JSON"]?.startsWith("answered:400 ") === true &&
      answers["form POST to its own proxy path"]?.startsWith("answered:415 ") === true,
    imageDrawnThroughTheProxy: answers["image through the proxy"] === "answered:loaded 1",
    fontLoadedThroughTheProxy:
      answers["font through the proxy"] === "answered:true true" &&
      answers["font in a stylesheet the script adds"] === "answered:1 true",
    // Markup asked for as an image reached the far side and was not passed on.
    onlyThoseRequestsLeftTheHost:
      JSON.stringify(sent.map((request) => `${request.method} ${request.url}`).sort()) ===
      JSON.stringify(
        [
          "GET https://public.example.test/bg.png",
          "GET https://public.example.test/data?q=1",
          "GET https://public.example.test/face.woff2",
          "GET https://public.example.test/logo.png",
          "GET https://public.example.test/page.html",
          "GET https://public.example.test/sheet.woff2",
          "POST https://public.example.test/rpc",
        ].sort(),
      ),
    nothingButAcceptWasSent: sent
      .filter((request) => request.method === "GET")
      .every((request) => JSON.stringify(request.headers) === bare),
    everythingElseRefusedByThePage: refusedByThePage.every(
      (name) => answers[name]?.startsWith("refused:") === true,
    ),
    privateDestinationsRefusedByTheRule: refusedByTheRule.every(
      (name) => answers[name]?.startsWith("answered:403 ") === true,
    ),
    nothingReachedAnotherPort: (results.beaconHits as Array<string>).length === 0,
    nothingReachedAnotherPathOnTheHost: (results.hostHits as Array<string>).length === 0,
    switchOffRefusesTheSamePage:
      typeof results.afterSwitchOff === "string" &&
      results.afterSwitchOff.startsWith("answered:403 ") &&
      results.afterSwitchOff.includes("token-not-live"),
    nothingFetchedAfterSwitchOff: results.proxiedAfterSwitchOff === 0,
  };
  console.log(JSON.stringify({ executable, results, checks }, null, 2));
  exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
}
process.exit(exitCode);
