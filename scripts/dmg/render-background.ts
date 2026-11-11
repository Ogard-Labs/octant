/**
 * Renders `background.svg` to the multi-resolution `background.tiff` the disk
 * image's Finder window shows.
 *
 * Regenerate after editing the SVG:
 *
 *   bun scripts/dmg/render-background.ts
 *
 * Needs macOS (`tiffutil`) and Google Chrome at its usual path. It is an
 * authoring tool: the release build never runs it, and the PNGs it writes to a
 * temporary folder are not committed. Only the SVG and the TIFF are.
 * Set OCTANT_DMG_PNG_DIR to choose where the PNGs go.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const WIDTH = 660;
const HEIGHT = 400;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const directory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const outputDirectory =
  process.env.OCTANT_DMG_PNG_DIR ?? (await mkdtemp(join(tmpdir(), "octant-dmg-")));
const svg = (await readFile(join(directory, "background.svg"), "utf8")).replace(
  /^<\?xml[^>]*\?>/,
  "",
);
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  for (const scale of [1, 2]) {
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: scale,
    });
    const page = await context.newPage();
    await page.setContent(`<!doctype html><body style="margin:0;background:#0b0c0e">${svg}</body>`);
    const png = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    });
    await writeFile(
      join(outputDirectory, scale === 1 ? "background.png" : "background@2x.png"),
      png,
    );
    await context.close();
  }
} finally {
  await browser.close();
}

const combine = Bun.spawn(
  [
    "/usr/bin/tiffutil",
    "-cathidpicheck",
    join(outputDirectory, "background.png"),
    join(outputDirectory, "background@2x.png"),
    "-out",
    join(directory, "background.tiff"),
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await combine.exited) !== 0) throw new Error("tiffutil could not combine the two renders.");
console.log(`Rendered ${join(outputDirectory, "background.png")} and scripts/dmg/background.tiff`);
