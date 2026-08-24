import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cssRoot = resolve(process.cwd(), "src/styles");
const shippedCssRoot = resolve(process.cwd(), "src");
const ordinarySurfaceFiles = ["shell.css", "settings.css", "dock.css"] as const;
const technicalMonoSelectors = new Set([
  ".code-worktree-source__disclosure-label",
  ".settings-view__textarea",
  ".github-settings__device-code",
]);

describe("interface typography contract", () => {
  it("keeps every shipped CSS surface on canonical typography projections", () => {
    for (const file of collectCssFiles(shippedCssRoot)) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} must not use legacy mono token aliases`).not.toMatch(
        /--octant-(?:mono|font-mono)\b/,
      );
      for (const block of cssBlocks(source)) {
        if (block.selector.trim().startsWith("@font-face")) continue;
        const family = block.declarations
          .match(/(?:^|[;\n])\s*font-family\s*:\s*([^;]+)/)?.[1]
          ?.trim();
        if (family === undefined || family === "inherit") continue;
        expect(
          family,
          `${file} ${block.selector.trim()} must use an app-controlled typography projection`,
        ).toMatch(
          /var\(--oct-font-(?:display|body|transcript|mono)\)|var\(--octant-(?:ui|editor|terminal)-font-family\)/,
        );
      }
    }
  });

  it("keeps ordinary shell, settings, and dock rules on the interface projection", () => {
    for (const file of ordinarySurfaceFiles) {
      const source = readFileSync(resolve(cssRoot, file), "utf8");
      expect(source, `${file} must not reintroduce obsolete interface aliases`).not.toMatch(
        /--oct-font-(ui|sans)\b/,
      );
      for (const block of cssBlocks(source)) {
        const family = block.declarations.match(/font-family:\s*([^;]+)/)?.[1]?.trim();
        if (family === undefined) continue;

        const selector = block.selector.trim();
        const isMono = family.includes("--oct-font-mono") || family.includes("ui-monospace");
        if (isMono) {
          expect(
            technicalMonoSelectors.has(selector),
            `${file} ${selector} must keep code/path values scoped to a mono face`,
          ).toBe(true);
        } else {
          expect(family, `${file} ${selector} must use a runtime interface projection`).toMatch(
            /--oct-font-(display|body|transcript)|--octant-ui-font-family/,
          );
        }
      }
    }
  });

  it("keeps the board's visible labels and cards on interface typography", () => {
    const source = readFileSync(resolve(cssRoot, "octant.css"), "utf8");
    expect(source).not.toMatch(/--oct-font-(ui|sans)\b/);
    for (const selector of [".board-col-head", ".board-card-title", ".board-card-facts"]) {
      const block = cssBlocks(source).find((candidate) => candidate.selector.trim() === selector);
      expect(block, `${selector} must have an explicit typography rule`).toBeDefined();
      expect(block?.declarations).toMatch(/font-family:\s*var\(--oct-font-display\);/);
      expect(block?.declarations).not.toMatch(/font-family:\s*var\(--oct-font-mono\);/);
    }
  });
});

function cssBlocks(
  source: string,
): ReadonlyArray<{ readonly selector: string; readonly declarations: string }> {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/gs)].map((match) => ({
    selector: (match[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "").trim(),
    declarations: match[2] ?? "",
  }));
}

function collectCssFiles(root: string): ReadonlyArray<string> {
  const files: Array<string> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...collectCssFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".css")) files.push(path);
  }
  return files;
}
