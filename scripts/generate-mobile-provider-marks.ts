/**
 * Draws the phone's provider marks from the renderer's logo table, so both
 * name a provider by the same mark. React Native has no SVG of its own and the
 * list tints each mark, so a mark is one white PNG per provider.
 *
 *   bun scripts/generate-mobile-provider-marks.ts
 *
 * Only marks released as CC0 are drawn: the others carry notices the phone app
 * does not ship. Image and video providers answer no thread.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { renderToStaticMarkup } from "react-dom/server";
import { PROVIDER_LOGOS } from "../apps/web/src/providers/providerLogoPaths";

const PIXELS = 60;
const out = resolve(import.meta.dirname, "../apps/mobile/assets/providers");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: PIXELS, height: PIXELS } });
  for (const [kind, logo] of Object.entries(PROVIDER_LOGOS)) {
    if (logo.source.license !== "CC0-1.0" || /-(image|video)$/.test(kind)) continue;
    await page.setContent(
      `<style>body{margin:0;color:#fff}svg{display:block}</style><svg width="${PIXELS}" height="${PIXELS}" viewBox="${logo.viewBox}">${renderToStaticMarkup(logo.mark)}</svg>`,
    );
    writeFileSync(
      resolve(out, `${kind}.png`),
      await page.screenshot({ omitBackground: true, type: "png" }),
    );
  }
} finally {
  await browser.close();
}
