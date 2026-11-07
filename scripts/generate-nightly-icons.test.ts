import { resolve } from "node:path";
import { expect, it } from "vitest";
import { generateNightlyIcons } from "./generate-nightly-icons";

it.skipIf(process.platform !== "darwin")(
  "preserves every icon size and alpha value while inverting visible colours",
  async () => {
    const reports = await generateNightlyIcons(resolve(import.meta.dirname, ".."), "check");
    expect(reports[0]).toContain("Synthetic transparent, translucent and opaque pixels");
    for (const report of reports.slice(1)) {
      expect(JSON.parse(report)).toMatchObject({ alphaExact: true, visibleRGBInverted: true });
    }
  },
  30_000,
);
