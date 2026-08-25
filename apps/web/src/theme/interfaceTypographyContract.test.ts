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

  it("moves the whole interface type scale with the size the user chose", () => {
    // Appearance's interface font size used to reach only the handful of
    // rules that named `--octant-ui-font-size` directly. The `--oct-text-*`
    // ladder carried the great majority of the app's text, so the setting
    // looked ignored. Every step must derive from the setting.
    const octant = readFileSync(resolve(cssRoot, "octant.css"), "utf8");
    for (const step of ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl"]) {
      const declaration = octant.match(new RegExp(`--oct-text-${step}:\\s*([^;]+)`))?.[1]?.trim();
      expect(declaration, `--oct-text-${step} must be declared`).toBeDefined();
      expect(
        declaration,
        `--oct-text-${step} must derive from the interface size, not freeze a literal`,
      ).toMatch(/var\(--oct-text-step\)/);
    }
    expect(octant.match(/--oct-text-step:\s*([^;]+)/)?.[1]).toContain("--octant-ui-font-size");
  });

  it("puts Tailwind's type and family utilities on the same projection", () => {
    // A component reaching for `text-sm` must land on the same size a
    // stylesheet does; Tailwind's own ramp is frozen and cannot hear the
    // setting.
    const tailwind = readFileSync(resolve(cssRoot, "tailwind.css"), "utf8");
    for (const step of ["xs", "sm", "base", "lg", "xl", "2xl"]) {
      expect(tailwind, `Tailwind --text-${step} must point at the Octant token`).toMatch(
        new RegExp(`--text-${step}:\\s*var\\(--oct-text-${step}\\)`),
      );
    }
    expect(tailwind).toMatch(/--font-sans:\s*var\(--oct-font-body\)/);
    expect(tailwind).toMatch(/--font-mono:\s*var\(--oct-font-mono\)/);
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

  it("leaves no interface text frozen at a pixel size the setting cannot reach", () => {
    // The `--oct-text-*` ladder moving with the setting only helps the rules
    // that use it. Hundreds of rules named a pixel size directly, which is
    // most of what a user actually reads, so Appearance's interface font size
    // still looked ignored. Each remaining literal below is a size that must
    // NOT follow that setting, and says why.
    const allowed = new Map<string, ReadonlyArray<string>>([
      // These declare the settings themselves.
      [
        "styles.css",
        ["--octant-ui-font-size", "--octant-editor-font-size", "--octant-terminal-font-size"],
      ],
      [
        "styles/octant.css",
        [
          // The transcript carries its own size setting.
          "--oct-transcript-font-size",
          // A decorative glyph, sized to the panel it sits in.
          ".quote-mark",
          // Monospace surfaces follow the code and terminal typography settings.
          ".codeblock",
          ".runpanel-body",
          ".runline .k",
          ".diff",
          ".term",
        ],
      ],
    ]);

    for (const file of collectCssFiles(shippedCssRoot)) {
      const relative = file.slice(shippedCssRoot.length + 1);
      const source = readFileSync(file, "utf8");
      for (const block of cssBlocks(source)) {
        if (!/font-size:\s*\d+px/.test(block.declarations)) continue;
        const selector = block.selector.trim();
        const reasons = allowed.get(relative) ?? [];
        expect(
          reasons.some(
            (reason) => selector.startsWith(reason) || block.declarations.includes(reason),
          ),
          `${relative} ${selector} freezes a font size the interface setting cannot reach`,
        ).toBe(true);
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
