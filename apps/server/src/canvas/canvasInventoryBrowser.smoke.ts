// Canvas inventory browser evidence smoke.
//
// Exercises ProjectCanvasInventory search/open, canvas workspace tab focus,
// close, reload restore, and unavailable placeholder rendering in real Chromium
// through the Vite dev server. Browser-first evidence; packaged Electron parity
// remains a named residual.
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
  const harnessUrl = `http://localhost:${port}/canvas-inventory-browser-evidence.html`;
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

  await page.goto(harnessUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-canvas-inventory-evidence="inventory"]');

  const inventory = page.locator('[data-canvas-inventory-evidence="inventory"]');
  results.inventoryLoaded =
    (await inventory.getByRole("heading", { name: "Canvases" }).count()) === 1;
  results.inventoryListsRows =
    (await inventory.getByText("Quarterly summary").count()) === 1 &&
    (await inventory.getByText("Product roadmap").count()) === 1;

  await inventory.getByRole("textbox", { name: "Search canvases" }).fill("roadmap");
  await page.waitForFunction(() => {
    const inventorySection = document.querySelector('[data-canvas-inventory-evidence="inventory"]');
    return (
      inventorySection?.textContent?.includes("Product roadmap") === true &&
      inventorySection.textContent.includes("Quarterly summary") === false
    );
  });
  results.searchFiltersRows =
    (await inventory.getByText("Product roadmap").count()) === 1 &&
    (await inventory.getByText("Quarterly summary").count()) === 0;

  await inventory.getByRole("textbox", { name: "Search canvases" }).fill("");
  await page.waitForFunction(() => {
    const inventorySection = document.querySelector('[data-canvas-inventory-evidence="inventory"]');
    return inventorySection?.textContent?.includes("Quarterly summary") === true;
  });

  await inventory
    .locator("li", { hasText: "Quarterly summary" })
    .getByRole("button", { name: "Open" })
    .click();
  await page.waitForSelector('[data-canvas-tab-id="11111111-1111-4111-8111-111111111111"]');
  results.openCreatesTab =
    (await page.locator('[data-canvas-tab-id="11111111-1111-4111-8111-111111111111"]').count()) ===
    1;
  await page.waitForSelector('article.canvas-view h1:has-text("Signed Q3 report")');
  results.canvasViewMounted =
    (await page.locator('article.canvas-view h1:has-text("Signed Q3 report")').count()) === 1;

  await inventory
    .locator("li", { hasText: "Quarterly summary" })
    .getByRole("button", { name: "Open" })
    .click();
  results.repeatOpenFocusesExistingTab =
    (await page.locator('[data-canvas-tab-id="11111111-1111-4111-8111-111111111111"]').count()) ===
    1;

  await page.locator('[data-canvas-inventory-evidence="close-active"]').click();
  results.closeRemovesTab =
    (await page.locator('[data-canvas-tab-id="11111111-1111-4111-8111-111111111111"]').count()) ===
    0;
  results.workspaceClearedAfterClose =
    (await page.locator('[data-canvas-inventory-evidence="empty"]').count()) === 1;

  await inventory
    .locator("li", { hasText: "Quarterly summary" })
    .getByRole("button", { name: "Open" })
    .click();
  await page.waitForSelector('[data-canvas-tab-id="11111111-1111-4111-8111-111111111111"]');
  const tabTitleBeforeReload = await page
    .locator('[data-canvas-tab-id="11111111-1111-4111-8111-111111111111"]')
    .textContent();
  await page.locator('[data-canvas-inventory-evidence="reload"]').click();
  await page.waitForSelector('article.canvas-view h1:has-text("Signed Q3 report")');
  const tabTitleAfterReload = await page
    .locator('[data-canvas-tab-id="11111111-1111-4111-8111-111111111111"]')
    .textContent();
  results.reloadPreservesTabIdentity =
    tabTitleBeforeReload === "Quarterly summary" && tabTitleAfterReload === "Quarterly summary";

  const unavailable = page.locator('[data-canvas-inventory-evidence="unavailable"]');
  results.unavailablePlaceholder =
    (await unavailable.getByText("Canvas unavailable").count()) === 1 &&
    (await unavailable.getByText("Canvas is no longer available in this Project.").count()) === 1;

  const evidenceDir = join(repoRoot, ".canvas-inventory-browser-evidence");
  await Bun.$`mkdir -p ${evidenceDir}`.quiet();
  const screenshotPath = join(evidenceDir, "canvas-inventory.png");
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
