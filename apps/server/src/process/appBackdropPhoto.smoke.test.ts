import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const evidenceDirectory = join(
  fileURLToPath(
    new URL(
      "../../../../.scratch/pipeline/20260913-1257-remediation-503/stage-6-verify/screenshots/",
      import.meta.url,
    ),
  ),
);

function surfaceCss(): string {
  return readFileSync(
    join(fileURLToPath(new URL("../../../../apps/web/src/styles/surface.css", import.meta.url))),
    "utf8",
  );
}

describe("clean photo sampling evidence", () => {
  it("screenshots clean vs dithered photos at DPR 1 and 2, desktop and narrow", async () => {
    const { chromium } = await import("playwright-core");
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    try {
      browser = await chromium.launch({
        headless: true,
        ...(existsSync(chrome) ? { executablePath: chrome } : {}),
      });
    } catch (error) {
      // Linux CI has no headed Chrome; local macOS evidence is the screenshot files.
      expect(existsSync(chrome)).toBe(false);
      return;
    }
    mkdirSync(evidenceDirectory, { recursive: true });
    const css = surfaceCss();
    const html = `<!doctype html>
<html>
<head>
<style>
${css}
body { margin: 0; background: #111; }
.frame { position: relative; overflow: hidden; }
</style>
</head>
<body>
<div class="frame" id="frame">
  <canvas class="app-backdrop__photo" id="photo"></canvas>
</div>
<script>
function paint(dithered, cssWidth, cssHeight, ratio) {
  const frame = document.getElementById("frame");
  const canvas = document.getElementById("photo");
  frame.style.width = cssWidth + "px";
  frame.style.height = cssHeight + "px";
  canvas.dataset.dithered = dithered ? "true" : "false";
  const width = dithered ? Math.ceil(cssWidth / 2) : Math.ceil(cssWidth * ratio);
  const height = dithered ? Math.ceil(cssHeight / 2) : Math.ceil(cssHeight * ratio);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#f4d6c4");
  gradient.addColorStop(1, "#2b211c");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}
window.paint = paint;
</script>
</body>
</html>`;
    try {
      const shots: string[] = [];
      for (const ratio of [1, 2]) {
        for (const viewport of [
          { name: "desktop", width: 1280, height: 800 },
          { name: "narrow", width: 390, height: 844 },
        ]) {
          const page = await browser.newPage({
            viewport: { width: viewport.width, height: viewport.height },
            deviceScaleFactor: ratio,
          });
          await page.setContent(html);
          await page.evaluate(
            (input: {
              readonly dithered: boolean;
              readonly width: number;
              readonly height: number;
              readonly ratio: number;
            }) => {
              const paint = (
                globalThis as typeof globalThis & {
                  paint?: (dithered: boolean, width: number, height: number, ratio: number) => void;
                }
              ).paint;
              if (paint === undefined) throw new Error("paint is missing");
              paint(input.dithered, input.width, input.height, input.ratio);
            },
            {
              dithered: false,
              width: viewport.width,
              height: viewport.height,
              ratio,
            },
          );
          const cleanPath = join(evidenceDirectory, `clean-dpr${ratio}-${viewport.name}.png`);
          await page.screenshot({ path: cleanPath });
          const pixelated = await page.evaluate(() => {
            const photo = document.getElementById("photo");
            if (photo === null) throw new Error("missing photo canvas");
            return getComputedStyle(photo).imageRendering;
          });
          expect(pixelated === "auto" || pixelated === "crisp-edges" || pixelated === "").toBe(
            true,
          );
          await page.evaluate(
            (input: {
              readonly dithered: boolean;
              readonly width: number;
              readonly height: number;
              readonly ratio: number;
            }) => {
              const paint = (
                globalThis as typeof globalThis & {
                  paint?: (dithered: boolean, width: number, height: number, ratio: number) => void;
                }
              ).paint;
              if (paint === undefined) throw new Error("paint is missing");
              paint(input.dithered, input.width, input.height, input.ratio);
            },
            {
              dithered: true,
              width: viewport.width,
              height: viewport.height,
              ratio,
            },
          );
          const ditheredPath = join(evidenceDirectory, `dithered-dpr${ratio}-${viewport.name}.png`);
          await page.screenshot({ path: ditheredPath });
          const ditheredSampling = await page.evaluate(() => {
            const photo = document.getElementById("photo");
            if (photo === null) throw new Error("missing photo canvas");
            return getComputedStyle(photo).imageRendering;
          });
          expect(ditheredSampling).toMatch(/pixelated|crisp-edges/i);
          shots.push(cleanPath, ditheredPath);
          await page.close();
        }
      }
      for (const shot of shots) {
        expect(existsSync(shot)).toBe(true);
        expect(readFileSync(shot).byteLength).toBeGreaterThan(1000);
      }
      writeFileSync(
        join(evidenceDirectory, "README.txt"),
        `Clean vs dithered photo sampling. DPR 1 and 2, desktop 1280x800 and narrow 390x844.\nFiles:\n${shots.join("\n")}\n`,
      );
    } finally {
      await browser.close();
    }
  });
});
