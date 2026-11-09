import { BROWSER_TOOL_HOST_LINE } from "@octant/plugin-host/browser-use";
import { describe, expect, it } from "vitest";
import { appToolHostLines } from "./appToolHostLines";

const offered = (...names: ReadonlyArray<string>) => names.map((name) => ({ name }));

describe("appToolHostLines", () => {
  it("tells the model where each offered Octant tool replaces a native or outside path, and nothing about tools it lacks", () => {
    const lines = appToolHostLines(
      offered("octant_apple", "octant_android", "octant_terminal", "octant_pull_request"),
    );
    expect(lines.map((line) => line.tool)).toEqual([
      "octant_apple",
      "octant_android",
      "octant_terminal",
      "octant_pull_request",
    ]);
    expect(lines.find((line) => line.tool === "octant_apple")?.text).toContain("Simulator.app");
    expect(appToolHostLines(offered("octant_browser"))).toEqual([
      { tool: "octant_browser", text: BROWSER_TOOL_HOST_LINE },
    ]);
    expect(appToolHostLines(offered("octant_canvas"))).toEqual([]);
  });

  it("points every provider at the image model instead of an SVG drawing only while the image tool is offered", () => {
    const [line] = appToolHostLines(offered("octant_create_image"));
    expect(line?.tool).toBe("octant_create_image");
    expect(line?.text).toMatch(/instead of drawing it as SVG/);
    expect(line?.text).toMatch(/confirm/);
    expect(appToolHostLines(offered("octant_browser")).map((entry) => entry.tool)).not.toContain(
      "octant_create_image",
    );
  });

  it("keeps every line short, so offering a tool costs the cached prefix little", () => {
    const all = appToolHostLines(
      offered(
        "octant_browser",
        "octant_computer",
        "octant_apple",
        "octant_android",
        "octant_terminal",
        "octant_pull_request",
        "octant_github",
        "octant_create_image",
        "octant_agents",
      ),
    );
    expect(all).toHaveLength(9);
    for (const line of all) expect(line.text.length).toBeLessThanOrEqual(240);
    expect(all.reduce((total, line) => total + line.text.length, 0)).toBeLessThanOrEqual(1_500);
  });
});
