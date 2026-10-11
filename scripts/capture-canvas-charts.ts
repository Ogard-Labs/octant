// Rendered QA capture for the shared Canvas data-visualisation style.
//
// Renders `apps/web/chart-visuals-evidence.html` in a real headless Chromium
// and writes one full-page PNG per theme scenario into
// `.canvas-browser-evidence/`. The harness page exercises every chart kind
// beside a metric, a table, and a timeline; this script only sets the theme
// and captures. It skips with a non-zero exit when no Chromium is available.

import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { chromium } from "playwright-core";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const webDir = join(repoRoot, "apps/web");

/** Same executables the app's browser runtime accepts, plus the Playwright cache. */
const CHROMIUM_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

type Scenario = "default-light" | "default-dark" | "vivid" | "contrast" | "forced";
const SCENARIOS: ReadonlyArray<Scenario> = [
  "default-light",
  "default-dark",
  "vivid",
  "contrast",
  "forced",
];

const PLAYWRIGHT_CHROMIUM_CANDIDATES = [
  join(
    homedir(),
    "Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  ),
  join(homedir(), ".cache/ms-playwright/chromium-1148/chrome-linux/chrome"),
];

async function findChromium(): Promise<string | undefined> {
  const candidates = [
    ...(process.env.OCTANT_BROWSER_EXECUTABLE === undefined
      ? []
      : [process.env.OCTANT_BROWSER_EXECUTABLE]),
    ...PLAYWRIGHT_CHROMIUM_CANDIDATES,
    ...CHROMIUM_CANDIDATES,
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

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

const executable = await findChromium();
if (executable === undefined) {
  console.error(
    JSON.stringify({
      status: "skipped",
      reason: "no supported Chromium executable was found",
    }),
  );
  process.exit(2);
}

// `--only=mockup` captures the mockup blocks alone, as `canvas-mockup-*.png`,
// `--only=flow` the funnel, radar, and sankey charts, as `canvas-flow-*.png`,
// and `--only=table` a wide table grouped, summarised, pinned, with one group
// collapsed and the grid scrolled sideways, as `canvas-table-*.png`.
const ONLY_SETS = ["mockup", "flow", "table"] as const;
const onlyArg = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);
const only = ONLY_SETS.find((set) => set === onlyArg);
if (onlyArg !== undefined && only === undefined) {
  console.error(
    JSON.stringify({ status: "failed", reason: `--only takes ${ONLY_SETS.join(" or ")}` }),
  );
  process.exit(1);
}
const onlyMockups = only === "mockup";
const port = pickPort();
const harnessUrl = `http://localhost:${String(port)}/chart-visuals-evidence.html${only === undefined ? "" : `?only=${only}`}`;
const serverProcess = Bun.spawn(
  [process.execPath, "run", "dev", "--", "--port", String(port), "--strictPort"],
  { cwd: webDir, stdout: "ignore", stderr: "ignore" },
);

const evidenceDir = join(repoRoot, ".canvas-browser-evidence");
const written: string[] = [];
let exitCode = 1;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

/**
 * The two surfaces a Canvas is drawn on: a thread draws it across the column,
 * and a sidebar panel draws it narrow. Both must lay out their metrics and bar
 * lists, so each scenario is captured at both widths.
 */
const WIDTHS: ReadonlyArray<{ readonly suffix: string; readonly width: number }> = [
  { suffix: "", width: 1100 },
  { suffix: "-sidebar", width: 460 },
  // A phone-width thread is narrower still; the diagrams must stay legible when
  // the picture is wider than the column and has to scroll.
  { suffix: "-narrow", width: 390 },
];

try {
  await waitForServer(harnessUrl, 30_000);
  browser = await chromium.launch({ executablePath: executable, headless: true });
  await Bun.$`mkdir -p ${evidenceDir}`.quiet();

  for (const { suffix, width } of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 1400 } });
    page.setDefaultTimeout(15_000);
    await page.goto(harnessUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(
      "main[data-canvas-chart-evidence='all'] .canvas-mockup, main[data-canvas-chart-evidence='all'] .canvas-block__chart, main[data-canvas-chart-evidence='all'] .canvas-block__heatmap, main[data-canvas-chart-evidence='all'] .canvas-block__bar-list, main[data-canvas-chart-evidence='all'] .canvas-block__matrix, main[data-canvas-chart-evidence='all'] .canvas-block__math, main[data-canvas-chart-evidence='all'] .canvas-block__table, main[data-canvas-chart-evidence='all'] .canvas-block__kind-diagram",
    );
    // The dev server injects the stylesheet after the first paint, and a chart
    // measured before it lands keeps the narrow width it drew at; let the page
    // settle so every chart measures its real column.
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);

    // Show the table's sorted state in the capture: the sort mark and the
    // announced direction are what a header control looks like once used.
    const tableSort = page.locator(".canvas-block__table .canvas-block__table-sort");
    if (only !== "table" && (await tableSort.count()) > 1) {
      await tableSort.nth(1).click();
      await page.waitForTimeout(50);
    }

    // Open each mockup's Outline so the capture shows the text fallback too.
    if (onlyMockups) {
      for (const summary of await page.locator(".canvas-mockup__outline summary").all()) {
        await summary.click();
      }
    }

    // Open each flow chart's data table so the capture shows its fallback too.
    if (only === "flow") {
      for (const summary of await page.locator(".canvas-block__chart-data summary").all()) {
        await summary.click();
      }
    }

    // Group by State with a summary, pin the first column, sort within the
    // groups, collapse the group holding open threads, and scroll the grid so
    // the pinned column and the comment gutter are seen holding their place.
    if (only === "table") {
      await page.getByRole("combobox", { name: "Group rows" }).click();
      await page.getByRole("option", { name: "State" }).click();
      await page.getByRole("combobox", { name: "Group summary" }).click();
      await page.getByRole("option", { name: "Sum of Requests" }).click();
      await page.getByText("Columns", { exact: true }).click();
      await page.getByRole("button", { name: "Pin Service" }).click();
      await page.getByText("Columns", { exact: true }).click();
      await page.getByRole("button", { name: "Requests", exact: true }).click();
      await page.getByRole("button", { name: /^State: Blocked/ }).click();
      await page.locator(".canvas-block__table-scroll").evaluate((element) => {
        element.scrollLeft = 260;
      });
      await page.waitForTimeout(50);
    }

    for (const scenario of SCENARIOS) {
      await page.emulateMedia({ forcedColors: scenario === "forced" ? "active" : "none" });
      await page.evaluate((value: Scenario) => {
        window.__applyChartTheme?.(value === "forced" ? "default-light" : value);
      }, scenario);
      // Let fonts and any layout settle before the capture.
      await page.waitForTimeout(150);
      const path = join(evidenceDir, `canvas-${only ?? "charts"}-${scenario}${suffix}.png`);
      await page.screenshot({ path, fullPage: true });
      written.push(path);
    }
    await page.close();
  }
  exitCode = 0;
} finally {
  await browser?.close();
  serverProcess.kill();
}

console.log(JSON.stringify({ status: exitCode === 0 ? "captured" : "failed", written }, null, 2));
process.exit(exitCode);
