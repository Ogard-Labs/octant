// Canvas renderer browser evidence smoke.
//
// Renders the first-party Canvas renderer in a real Chromium through the Vite
// dev server and asserts safe-render, accessibility roles, and fail-closed
// behavior. This is browser-level evidence for the shared renderer: it is not
// a substitute for Electron parity (the macOS/Electron boundary is unavailable
// in this container and is reported as a named residual).
//
// Skips with a non-zero explanatory exit if no Chromium executable is found.

import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { DEFAULT_BROWSER_EXECUTABLE_CANDIDATES } from "../browser/playwrightBrowserRuntime";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../../../");
const webDir = join(repoRoot, "apps/web");

function pickPort(): number {
  return 20000 + Math.floor(Math.random() * 40000);
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Vite dev server did not become ready at ${url}`);
}

async function findChromium(): Promise<string | undefined> {
  const candidates = [
    ...(process.env.OCTANT_BROWSER_EXECUTABLE === undefined
      ? []
      : [process.env.OCTANT_BROWSER_EXECUTABLE]),
    ...DEFAULT_BROWSER_EXECUTABLE_CANDIDATES,
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

const results: Record<string, boolean> = {};
let serverProcess: ReturnType<typeof Bun.spawn> | undefined;
let exitCode = 1;

try {
  const executable = await findChromium();
  if (executable !== undefined) {
    await run(executable);
  } else {
    console.error(
      JSON.stringify({
        status: "skipped",
        reason: "no supported Chromium executable was found",
      }),
    );
    exitCode = 2;
  }
} finally {
  serverProcess?.kill();
}
process.exit(exitCode);

async function run(executable: string): Promise<void> {
  const port = pickPort();
  const harnessUrl = `http://localhost:${port}/canvas-browser-evidence.html`;
  serverProcess = Bun.spawn(
    [process.execPath, "run", "dev", "--", "--port", String(port), "--strictPort"],
    {
      cwd: webDir,
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  await waitForServer(harnessUrl, 30_000);

  const browser = await chromium.launch({ executablePath: executable, headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);

  const networkRequests: string[] = [];
  page.on("request", (request) => networkRequests.push(request.url()));

  await page.goto(harnessUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-canvas-evidence="safe"] article.canvas-view');

  const safe = page.locator('[data-canvas-evidence="safe"] article.canvas-view');
  results.safeArticleRendered = (await safe.count()) === 1;
  results.safeArticleLabel = (await safe.getAttribute("aria-label")) === "Signed Q3 report";
  results.safeHeading = (await safe.locator('h1:has-text("Signed Q3 report")').count()) === 1;
  results.blockHeading = (await page.getByRole("heading", { name: "Q3 Overview" }).count()) === 1;
  results.richText =
    (await safe.locator("p:has-text('Shipment volumes grew this quarter.')").count()) === 1;
  results.keyValueRows =
    (await safe.locator("dl dt:has-text('Mode')").count()) === 1 &&
    (await safe.locator("dl dd:has-text('Chat')").count()) === 1;
  results.tableRendered =
    (await safe.locator("table thead th").count()) === 2 &&
    (await safe.locator("table tbody td").count()) === 4;
  results.safeLinkAllowed =
    (await safe.locator('a[href="https://reports.octant.example/q3"]').count()) === 1;
  results.codeRendered = (await safe.locator("pre:has-text('const safe = true;')").count()) === 1;
  results.imagePlaceholder =
    (await safe.locator('[role="img"][aria-label="A bounded diagram"]').count()) === 1;
  results.headingRoles = (await page.getByRole("heading").count()) >= 2;
  results.noRemoteAssets = !networkRequests.some(
    (url) => new URL(url).origin !== new URL(harnessUrl).origin,
  );

  const unsafe = page.locator('[data-canvas-evidence="unsafe"]');
  results.unsafeDenied =
    (await unsafe.locator('[role="alert"]:has-text("Unable to render canvas")').count()) === 1;
  results.noUnsafeLinkRendered = (await unsafe.locator('a[href^="javascript:"]').count()) === 0;
  results.noUnsafeTitle = (await unsafe.locator(':text("Signed Q3 report")').count()) === 0;

  const hostile = page.locator('[data-canvas-evidence="hostile-text"]');
  results.hostileTextEscaped =
    (await hostile.locator("img").count()) === 0 &&
    (await hostile.locator("script").count()) === 0 &&
    (await hostile.locator(":text('<img src=x onerror')").count()) === 1;

  const hostileMarkerInScripts = await page.evaluate(() =>
    [...document.querySelectorAll("script")].some((node) =>
      (node.textContent ?? node.getAttribute("src") ?? "").includes("__pwned"),
    ),
  );
  const onErrorAttributes = await page.locator("[onerror]").count();
  results.noExecutableContentInjected = !hostileMarkerInScripts && onErrorAttributes === 0;
  results.noPwned = await page.evaluate(
    () => (window as unknown as { __pwned?: number }).__pwned === undefined,
  );

  const evidenceDir = join(repoRoot, ".canvas-browser-evidence");
  await Bun.$`mkdir -p ${evidenceDir}`.quiet();
  const screenshotPath = join(evidenceDir, "canvas-renderer.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const failed = Object.entries(results).filter(([, ok]) => !ok);
  console.log(
    JSON.stringify(
      {
        status: failed.length === 0 ? "passed" : "failed",
        screenshotPath,
        assertions: results,
        failures: failed.map(([name]) => name),
      },
      null,
      2,
    ),
  );
  exitCode = failed.length === 0 ? 0 : 1;
  await browser.close();
}
