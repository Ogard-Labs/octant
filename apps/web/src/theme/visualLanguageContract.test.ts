import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = join(process.cwd(), "src");
const leftoverRadius = /border-radius:\s*(?:[5-9]|1[0-4])px\b/;
const leftoverButtonPaint = /\.btn-(?:primary|secondary|ghost|danger|icon|group)\b/;
const leftoverButtonClass = /\bbtn-(?:icon|group)\b/;

function sourceFiles(directory: string, suffix: string): ReadonlyArray<string> {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      found.push(...sourceFiles(path, suffix));
      continue;
    }
    if (entry.endsWith(suffix)) found.push(path);
  }
  return found;
}

function cssFiles(directory: string): ReadonlyArray<string> {
  return sourceFiles(directory, ".css");
}

describe("the public-block visual language", () => {
  it("does not leave old 5–14px radii on product chrome", () => {
    const leftovers = cssFiles(webRoot)
      .map((path) => ({
        path: relative(webRoot, path),
        css: readFileSync(path, "utf8"),
      }))
      .filter((file) => leftoverRadius.test(file.css))
      .map((file) => file.path);

    expect(leftovers).toEqual([]);
  });

  it("does not keep leftover .btn colour recipes beside the adapter", () => {
    const leftovers = cssFiles(webRoot)
      .map((path) => ({
        path: relative(webRoot, path),
        css: readFileSync(path, "utf8"),
      }))
      .filter((file) => leftoverButtonPaint.test(file.css))
      .map((file) => file.path);

    expect(leftovers).toEqual([]);
  });

  it("does not leave leftover OctantNativeSelect on product surfaces", () => {
    const leftovers = ["tsx", "ts"]
      .flatMap((suffix) => sourceFiles(webRoot, `.${suffix}`))
      .filter((path) => !path.includes(".test."))
      .map((path) => ({
        path: relative(webRoot, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter((file) => file.source.includes("OctantNativeSelect"))
      .map((file) => file.path);

    expect(leftovers).toEqual([]);
  });

  it("does not leave leftover btn-icon or btn-group class names on product surfaces", () => {
    const leftovers = ["tsx", "ts"]
      .flatMap((suffix) => sourceFiles(webRoot, `.${suffix}`))
      .filter((path) => !path.includes(".test."))
      .map((path) => ({
        path: relative(webRoot, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter((file) => leftoverButtonClass.test(file.source))
      .map((file) => file.path);

    expect(leftovers).toEqual([]);
  });

  it("does not flatten the Code composer into two hairline boxes", () => {
    const shell = readFileSync(join(webRoot, "styles/shell.css"), "utf8");
    const styles = readFileSync(join(webRoot, "styles.css"), "utf8");

    // The adapter card is a layout hook on `.composer`. Flattening it
    // (transparent, no radius, no lift) and boxing the input and row as
    // separate fields is what left Code welcome looking like the old chrome
    // after the shared recipe shipped.
    expect(shell).not.toMatch(/\.code-composer-adapter__card\s*\{[^}]*box-shadow:\s*none/);
    expect(shell).not.toMatch(/\.code-composer-adapter__card\s*>\s*\.composer-row\s*\{/);
    expect(styles).not.toMatch(/\.code-thread-workspace__composer\s*\{[^}]*box-shadow:\s*none/);
  });

  it("lifts the composer with the mid shadow, not the hairline-only small shadow", () => {
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    const runtime = readFileSync(join(webRoot, "styles.css"), "utf8");
    const frame = system.match(/^\.composer \{\n(?:.*\n)*?\}/m)?.[0] ?? "";
    const darkShadow = runtime.match(/--octant-shadow-md:\s*[^;]+;/s)?.[0] ?? "";
    const lightTheme =
      runtime.match(/html\[data-octant-theme-mode="light"\]\s*\{[^}]+\}/s)?.[0] ?? "";

    expect(frame).toMatch(/box-shadow:\s*var\(--octant-shadow-md\)/);
    expect(frame).not.toMatch(/box-shadow:\s*var\(--octant-shadow-sm\)/);
    expect(darkShadow).toMatch(/0 10px 18px -8px/);
    expect(lightTheme).toMatch(/--octant-shadow-md:[^;]*0 10px 15px -3px/s);
  });

  it("keeps the composer prompt frameless so the shadcn textarea cannot paint a second field", () => {
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    const input = system.match(/\.composer-input\s*\{[^}]+\}/)?.[0] ?? "";

    // OctantTextarea ships rounded-md + shadow-xs. Those must not survive
    // inside `.composer`, or Code/Chat welcome read as a 10px field sitting
    // in a 20px frame — the old two-box chrome.
    expect(input).toMatch(/border-radius:\s*0/);
    expect(input).toMatch(/box-shadow:\s*none/);
    expect(input).toMatch(/border:\s*0/);
    expect(input).toMatch(/padding:\s*18px 16px 12px/);
  });

  it("keeps keyboard focus inside the composer edge instead of drawing a detached halo", () => {
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    const focus =
      system.match(
        /\.composer:focus-within:has\(\.composer-input:focus-visible\)\s*\{[^}]+\}/,
      )?.[0] ?? "";

    expect(focus).toMatch(/outline:\s*2px solid var\(--oct-accent\)/);
    expect(focus).toMatch(/outline-offset:\s*-2px/);
  });

  it("keeps empty composer pickers as quiet toolbar items instead of nested fields", () => {
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    const emptyPicker =
      system.match(/\.composer-row \.composer-model-picker--empty\s*\{[^}]+\}/)?.[0] ?? "";

    expect(emptyPicker).toMatch(/padding:\s*0/);
    expect(emptyPicker).toMatch(/border:\s*0/);
    expect(emptyPicker).toMatch(/background:\s*transparent/);
  });

  it("tucks the Code checkout card behind the composer as a second raised card", () => {
    const shell = readFileSync(join(webRoot, "styles/shell.css"), "utf8");
    const stack = shell.match(/\.code-composer-adapter__stack \{\n(?:.*\n)*?\}/m)?.[0] ?? "";
    const dock = shell.match(/\.code-composer-adapter__dock \{\n(?:.*\n)*?\}/m)?.[0] ?? "";

    expect(stack).toMatch(/position:\s*relative/);
    expect(stack).toMatch(/isolation:\s*isolate/);
    expect(stack).toMatch(/flex-direction:\s*column/);
    expect(dock).toMatch(/margin:\s*-26px auto 0/);
    expect(dock).toMatch(/width:\s*calc\(100% - 40px\)/);
    expect(dock).toMatch(/padding:\s*22px 16px 6px/);
    expect(dock).toMatch(/border-radius:\s*var\(--oct-radius-lg\)/);
    expect(dock).toMatch(/box-shadow:\s*var\(--octant-shadow-sm\)/);
    expect(dock).not.toMatch(/border-radius:\s*0 0/);
    expect(dock).not.toMatch(/position:\s*absolute/);
  });

  it("does not keep a native select recipe on the composer row", () => {
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    expect(system).not.toMatch(/\.composer-row select\b/);
  });

  it("keeps the labeled mode switcher compact enough to preserve the Octant name", () => {
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    const trigger = system.match(/\.mode-trigger\s*\{[^}]+\}/)?.[0] ?? "";

    expect(trigger).toMatch(/gap:\s*var\(--oct-space-1\)/);
    expect(trigger).toMatch(/padding-inline:\s*var\(--oct-space-1\)/);
  });

  it("keeps true tabs, segmented choices, and pane identity visually distinct", () => {
    const tabs = readFileSync(join(webRoot, "ui/shadcn/tabs.tsx"), "utf8");
    const toggles = readFileSync(join(webRoot, "ui/shadcn/toggle-group.tsx"), "utf8");
    const shell = readFileSync(join(webRoot, "styles.css"), "utf8");
    const activePane =
      shell.match(
        /\.workspace-pane\[data-active="true"\] \.workspace-pane__grip\s*\{[^}]+\}/,
      )?.[0] ?? "";

    expect(tabs).toContain("inline-flex h-8 w-fit items-center gap-1 text-muted-foreground");
    expect(tabs).not.toContain("rounded-lg bg-muted p-[3px]");
    expect(tabs).toContain("data-selected:bg-muted");
    expect(tabs).not.toContain("data-selected:shadow-sm");
    expect(toggles).toContain("rounded-lg bg-muted p-[3px]");
    expect(activePane).toMatch(/background:\s*var\(--octant-control\)/);
    expect(activePane).not.toMatch(/border-color:\s*var\(--octant-border-strong\)/);
  });

  it("retires the legacy underline tab paint from feature surfaces", () => {
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    const artifacts = readFileSync(join(webRoot, "artifacts/ArtifactLibraryView.tsx"), "utf8");

    expect(system).not.toMatch(/^\.tabs\s*\{/m);
    expect(system).not.toMatch(/^\.tab\s*\{/m);
    expect(artifacts).not.toContain('className="artifact-library__tabs tabs"');
    expect(artifacts).not.toContain('className="artifact-library__tab tab"');
  });

  it("aligns Appearance subgroups to the Settings card content inset", () => {
    const settings = readFileSync(join(webRoot, "styles/settings.css"), "utf8");
    const themeGroup = settings.match(/\.settings-view__theme-group \{[^}]+\}/)?.[0] ?? "";

    expect(themeGroup).toMatch(/padding:\s*12px 20px 8px/);
    expect(themeGroup).not.toMatch(/padding:\s*12px 0 8px/);
  });

  it("uses open Settings groups for routine controls and raised cards for discrete objects", () => {
    const settings = readFileSync(join(webRoot, "styles/settings.css"), "utf8");

    expect(settings).toMatch(
      /\.settings-view\s*\{[^}]*background:\s*var\(--octant-app-background\)/,
    );
    expect(settings).toMatch(/--oct-settings-reading-width:\s*680px/);
    expect(settings).toMatch(/\.settings-view__content-inner\s*\{[^}]*margin:\s*0/);
    expect(settings).toMatch(
      /\.settings-card-section\s*\{[^}]*box-shadow:\s*var\(--octant-shadow-sm\)/,
    );
    expect(settings).toMatch(
      /\.settings-card-section--open\s*\{[^}]*background:\s*transparent[^}]*box-shadow:\s*none/,
    );
    expect(settings).toMatch(
      /\.settings-card-section\s*>\s*h2,[\s\S]*?\.settings-card-section\s*>\s*legend\s*\{[\s\S]*?text-transform:\s*none/,
    );
    expect(settings).not.toMatch(
      /\.settings-theme-editor__disclosure,\n\.settings-theme-editor__accessibility \{\n(?:.*\n)*?background:\s*none/,
    );
    expect(settings).toMatch(
      /\.code-settings\s*\{[^}]*background:\s*var\(--octant-settings-card\)/,
    );
    expect(settings).not.toMatch(/\.octant-switch\s*\{/);
  });

  it("keeps Settings navigation and explanatory text readable without shouting", () => {
    const settings = readFileSync(join(webRoot, "styles/settings.css"), "utf8");
    const navigation =
      settings.match(/(?:^|\n)\.settings-navigation \.setnav-section\s*\{[^}]+\}/)?.[0] ?? "";
    const hiddenDesktopGroups =
      settings.match(
        /\.settings-view__sidebar \.settings-navigation \.setnav-section\s*\{[^}]+\}/,
      )?.[0] ?? "";
    const hint = settings.match(/\.setrow-hint\s*\{[^}]+\}/)?.[0] ?? "";

    expect(navigation).toMatch(/font-size:\s*calc\(12 \* var\(--oct-text-step\)\)/);
    expect(navigation).toMatch(/text-transform:\s*none/);
    expect(navigation).toMatch(/letter-spacing:\s*normal/);
    expect(hiddenDesktopGroups).toMatch(/width:\s*1px/);
    expect(hiddenDesktopGroups).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(hint).toMatch(/font-size:\s*calc\(12 \* var\(--oct-text-step\)\)/);
  });
});
