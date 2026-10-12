// Running Canvas prototype hostile smoke.
//
// Serves a hostile running design through the real page route and draws it
// in a real Chromium the way the renderer does: a frame sandboxed to
// `allow-scripts` alone. The page tries every channel a running frame must
// not have — fetch, XHR, WebSocket, an image beacon, top navigation,
// window.open, a form submit, cookies, storage, and the parent's document —
// and a beacon server on another port records anything that arrives. Then it
// checks a replayed ticket, an infinite loop (the parent must stay
// responsive and the heartbeat must stop), and a self-navigation, which a
// plain browser cannot cancel: that is the documented remote-browser residual,
// and the parent sees it as a second load.
//
// This is browser evidence for the page and its policy. Desktop navigation
// cancelling, the reserved shortcut, and WebRTC policy run in Electron and
// are covered by the desktop guard's tests and the Electron probe.
//
// Run: bun apps/server/src/canvas/canvasDesignPageBrowser.smoke.ts
// Exits 2 with an explanation if no Chromium executable is found.

import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { chromium, type Page } from "playwright-core";
import {
  decodeCanvasBlock,
  type CanvasDesignBlock,
  type CanvasProvenance,
} from "@octant/contracts/canvas";
import { DEFAULT_BROWSER_EXECUTABLE_CANDIDATES } from "../browser/playwrightBrowserRuntime";
import { createCanvasRouteHandler } from "../canvasRoutes";
import { CanvasDesignRunTickets, canvasDesignPagePath } from "./canvasDesignPage";

const results: Record<string, unknown> = {};
const step = (name: string) => console.error(`smoke: ${name}`);
// A hung page must not hang the smoke.
setTimeout(() => {
  console.error(JSON.stringify({ status: "timed-out", results }));
  process.exit(1);
}, 90_000).unref();
const beaconHits: Array<string> = [];

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

