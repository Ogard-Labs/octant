// Exported Canvas prototype hostile smoke.
//
// Writes an HTML export of a Canvas holding a hostile running prototype to a
// file and opens that file in a real Chromium, the way a recipient would: no
// host, no interception, and a listener on this machine that records anything
// that arrives. The prototype must run, and its fetch, XHR, WebSocket, image
// beacon, form submit, popup, top navigation, and self-navigation must reach
// nothing.
//
// WebRTC is not covered by a page's policy and an exported file is opened in
// the recipient's own browser, so it is not asserted here; the frame threat
// model records it as a residual.
//
// Run: bun apps/server/src/canvas/canvasExportFrameBrowser.smoke.ts
// Exits 2 with an explanation if no Chromium executable is found.

import { constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { decodeCanvasBlock } from "@octant/contracts/canvas";
import { DEFAULT_BROWSER_EXECUTABLE_CANDIDATES } from "../browser/playwrightBrowserRuntime";
import { renderArtifactHtml } from "./artifactDocumentRender";

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

const executable = await findChromium();
if (executable === undefined) {
  console.error(
    JSON.stringify({ status: "skipped", reason: "no supported Chromium executable was found" }),
  );
  process.exit(2);
}

const arrivals: string[] = [];
const beacon = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    arrivals.push(new URL(request.url).pathname);
    if (server.upgrade(request)) return undefined;
    return new Response("<p>arrived</p>", {
      headers: { "content-type": "text/html", "access-control-allow-origin": "*" },
    });
  },
  websocket: { message() {} },
});
const origin = `http://127.0.0.1:${String(beacon.port)}`;

const hostile = `
document.getElementById("marker").textContent = "ran";
fetch(${JSON.stringify(`${origin}/fetch`)}).catch(() => undefined);
try { const x = new XMLHttpRequest(); x.open("GET", ${JSON.stringify(`${origin}/xhr`)}); x.send(); } catch (_) {}
try { new WebSocket(${JSON.stringify(`ws://127.0.0.1:${String(beacon.port)}/ws`)}); } catch (_) {}
new Image().src = ${JSON.stringify(`${origin}/image`)};
try { window.open(${JSON.stringify(`${origin}/popup`)}); } catch (_) {}
try { top.location.href = ${JSON.stringify(`${origin}/top`)}; } catch (_) {}
try {
  const form = document.createElement("form");
  form.action = ${JSON.stringify(`${origin}/form`)}; form.method = "post";
  document.body.appendChild(form); form.submit();
} catch (_) {}
setTimeout(() => { location.href = ${JSON.stringify(`${origin}/self-navigation`)}; }, 300);
`;
const prototype = decodeCanvasBlock({
  blockId: "hostile",
  schemaVersion: 18,
  kind: "design",
  title: "Hostile",
  size: "phone",
  runsScript: true,
  frames: [
    {
      frameId: "start",
      title: "Start",
      html: `<p id="marker">static</p><script>${hostile}</script>`,
    },
  ],
});
const rendered = renderArtifactHtml(
  { title: "Exported prototype", blocks: [prototype] },
  { frames: "as-written" },
);
if (rendered.kind !== "rendered") {
  console.error(JSON.stringify({ status: "failed", reason: "the export did not render" }));
  process.exit(1);
}

const directory = mkdtempSync(join(tmpdir(), "octant-export-frame-smoke-"));
const file = join(directory, "export.html");
writeFileSync(file, rendered.body);
const browser = await chromium.launch({ executablePath: executable, headless: true });
let marker = "unread";
let stillThere = "unread";
try {
  const page = await browser.newPage();
  await page.goto(`file://${file}`);
  await page.waitForTimeout(150);
  const frame = page.frames()[1];
  marker = (await frame?.evaluate(() => document.getElementById("marker")?.textContent)) ?? "none";
  // Past the self-navigation, and long enough for a request to arrive.
  await page.waitForTimeout(1_200);
  stillThere = await page.title();
} finally {
  await browser.close();
  beacon.stop(true);
  rmSync(directory, { recursive: true, force: true });
}

const results = {
  prototypeRan: marker === "ran",
  documentStillOpen: stillThere === "Exported prototype",
  nothingReachedTheListener: arrivals.length === 0,
};
const failed = Object.entries(results).filter(([, ok]) => !ok);
console.log(
  JSON.stringify(
    {
      status: failed.length === 0 ? "passed" : "failed",
      arrivals,
      assertions: results,
      failures: failed.map(([name]) => name),
    },
    null,
    2,
  ),
);
process.exit(failed.length === 0 ? 0 : 1);
