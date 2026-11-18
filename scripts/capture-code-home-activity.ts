// Rendered QA capture for the Code Home activity panel.
//
// Renders `apps/web/code-home-activity-evidence.html` — the real Code welcome
// (`DraftThreadWorkspace` in Code mode) with a Needs you row and the activity
// panel on fake reads — in a real headless Chromium and writes one PNG per
// scene and width into the activity evidence directory. The harness page
// picks a fixture set by `?scene=`; this script opens the dialog scenes by
// clicking the same controls a person would. It skips with a non-zero exit
// when no Chromium is available.

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

const PLAYWRIGHT_CHROMIUM_CANDIDATES = [
  join(
    homedir(),
    "Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  ),
  join(homedir(), ".cache/ms-playwright/chromium-1148/chrome-linux/chrome"),
];

/** Where the rendered evidence lands, outside the repository. */
const EVIDENCE_DIR = "/Users/henrik/octant-evidence/code-home-activity";

interface Scene {
  readonly name: "default" | "customize" | "records" | "states";
  readonly widths: ReadonlyArray<{ readonly width: number; readonly height: number }>;
}

const SCENES: ReadonlyArray<Scene> = [
  {
    name: "default",
    widths: [
      { width: 1100, height: 800 },
      { width: 390, height: 844 },
    ],
  },
  { name: "customize", widths: [{ width: 1100, height: 800 }] },
  { name: "records", widths: [{ width: 1100, height: 800 }] },
  { name: "states", widths: [{ width: 1100, height: 800 }] },
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

const port = pickPort();
const harnessUrl = (sceneName: Scene["name"]) =>
  `http://localhost:${String(port)}/code-home-activity-evidence.html?scene=${sceneName}`;
const serverProcess = Bun.spawn(
  [process.execPath, "run", "dev", "--", "--port", String(port), "--strictPort"],
  { cwd: webDir, stdout: "ignore", stderr: "ignore" },
);

const written: string[] = [];
let exitCode = 1;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  await waitForServer(harnessUrl("default"), 30_000);
  browser = await chromium.launch({ executablePath: executable, headless: true });
  await Bun.$`mkdir -p ${EVIDENCE_DIR}`.quiet();

  for (const current of SCENES) {
    for (const { width, height } of current.widths) {
      const page = await browser.newPage({ viewport: { width, height } });
      page.setDefaultTimeout(15_000);
      await page.goto(harnessUrl(current.name), { waitUntil: "domcontentloaded" });
      // The panel mounts only after the start screen's first paint, and the
      // reads then resolve; wait for a settled card figure, then let the dev
      // server's injected styles and the fonts land before the capture.
      await page.waitForSelector(".code-home-activity");
      await page.waitForSelector("[data-state='ready'], [data-state='empty']");
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(400);

      if (current.name === "customize") {
        await page.getByRole("button", { name: "Customize activity" }).click();
        await page.getByRole("dialog", { name: "Customize activity" }).waitFor();
        await page.waitForTimeout(150);
      }
      if (current.name === "records") {
        await page.getByRole("button", { name: "Successful runs: 9. Show records" }).click();
        await page.getByRole("dialog", { name: /Successful runs/ }).waitFor();
        await page.getByRole("switch", { name: "All finished" }).click();
        // The switched list refills from the same snapshot; wait for a row
        // that only the All finished read can name.
        await page.getByText("Broke the build").waitFor();
        await page.waitForTimeout(150);
      }

      const path = join(EVIDENCE_DIR, `${current.name}-${String(width)}.png`);
      await page.screenshot({ path });
      written.push(path);
      await page.close();
    }
  }
  exitCode = 0;
} finally {
  await browser?.close();
  serverProcess.kill();
}

console.log(JSON.stringify({ status: exitCode === 0 ? "captured" : "failed", written }, null, 2));
process.exit(exitCode);
