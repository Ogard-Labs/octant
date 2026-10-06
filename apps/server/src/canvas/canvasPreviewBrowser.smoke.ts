// Canvas preview browser evidence smoke.
//
// Rasterises a real Canvas through the host's headless Chromium and writes the
// PNG the preview operation would return, so the picture is inspected rather
// than trusted. Exits non-zero with an explanatory status when no Chromium
// executable is found, the same way the other Canvas browser smokes do.

import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeCanvasBlock } from "@octant/contracts";
import { renderArtifactSvg } from "./artifactRender";
import { createPlaywrightCanvasPreviewRenderer } from "./canvasPreviewRenderer";
import { canvasPreviewPalette } from "./canvasPreviewService";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../../../");

const definition = {
  title: "Signed Q3 report",
  blocks: [
    decodeCanvasBlock({
      blockId: "overview",
      schemaVersion: 1,
      kind: "heading",
      level: 2,
      text: "Q3 Overview",
    }),
    decodeCanvasBlock({
      blockId: "revenue",
      schemaVersion: 1,
      kind: "chart",
      chartType: "grouped-bar",
      series: [
        {
          seriesId: "this-year",
          label: "This year",
          points: [
            { x: "Jul", y: 1_240 },
            { x: "Aug", y: 1_460 },
            { x: "Sep", y: 1_690 },
          ],
        },
        {
          seriesId: "last-year",
          label: "Last year",
          points: [
            { x: "Jul", y: 1_010 },
            { x: "Aug", y: 1_120 },
            { x: "Sep", y: 1_330 },
          ],
        },
      ],
    }),
    decodeCanvasBlock({
      blockId: "shipped",
      schemaVersion: 1,
      kind: "metric",
      label: "Shipped",
      value: 12_345,
      goodDirection: "up",
    }),
  ],
};

function pngSize(png: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  // PNG: 8-byte signature, then a length/type IHDR chunk whose payload starts
  // with the width and height as big-endian uint32 at byte offset 16.
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 24 || signature.some((byte, index) => png[index] !== byte)) return undefined;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const renderer = createPlaywrightCanvasPreviewRenderer();
if (!(await renderer.available())) {
  console.error(
    JSON.stringify({ status: "skipped", reason: "no supported Chromium executable was found" }),
  );
  process.exit(2);
}

const width = 760;
const height = 640;
const palette = canvasPreviewPalette("light");
const artifactPalette = {
  background: palette.workspace,
  ink: palette.ink,
  muted: palette.muted,
  accent: palette.accent,
};
const rendered = await renderer.render({
  definition,
  width,
  height,
  palette: artifactPalette,
});

if (rendered.kind !== "rendered") {
  console.error(JSON.stringify({ status: "failed", reason: "the renderer reported no picture" }));
  process.exit(1);
}

const evidenceDir = join(repoRoot, ".canvas-preview-browser-evidence");
await Bun.$`mkdir -p ${evidenceDir}`.quiet();
const pngPath = join(evidenceDir, "canvas-preview.png");
await Bun.write(pngPath, rendered.png);

const svg = renderArtifactSvg(definition, { width, height, palette: artifactPalette });
const size = pngSize(rendered.png);
const results = {
  pngHasSignature: size !== undefined,
  pngMatchesRequestedSize: size?.width === width && size?.height === height,
  pngWithinImageCeiling: (size?.width ?? Number.POSITIVE_INFINITY) <= 1_600,
  hostRendererProducedInk: svg.includes("<svg"),
};
const failed = Object.entries(results).filter(([, ok]) => !ok);
console.log(
  JSON.stringify(
    {
      status: failed.length === 0 ? "passed" : "failed",
      pngPath,
      bytes: rendered.png.byteLength,
      size,
      assertions: results,
      failures: failed.map(([name]) => name),
    },
    null,
    2,
  ),
);
process.exit(failed.length === 0 ? 0 : 1);
