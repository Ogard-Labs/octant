import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer } from "vite";
import { expect, it } from "vitest";
import { NARROW, SCENE_LIST, updateMode, WIDE } from "./sceneList";

/**
 * Draws the key screens in a pinned Chromium and compares each picture with
 * its baseline in `apps/web/visual-baselines`. Gated like the other rendered
 * checks, so ordinary local unit runs do not launch a browser. Baselines are
 * drawn in CI (fonts and anti-aliasing differ on a Mac); see
 * DESIGN.md Enforcement for how an intended change is approved.
 *
 *   OCTANT_VISUAL_CHECK=1        run
 *   OCTANT_VISUAL_UPDATE=1       write the baselines of pictures that changed or are missing
 *   OCTANT_VISUAL_UPDATE=all     write every baseline
 *   OCTANT_QA_ARTIFACTS          where actual, baseline and diff pictures go
 *   OCTANT_BROWSER_EXECUTABLE    a browser to use instead of playwright's own Chromium
 */

/** A pixel differs when any colour channel is off by more than this. */
const CHANNEL_TOLERANCE = 24;
/**
 * How many pixels may differ before the picture counts as changed. A one-word
 * or one-icon change moves far more; the logged noise of an unchanged screen
 * shows how much room this leaves.
 */
const PIXEL_LIMIT = 50;
/** The clock every scene sees. */
const FIXED_TIME = new Date("2026-08-18T09:00:00.000Z");

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baselineDir = resolve(webRoot, "visual-baselines");

interface Shot {
  readonly name: string;
  readonly scene: string;
  readonly scheme: "light" | "dark";
  readonly size: { readonly width: number; readonly height: number };
}

function shots(): ReadonlyArray<Shot> {
  return SCENE_LIST.flatMap((scene) =>
    (["light", "dark"] as const).flatMap((scheme) =>
      [WIDE, ...(scene.narrow === true ? [NARROW] : [])].map((size) => ({
        name: `${scene.id}-${scheme}-${String(size.width)}`,
        scene: scene.id,
        scheme,
        size,
      })),
    ),
  );
}

interface Comparison {
  readonly sizesMatch: boolean;
  readonly actualSize: string;
  readonly baselineSize: string;
  readonly differing: number;
  readonly total: number;
  readonly diff: string;
}

/** Draws both pictures on canvases and counts the pixels that differ visibly. */
async function compare(page: Page, actual: Buffer, baseline: Buffer): Promise<Comparison> {
  return page.evaluate(
    async ({ actualUrl, baselineUrl, tolerance }) => {
      const load = (url: string) =>
        new Promise<HTMLImageElement>((resolveImage, reject) => {
          const image = new Image();
          image.onload = () => resolveImage(image);
          image.onerror = () => reject(new Error("A picture could not be decoded."));
          image.src = url;
        });
      const [a, b] = await Promise.all([load(actualUrl), load(baselineUrl)]);
      const size = (image: HTMLImageElement) => `${image.naturalWidth}x${image.naturalHeight}`;
      if (a.naturalWidth !== b.naturalWidth || a.naturalHeight !== b.naturalHeight) {
        return {
          sizesMatch: false,
          actualSize: size(a),
          baselineSize: size(b),
          differing: 0,
          total: 0,
          diff: "",
        };
      }
      const { naturalWidth: width, naturalHeight: height } = a;
      const pixels = (image: HTMLImageElement) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (context === null) throw new Error("No canvas context.");
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, width, height);
      };
      const left = pixels(a);
      const right = pixels(b);
      const out = new ImageData(width, height);
      let differing = 0;
      for (let index = 0; index < left.data.length; index += 4) {
        const delta = Math.max(
          Math.abs((left.data[index] ?? 0) - (right.data[index] ?? 0)),
          Math.abs((left.data[index + 1] ?? 0) - (right.data[index + 1] ?? 0)),
          Math.abs((left.data[index + 2] ?? 0) - (right.data[index + 2] ?? 0)),
          Math.abs((left.data[index + 3] ?? 0) - (right.data[index + 3] ?? 0)),
        );
        if (delta > tolerance) {
          differing += 1;
          out.data[index] = 255;
          out.data[index + 1] = 0;
          out.data[index + 2] = 0;
          out.data[index + 3] = 255;
        } else {
          // The unchanged picture, faded, so the red reads against its context.
          out.data[index] = 255 - Math.round(0.25 * (255 - (right.data[index] ?? 0)));
          out.data[index + 1] = 255 - Math.round(0.25 * (255 - (right.data[index + 1] ?? 0)));
          out.data[index + 2] = 255 - Math.round(0.25 * (255 - (right.data[index + 2] ?? 0)));
          out.data[index + 3] = 255;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")?.putImageData(out, 0, 0);
      return {
        sizesMatch: true,
        actualSize: size(a),
        baselineSize: size(b),
        differing,
        total: width * height,
        diff: canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, ""),
      };
    },
    {
      actualUrl: `data:image/png;base64,${actual.toString("base64")}`,
      baselineUrl: `data:image/png;base64,${baseline.toString("base64")}`,
      tolerance: CHANNEL_TOLERANCE,
    },
  );
}

