import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import { canvasMockupsTsx } from "@octant/domain";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The handed-off file is compiled by the same JSX transform an app would use
// and rendered by React, so a file that does not parse, or markup React
// rejects, fails here rather than in the person's project.

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const settings = decodeCanvasBlock({
  schemaVersion: CANVAS_SCHEMA_VERSION,
  blockId: "settings",
  kind: "mockup",
  device: "phone",
  title: "Settings",
  nodes: [
    { nodeId: "w", component: "window", label: "Settings" },
    { nodeId: "sync", parentId: "w", component: "toggle", label: "Sync {fast}", on: true },
    { nodeId: "volume", parentId: "w", component: "slider", label: "Volume", progress: 40 },
    { nodeId: "query", parentId: "w", component: "search", label: "Find", value: "Ada & co" },
  ],
});

describe("a handed-off TSX file", () => {
  it("compiles and renders the same inert controls the mockup draws", async () => {
    const tsx = canvasMockupsTsx([settings]);
    if (tsx === undefined) throw new Error("expected a TSX file");
    // Beside this test, so the test runner's own transform compiles it; the
    // folder is removed afterwards.
    const directory = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".tsx-handoff-"));
    directories.push(directory);
    const file = join(directory, "Settings.tsx");
    writeFileSync(file, tsx);
    const errors = vi.spyOn(console, "error");
    const module: { readonly Settings?: ComponentType } = await import(/* @vite-ignore */ file);
    const Settings = module.Settings;
    if (Settings === undefined) throw new Error("expected the Settings component");
    render(<Settings />);
    expect(screen.getByRole("checkbox", { name: "Sync {fast}" })).toBeChecked();
    expect(screen.getByRole("slider", { name: "Volume" })).toHaveValue("40");
    expect(screen.getByRole("searchbox", { name: "Find" })).toHaveAttribute(
      "placeholder",
      "Ada & co",
    );
    expect(document.querySelector("style")?.textContent).toContain(".oct-mockup-page");
    expect(errors).not.toHaveBeenCalled();
  });
});