function hostileBlock(beacon: string, extra: string): CanvasDesignBlock {
  // The markup policy reads script text as script, so the beacon address in it
  // is not refused; the page policy and the sandbox are what refuse it.
  const script = `
const report = (name, value) => parent.postMessage({ smoke: name, value }, "*");
const refused = async (name, attempt) => {
  try { const outcome = await attempt(); report(name, "allowed:" + String(outcome)); }
  catch (error) { report(name, "refused:" + (error && error.name ? error.name : String(error))); }
};
report("origin", String(self.origin));
refused("fetch", () => fetch(${inScript(`${beacon}/fetch`)}).then((r) => r.status));
refused("xhr", () => new Promise((resolve, reject) => {
  const x = new XMLHttpRequest(); x.open("GET", ${inScript(`${beacon}/xhr`)});
  x.onload = () => resolve(x.status); x.onerror = () => reject(new Error("NetworkError")); x.send();
}));
refused("websocket", () => new Promise((resolve, reject) => {
  const socket = new WebSocket(${inScript(`${beacon.replace("http", "ws")}/ws`)});
  socket.onopen = () => resolve("open"); socket.onerror = () => reject(new Error("WebSocketError"));
}));
refused("image", () => new Promise((resolve, reject) => {
  const image = new Image(); image.onload = () => resolve("loaded"); image.onerror = () => reject(new Error("ImageError"));
  image.src = ${inScript(`${beacon}/image`)};
}));
refused("window.open", () => { const opened = window.open(${inScript(`${beacon}/popup`)}); if (opened === null) throw new Error("NoWindow"); return "window"; });
refused("top navigation", () => { top.location.href = ${inScript(`${beacon}/top`)}; return "navigated"; });
refused("cookie", () => document.cookie);
refused("localStorage", () => localStorage.length);
refused("parent.document", () => parent.document.title);
refused("form submit", () => new Promise((resolve) => {
  const form = document.createElement("form"); form.method = "GET"; form.action = ${inScript(`${beacon}/form`)};
  document.body.appendChild(form); form.submit(); setTimeout(() => resolve("submitted, page still here"), 300);
}));
${extra}`;
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
  const routes = createCanvasRouteHandler({
    designRunTickets: tickets,
    resolveDesignAssets: async () => [],
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
window.messages = []; window.beats = 0; window.loads = 0; window.ticks = 0;
setInterval(() => window.ticks++, 50);
addEventListener("message", (event) => {
  const frame = document.querySelector("iframe");
  if (!frame || event.source !== frame.contentWindow) return;
  const data = event.data || {};
  if (data.channel === "octant-design-frame@1" && data.type === "heartbeat") window.beats++;
  else if (data.smoke) window.messages.push([data.smoke, data.value]);
});
window.mount = (src) => {
  window.messages = []; window.beats = 0; window.loads = 0;
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.addEventListener("load", () => window.loads++);
  frame.src = src;
  document.getElementById("slot").replaceChildren(frame);
};
</script></body></html>`,
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "set-cookie": "octant-smoke=parent-secret; Path=/",
            },
          },
        );
      }
      return (await routes(request)) ?? new Response("not found", { status: 404 });
    },
  });
  const hostOrigin = `http://127.0.0.1:${String(host.port)}`;
  const issue = (block: CanvasDesignBlock) =>
    `${hostOrigin}${canvasDesignPagePath(
      tickets.issue({
        canvasId: "22222222-2222-4222-8222-222222222222" as never,
        versionId: "33333333-3333-4333-8333-333333333333" as never,
        blockId: block.blockId,
        startFrameId: "start",
        block,
        provenance,
      }),
    )}`;

  step("launching");
  const browser = await chromium.launch({ executablePath: executable, headless: true });
  try {
    const page = await browser.newPage();
    step("opening the parent");
    await page.goto(`${hostOrigin}/`);
    step("running the hostile page");

    // Every refused channel.
    const hostile = issue(hostileBlock(beaconOrigin, ""));
    await page.evaluate(
      (src) => (window as unknown as { mount: (s: string) => void }).mount(src),
      hostile,
    );
    await page.waitForTimeout(2_500);
    const channels = Object.fromEntries(
      await page.evaluate(
        () => (window as unknown as { messages: Array<[string, string]> }).messages,
      ),
    );
    results.channels = channels;
    results.heartbeatsWhileRunning = await page.evaluate(
      () => (window as unknown as { beats: number }).beats,
    );
    results.loadsAfterHostile = await page.evaluate(
      () => (window as unknown as { loads: number }).loads,
    );
    results.parentCookieStillSet = (await page.context().cookies()).some(
      (cookie) => cookie.name === "octant-smoke",
    );
    results.beaconHitsAfterRefusedChannels = [...beaconHits];

    step("replaying the ticket");
    // A replayed ticket.
    const replay = await fetch(hostile, { headers: { "sec-fetch-dest": "iframe" } });
    results.replayedTicketStatus = replay.status;

    step("navigating the frame itself");
    // A self-navigation, which only the desktop can cancel.
    beaconHits.length = 0;
    await mountAndWait(
      page,
      issue(
        hostileBlock(
          beaconOrigin,
          `setTimeout(() => { location = ${inScript(`${beaconOrigin}/self?x`)}; }, 500);`,
        ),
      ),
      2_500,
    );
    results.selfNavigation = {
      loadsSeenByParent: await readNumber(page, "loads"),
      beaconHits: [...beaconHits].filter((hit) => hit === "/self"),
    };

    step("running an infinite loop");
    // An infinite loop: the parent keeps running, the heartbeat stops. A
    // browser that keeps the frame in the parent's process hangs the parent
    // instead, which is recorded rather than waited out.
    await mountAndWait(
      page,
      issue(hostileBlock(beaconOrigin, "setTimeout(() => { for (;;) {} }, 500);")),
      1_000,
    );
    const beatsAtLoop = await within(readNumber(page, "beats"));
    const ticksAtLoop = await within(readNumber(page, "ticks"));
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const beatsAfter = await within(readNumber(page, "beats"));
    const ticksAfter = await within(readNumber(page, "ticks"));
    results.infiniteLoop =
      beatsAtLoop === undefined ||
      ticksAtLoop === undefined ||
      beatsAfter === undefined ||
      ticksAfter === undefined
        ? { parentHung: true }
        : {
            parentHung: false,
            heartbeatsDuringLoop: beatsAfter - beatsAtLoop,
            parentTicksDuringLoop: ticksAfter - ticksAtLoop,
          };
    if ((results.infiniteLoop as { parentHung: boolean }).parentHung) return;

    // The watchdog removes a looping frame. Recorded: whether a prototype run
    // again afterwards loads while the looping page's process still spins.
    await page.evaluate(() => document.getElementById("slot")?.replaceChildren());
    await mountAndWait(page, issue(hostileBlock(beaconOrigin, "")), 3_000);
    results.runAgainAfterLoop = {
      loads: await readNumber(page, "loads"),
      heartbeats: await readNumber(page, "beats"),
    };
    // A browser groups sandboxed frames of one site into one process, so the
    // spinning page can hold the next one. Recorded: whether a reload or a new
    // tab gets past it.
    await page.reload();
    await mountAndWait(page, issue(hostileBlock(beaconOrigin, "")), 3_000);
    results.runAgainAfterReload = {
      loads: await readNumber(page, "loads"),
      heartbeats: await readNumber(page, "beats"),
    };
    await page.close();
    const fresh = await browser.newPage();
    await fresh.goto(`${hostOrigin}/`);
    await mountAndWait(fresh, issue(hostileBlock(beaconOrigin, "")), 3_000);
    results.runAgainInNewTab = {
      loads: await readNumber(fresh, "loads"),
      heartbeats: await readNumber(fresh, "beats"),
    };
  } finally {
    await browser.close();
    host.stop(true);
    beacon.stop(true);
  }
}

async function mountAndWait(page: Page, src: string, ms: number): Promise<void> {
  await page.evaluate(
    (frameSource) => (window as unknown as { mount: (s: string) => void }).mount(frameSource),
    src,
  );
  await page.waitForTimeout(ms);
}

async function within<T>(promise: Promise<T>): Promise<T | undefined> {
  return await Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2_000)),
  ]);
}