it.runIf(process.env.OCTANT_VISUAL_CHECK === "1")(
  "draws the key screens the way their baselines say",
  { timeout: 280_000 },
  async () => {
    const mode = updateMode(process.env.OCTANT_VISUAL_UPDATE);
    const update = mode !== "off";
    const artifacts = resolve(
      process.env.OCTANT_QA_ARTIFACTS ?? resolve(webRoot, "../../.artifacts/visual-check"),
    );
    await mkdir(artifacts, { recursive: true });
    await mkdir(baselineDir, { recursive: true });
    const server = await createServer({
      root: webRoot,
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "error",
    });
    let browser: Browser | undefined;
    let closing: Promise<void> | undefined;
    const close = () => {
      closing ??= (async () => {
        try {
          if (browser !== undefined) {
            const owned = browser;
            const force = setTimeout(() => void owned.close().catch(() => undefined), 3000);
            try {
              await owned.close();
            } finally {
              clearTimeout(force);
            }
          }
        } finally {
          await server.close();
        }
      })();
      return closing;
    };
    const stop = () => void close();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    const lifetime = setTimeout(stop, 270_000);
    const changed: string[] = [];
    const missing: string[] = [];
    const written: string[] = [];
    // Pixels that differed on a screen that still passed, for tuning the limit.
    const noise: string[] = [];
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (address === undefined || address === null || typeof address === "string")
        throw Error("The visual check's dev server did not bind its loopback port.");
      const origin = `http://127.0.0.1:${String(address.port)}`;
      const executablePath = process.env.OCTANT_BROWSER_EXECUTABLE;
      if (executablePath !== undefined) expect(existsSync(executablePath)).toBe(true);
      browser = await chromium.launch({
        headless: true,
        timeout: 30_000,
        ...(executablePath === undefined ? {} : { executablePath }),
        args: ["--font-render-hinting=none", "--force-color-profile=srgb", "--disable-lcd-text"],
      });
      browser.once("disconnected", stop);
      const comparer = await browser.newPage();
      // One visit first: Vite's first load of a dependency can reload the page,
      // and that must not land in the middle of a shot.
      const warm = await browser.newContext({ viewport: WIDE });
      try {
        await warm.route("**/*", (route) =>
          new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
        );
        const warmPage = await warm.newPage();
        await warmPage.goto(`${origin}/visual-check.html?scene=home&scheme=dark`);
        await warmPage.waitForSelector("html[data-visual-ready='true']", { timeout: 60_000 });
      } finally {
        await warm.close();
      }
      const failures: string[] = [];
      for (const shot of shots()) {
        const context = await browser.newContext({
          viewport: shot.size,
          deviceScaleFactor: 1,
          colorScheme: shot.scheme,
          reducedMotion: "reduce",
          locale: "en-US",
          timezoneId: "UTC",
        });
        try {
          await context.clock.setFixedTime(FIXED_TIME);
          // Only the dev server answers: a font or picture from the network
          // would make the picture depend on it.
          await context.route("**/*", (route) =>
            new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
          );
          const page = await context.newPage();
          page.on("pageerror", (error) => failures.push(`${shot.name}: ${error.message}`));
          await page.goto(`${origin}/visual-check.html?scene=${shot.scene}&scheme=${shot.scheme}`);
          await page.waitForSelector("html[data-visual-ready='true']", { timeout: 30_000 });
          const actual = await page.screenshot({ animations: "disabled", caret: "hide" });
          const baselinePath = resolve(baselineDir, `${shot.name}.png`);
          const actualPath = resolve(artifacts, `${shot.name}.actual.png`);
          const baseline = existsSync(baselinePath) ? await readFile(baselinePath) : undefined;
          if (baseline === undefined) {
            await writeFile(actualPath, actual);
            if (!update) {
              missing.push(shot.name);
            } else {
              await writeFile(baselinePath, actual);
              written.push(shot.name);
            }
            continue;
          }
          if (mode === "all") {
            await writeFile(actualPath, actual);
            await writeFile(baselinePath, actual);
            written.push(shot.name);
            continue;
          }
          if (actual.equals(baseline)) continue;
          const result = await compare(comparer, actual, baseline);
          if (result.sizesMatch && result.differing <= PIXEL_LIMIT) {
            noise.push(`${shot.name}=${String(result.differing)}`);
            continue;
          }
          await writeFile(actualPath, actual);
          if (update) {
            await writeFile(baselinePath, actual);
            written.push(shot.name);
            continue;
          }
          await writeFile(resolve(artifacts, `${shot.name}.baseline.png`), baseline);
          if (result.sizesMatch)
            await writeFile(
              resolve(artifacts, `${shot.name}.diff.png`),
              Buffer.from(result.diff, "base64"),
            );
          changed.push(
            result.sizesMatch
              ? `${shot.name} (${String(result.differing)} pixels differ)`
              : `${shot.name} (size ${result.actualSize}, baseline ${result.baselineSize})`,
          );
        } finally {
          await context.close();
        }
      }
      console.log(
        `Noise on passing screens (pixels, limit ${String(PIXEL_LIMIT)}): ${noise.length === 0 ? "none" : noise.join(", ")}`,
      );
      if (written.length > 0)
        console.log(`Wrote ${String(written.length)} baselines: ${written.join(", ")}`);
      expect(failures).toEqual([]);
      const problems = [
        ...(changed.length === 0
          ? []
          : [`These screens changed visibly:\n  ${changed.join("\n  ")}`]),
        ...(missing.length === 0
          ? []
          : [`These screens have no baseline yet:\n  ${missing.join("\n  ")}`]),
      ];
      if (problems.length > 0) {
        throw new Error(
          `${problems.join("\n")}\nThe actual, baseline and diff pictures are in ${artifacts}.\nIntended? Add the \`design change\` label, then commit the new pictures with \`bun scripts/visual-baselines-from-ci.ts <run id>\`.`,
        );
      }
    } finally {
      clearTimeout(lifetime);
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
      await close();
      expect(server.httpServer?.listening ?? false).toBe(false);
    }
  },
);
