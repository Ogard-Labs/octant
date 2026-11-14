import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Draws the Stable app icon on the macOS icon grid: an 824px rounded square
 * centred on a 1024px canvas (100px margin), a soft drop shadow inside the
 * margin, and the flat white aperture mark. A tile that misses this grid is
 * treated as a legacy icon and shrunk into a plate in the Dock.
 *
 * Uses rsvg-convert (librsvg). Run `--write` to replace
 * apps/desktop/resources/icon.{png,icns}, then regenerate the Nightly files with
 * scripts/generate-nightly-icons.ts.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TILE = 824;
const CANVAS = 1024;
const MARK_SHARE = 0.54;

/** Apple's continuous corner is closer to a superellipse than to a circular arc. */
function squirclePath(): string {
  const half = TILE / 2;
  const exponent = 5;
  const points: string[] = [];
  for (let step = 0; step < 720; step += 1) {
    const angle = (step / 720) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = CANVAS / 2 + half * Math.sign(cos) * Math.abs(cos) ** (2 / exponent);
    const y = CANVAS / 2 + half * Math.sign(sin) * Math.abs(sin) ** (2 / exponent);
    points.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return `M${points.join(" L")} Z`;
}

async function apertureMarkup(): Promise<string> {
  const sprite = await readFile(join(root, "apps/web/public/icons.svg"), "utf8");
  const symbol = sprite.match(/<symbol id="aperture"[^>]*>([\s\S]*?)<\/symbol>/);
  if (!symbol?.[1]) throw new Error("The aperture symbol is missing from icons.svg.");
  return symbol[1].replaceAll("currentColor", "#fff").replaceAll("href=", "xlink:href=");
}

export async function iconSvg(): Promise<string> {
  // The mark spans 90 of its 100 units; centre it by its measured box (49.95).
  const unit = (TILE * MARK_SHARE) / 90;
  const offset = CANVAS / 2 - 49.95 * unit;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
<defs>
<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c1c1c"/><stop offset="1" stop-color="#161616"/></linearGradient>
<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="10"/></filter>
</defs>
<path d="${squirclePath()}" transform="translate(0 10)" fill="#000" fill-opacity="0.3" filter="url(#shadow)"/>
<path d="${squirclePath()}" fill="url(#tile)"/>
<g transform="translate(${offset.toFixed(2)} ${offset.toFixed(2)}) scale(${unit.toFixed(4)})">${await apertureMarkup()}</g>
</svg>
`;
}

/**
 * Every size is stored as an embedded PNG (the ic07..ic14 types). iconutil
 * stores the small sizes in a legacy ARGB layout instead, which the Nightly
 * generator refuses, so the container is written here. 16pt at 1x is left out:
 * the 32px image (16pt at 2x) scales down for it.
 */
const ICNS_TYPES: ReadonlyArray<readonly [string, number]> = [
  ["ic11", 32],
  ["ic12", 64],
  ["ic07", 128],
  ["ic13", 256],
  ["ic08", 256],
  ["ic14", 512],
  ["ic09", 512],
  ["ic10", 1024],
];

if (import.meta.main) {
  if (process.argv[2] !== "--write" || process.argv.length !== 3)
    throw new Error("Use --write to regenerate apps/desktop/resources/icon.png and icon.icns.");
  const temporary = await mkdtemp(join(tmpdir(), "octant-app-icon-"));
  try {
    const svg = join(temporary, "icon.svg");
    await writeFile(svg, await iconSvg());
    const render = (size: number): Buffer =>
      execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), "-f", "png", svg], {
        maxBuffer: 16 * 1024 * 1024,
      });
    const entries = ICNS_TYPES.map(([type, size]) => {
      const png = render(size);
      const header = Buffer.alloc(8);
      header.write(type, 0, "ascii");
      header.writeUInt32BE(png.length + 8, 4);
      return Buffer.concat([header, png]);
    });
    const body = Buffer.concat(entries);
    const header = Buffer.alloc(8);
    header.write("icns", 0, "ascii");
    header.writeUInt32BE(body.length + 8, 4);
    const resources = join(root, "apps/desktop/resources");
    await writeFile(join(resources, "icon.icns"), Buffer.concat([header, body]));
    await writeFile(join(resources, "icon.png"), render(512));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