async function readNumber(page: Page, name: string): Promise<number> {
  return await page.evaluate(
    (key) => Number((window as unknown as Record<string, unknown>)[key]),
    name,
  );
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
  const channels = results.channels as Record<string, string>;
  const refusedChannels = [
    "fetch",
    "xhr",
    "websocket",
    "image",
    "window.open",
    "top navigation",
    "cookie",
    "localStorage",
    "parent.document",
  ];
  const loop = results.infiniteLoop as {
    parentHung: boolean;
    heartbeatsDuringLoop?: number;
    parentTicksDuringLoop?: number;
  };
  const checks = {
    opaqueOrigin: channels.origin === "null",
    everyChannelRefused: refusedChannels.every(
      (name) => channels[name]?.startsWith("refused:") === true,
    ),
    formSubmitSentNothing: !(results.beaconHitsAfterRefusedChannels as Array<string>).includes(
      "/form",
    ),
    nothingReachedTheBeacon: (results.beaconHitsAfterRefusedChannels as Array<string>).length === 0,
    heartbeatArrived: (results.heartbeatsWhileRunning as number) > 0,
    oneLoadOnly: results.loadsAfterHostile === 1,
    replayRefused: results.replayedTicketStatus === 403,
    loopStoppedHeartbeat: loop.heartbeatsDuringLoop === 0,
    parentStayedResponsive: !loop.parentHung && (loop.parentTicksDuringLoop ?? 0) > 20,
    selfNavigationSeenAsSecondLoad:
      (results.selfNavigation as { loadsSeenByParent: number } | undefined)?.loadsSeenByParent ===
      2,
  };
  // What a plain browser cannot do, recorded rather than required: cancel a
  // self-navigation, and start a new frame from the host while a looping
  // page's process still spins.
  const residuals = {
    selfNavigationReachedNetwork:
      ((results.selfNavigation as { beaconHits: Array<string> } | undefined)?.beaconHits.length ??
        0) > 0,
    runAgainAfterLoop: results.runAgainAfterLoop,
    runAgainAfterReload: results.runAgainAfterReload,
    runAgainInNewTab: results.runAgainInNewTab,
  };
  console.log(JSON.stringify({ executable, results, checks, residuals }, null, 2));
  exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
}
process.exit(exitCode);
