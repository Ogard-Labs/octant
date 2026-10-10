import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_CATEGORY_ORDER,
  PROVIDER_PART_ORDER,
  contextCategoryTone,
} from "../context/contextInspectorModel";

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

  it("rounds every corner from a radius token", () => {
    // One role, one number: a corner is a token, square, a circle, or the 1–4px
    // of a mark. Rem literals rounded seven panels at seven sizes, and a rem
    // corner also shrinks with the interface font size while a token does not.
    const corner =
      /^(?:0|50%|inherit|[1-4]px|var\(--(?:oct-radius-[a-z-]+|radius-(?:sm|md|lg|xl))\))$/;
    const declaration = /border(?:-[a-z]+-[a-z]+)?-radius:\s*([^;]+);/g;
    const strays = cssFiles(webRoot).flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(declaration)]
        .map((match) => (match[1] ?? "").trim())
        .filter((value) => !value.split(/[\s/]+/).every((part) => corner.test(part)))
        .map((value) => `${relative(webRoot, path)}: ${value}`),
    );

    expect(strays).toEqual([]);
  });

  it("gives a card, a menu, and a popover the same corner", () => {
    // The recipes round cards, menus, and popovers at their `xl` step and the
    // stylesheets round panels at the medium token. They were 14px and 16px, so
    // a menu sat beside a popover with a different corner.
    // The recipes' scale keeps its one root (0090), so the two numbers are
    // read and compared rather than one aliased to the other.
    const px = (source: string, pattern: RegExp) => Number(source.match(pattern)?.[1]);
    const tailwind = readFileSync(join(webRoot, "styles/tailwind.css"), "utf8");
    const theme = readFileSync(join(webRoot, "styles/shadcn-theme.css"), "utf8");
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    const control = px(system, /--oct-radius-sm:\s*(\d+)px;/);
    const card = px(system, /--oct-radius-md:\s*(\d+)px;/);
    const rootStep = px(theme, /--radius:\s*calc\(var\(--oct-radius-sm\) - (\d+)px\);/);
    const cardStep = px(tailwind, /--radius-xl:\s*calc\(var\(--radius\) \+ (\d+)px\);/);
    expect(control - rootStep + cardStep).toBe(card);
    // The radius scale has one definition; the second, unread set is gone.
    const styles = readFileSync(join(webRoot, "styles.css"), "utf8");
    expect(styles).not.toMatch(/--octant-radius-[a-z]+:/);
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

  it("keeps every recipe control on whole pixels at the default interface size", () => {
    // Recipe heights are rem so a control grows with the interface size, and the
    // root is 13px. A quarter-rem step is 3.25px there, so an odd step lands
    // between pixels: `h-7` drew about a hundred 24.5px buttons. An odd step
    // goes through `round(…, 2px)` instead.
    const oddStep = /(?<![\w:-])(?:min-h|h|size)-(\d+)(?![\w.[-])/g;
    const strays = sourceFiles(join(webRoot, "ui/shadcn"), ".tsx").flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(oddStep)]
        .filter((match) => Number(match[1]) >= 5 && Number(match[1]) % 2 === 1)
        .map((match) => `${relative(webRoot, path)}: ${match[0]}`),
    );

    expect(strays).toEqual([]);
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
    expect(input).toMatch(/padding:\s*18px var\(--oct-composer-gutter\) 12px/);
  });

  it("keeps composer focus on the same quiet surface", () => {
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    const focus =
      system.match(
        /\.composer:focus-within:has\(\.composer-input:focus-visible\)\s*\{[^}]+\}/,
      )?.[0] ?? "";

    expect(focus).toBe("");
    expect(system).not.toMatch(/\.composer:focus-within:has\(\.composer-input:focus-visible\)/);
    expect(system).toMatch(
      /\.composer:focus-within\s*\{\s*box-shadow:\s*var\(--octant-shadow-md\)/,
    );
  });

  it("wraps the model picker's catalog filters instead of hiding the later ones behind a sideways scroll", () => {
    const css = readFileSync(join(webRoot, "styles.css"), "utf8");
    const rule = /\.composer-model-picker__catalogs\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/flex-wrap:\s*wrap/);
    expect(rule).not.toMatch(/overflow-x:\s*auto/);
  });

  it("keeps focused buttons free of a drawn outline", () => {
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");

    // The button recipe owns interaction semantics, while the app keeps focus
    // visually quiet so selected and expanded fills carry the state cue.
    expect(system).not.toMatch(/\[data-slot="button"\]:focus-visible\s*\{[^}]*outline:/);
  });

  it("keeps number steppers free of a focus halo", () => {
    const settings = readFileSync(join(webRoot, "styles/settings.css"), "utf8");
    const focus =
      settings.match(/\.octant-number-stepper:focus-within\s*\{([\s\S]*?)\}/)?.[1] ?? "";

    expect(focus).not.toBe("");
    expect(focus).toMatch(/background:\s*var\(--octant-control-hover\)/);
    expect(focus).not.toMatch(/box-shadow:\s*(?!none\s*;)[^;]+;/);
  });

  it("draws one neutral keyboard focus edge that no surface suppresses or repaints", () => {
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    const bridge = readFileSync(join(webRoot, "styles/octant-bridge.css"), "utf8");
    const withoutComments = system.replace(/\/\*[\s\S]*?\*\//g, "");

    // Assert the rule was found before asserting about it, so the negative
    // checks below cannot pass on an empty string.
    const rule = withoutComments.match(/(?:^|\n)\s*:focus-visible\s*\{[^}]+\}/)?.[0] ?? "";
    expect(rule).not.toBe("");

    // A focus fill alone was the hover fill, so keyboard focus could not be
    // told from the pointer. One inset edge, declared once, is the indicator.
    expect(rule).toMatch(/outline:\s*2px solid var\(--oct-focus-edge\)/);
    expect(rule).toMatch(/outline-offset:\s*-2px/);
    expect(rule).not.toMatch(/background|box-shadow|border-radius/);
    expect(withoutComments).not.toMatch(/:focus-visible[^{]*\{[^}]*text-decoration:\s*underline/);

    // Mixed from the foreground, never from the accent or the focus-ring theme
    // role, so it holds contrast on any surface without a coloured halo.
    const edge = bridge.match(/--oct-focus-edge:[^;]+;/)?.[0] ?? "";
    expect(edge).toMatch(/var\(--oct-fg\)/);
    expect(edge).not.toMatch(/accent|focus-ring/);

    // A control filled with the accent inverts the edge, or it draws the edge
    // in the colour it is already painted with.
    expect(withoutComments).toMatch(
      /\[data-slot="button"\]\[data-variant="default"\]:focus-visible[^{]*\{[^}]*--oct-focus-edge-on-accent/,
    );

    // A feature stylesheet may move the edge (an inline link, a drawn mark)
    // but may not suppress it, colour it, or draw a second ring of its own.
    for (const file of cssFiles(webRoot)) {
      if (file.endsWith(join("styles", "octant.css"))) continue;
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const block of source.matchAll(/([^{}]*):focus-visible[^{}]*\{([^}]*)\}/g)) {
        const where = `${relative(webRoot, file)} on ${block[1]?.trim() ?? ""}`;
        expect(block[2], `${where} suppresses the focus edge`).not.toMatch(
          /outline:\s*(?:none|0)\b/,
        );
        expect(block[2], `${where} draws its own focus ring`).not.toMatch(
          /outline(?:-color)?:[^;]*(?:solid|focus-ring)|box-shadow:[^;]*focus-ring/,
        );
      }
    }
  });

  it("keeps one transcript rhythm across Chat, Work, and Code", () => {
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    const chat = readFileSync(join(webRoot, "styles/chat.css"), "utf8");
    const styles = readFileSync(join(webRoot, "styles.css"), "utf8");
    const transcripts = [
      "chat/ChatTranscript.tsx",
      "work/WorkThreadWorkspace.tsx",
      "code/CodeThreadWorkspace.tsx",
    ].map((path) => readFileSync(join(webRoot, path), "utf8"));
    const composers = [
      "chat/ChatComposer.tsx",
      "work/WorkThreadWorkspace.tsx",
      "code/CodeThreadWorkspace.tsx",
    ].map((path) => readFileSync(join(webRoot, path), "utf8"));

    // The bubble, its time, the reply, the composer frame, its controls, and
    // its status line are painted once, in the system. Before this Work's
    // message was a full-width sticky slab, Chat's bubble carried a hairline
    // shadow over its border, Code drew message and status classes of its
    // own, and each mode's composer row sized its controls differently.
    expect(system).toMatch(/\.turn-user \.bubble \{[^}]*box-shadow:\s*none/);
    expect(system).toMatch(/\.turn-user \{[^}]*justify-items:\s*end/);
    expect(system).not.toMatch(/\.turn-user \{[^}]*position:\s*sticky/);
    // The conversation supplies the reading background even over a pattern;
    // individual reply cards must not return and compete with the composer.
    expect(system).toMatch(/\n\.turn-agent \{[^}]*background:\s*transparent/);
    expect(system).toMatch(/\n\.turn-agent \{[^}]*border:\s*0;/);
    expect(system).not.toMatch(
      /\.shell--(?:app-backdrop|workspace-material-translucent) \.turn-agent/,
    );
    expect(system).toMatch(/\.composer\.thread-composer \{[^}]*margin:\s*24px auto 12px;/);
    expect(system).toMatch(
      /\.composer-row button,\n\.composer-row \[role="button"\],\n\.composer-row \[role="combobox"\] \{\n  min-height: 28px;\n  height: 28px;/,
    );
    expect(chat).not.toMatch(/\.chat-transcript \.turn-user/);
    expect(chat).not.toMatch(/\.chat-composer__status \{/);
    expect(styles).not.toMatch(/\.code-thread-workspace__message--user/);
    expect(styles).not.toMatch(/\.code-thread-workspace__composer \.composer-(?:input|row)\b/);
    expect(styles).not.toMatch(/\.code-thread-workspace__status \{/);
    for (const source of transcripts) {
      expect(source).toContain("transcript-scroll");
      expect(source).toContain("turn-user");
      expect(source).toContain("turn-agent");
      expect(source).toContain("<TurnTime");
      expect(source).toContain("<AssistantMessageBody");
    }
    for (const source of composers) {
      expect(source).toContain("thread-composer");
      // Chat composes its status class with its live/quiet modifiers.
      expect(source).toMatch(/className=\{?[`"]composer-status\b/);
    }
  });

  it("lets a table or code block reach the column's width in any reply", () => {
    const chat = readFileSync(join(webRoot, "styles/chat.css"), "utf8");
    // The reading measure belongs to running text. On the wrapper a reply that
    // also reasoned or used a tool was capped whole, so its table stayed narrow
    // while a plain reply's could run wide.
    const parts = chat.match(/\.chat-transcript__parts\s*\{[^}]+\}/)?.[0] ?? "";
    expect(parts).not.toContain("max-width");
    expect(chat).toMatch(
      /\.chat-rich-text > :is\(p, ul, ol, h2, h3, h4, blockquote\)\s*\{\s*max-width: 72ch;/,
    );
    expect(chat).toMatch(/\.chat-transcript__parts > \.thinking\s*\{\s*max-width: 72ch;/);
  });

  it("does not add a switch-specific focus ring after its reset", () => {
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    const track = system.match(/\.octant-switch\[data-slot="switch"\]\s*\{[^}]+\}/)?.[0] ?? "";

    // The track drops the adapter's drop shadow and does not reintroduce a
    // focus halo; checked state remains the visible switch cue.
    expect(track).toMatch(/box-shadow:\s*none/);
    expect(system).toMatch(
      /\.octant-switch\[data-slot="switch"\]:focus-visible:not\(\[data-checked\]\)/,
    );
  });

  it("does not add a wrapper focus halo around the Issues search", () => {
    const github = readFileSync(join(webRoot, "styles/github.css"), "utf8");
    const input =
      github.match(/\.github-issue-browser__search input\[type="search"\]\s*\{[^}]+\}/)?.[0] ?? "";

    // The inner input keeps its compact reset, and the wrapper stays free of a
    // second focus treatment.
    expect(input).toMatch(/box-shadow:\s*none/);
    expect(github).not.toMatch(/:has\(input\[type="search"\]:focus-visible\)/);
  });

  it("keeps empty composer pickers as quiet toolbar items instead of nested fields", () => {
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    const emptyPicker =
      system.match(/\.composer-row \.composer-model-picker--empty\s*\{[^}]+\}/)?.[0] ?? "";

    expect(emptyPicker).toMatch(/padding:\s*0/);
    expect(emptyPicker).toMatch(/border:\s*0/);
    expect(emptyPicker).toMatch(/background:\s*transparent/);
  });

  it("holds the shared context row inside the composer on every welcome", () => {
    const surface = readFileSync(join(webRoot, "styles/surface.css"), "utf8");
    const stack = surface.match(/\.composer-stack \{\n(?:.*\n)*?\}/m)?.[0] ?? "";
    const strip = surface.match(/\.composer-tray--inside \{\n(?:.*\n)*?\}/m)?.[0] ?? "";
    const prompt =
      surface.match(/\.composer-stack > \.composer > \.composer-input \{\n(?:.*\n)*?\}/m)?.[0] ??
      "";
    const welcomes = [
      "chat/ChatWelcome.tsx",
      "work/composer/WorkComposerAdapter.tsx",
      "code/composer/CodeComposerAdapter.tsx",
    ].map((path) => readFileSync(join(webRoot, path), "utf8"));

    expect(stack).toMatch(/flex-direction:\s*column/);
    // One card: where the thread runs is the first row inside it, as small
    // chips with no band behind them, so the card stays a single object and a
    // control opening a list can never push the prompt down the page.
    expect(strip).toMatch(/display:\s*flex/);
    expect(strip).not.toMatch(/box-shadow/);
    expect(strip).not.toMatch(/position:\s*absolute/);
    expect(strip).not.toMatch(/background/);
    expect(strip).not.toMatch(/border-top/);
    // A prompt is a paragraph: four lines before the box grows.
    expect(prompt).toMatch(/min-height:\s*96px/);
    for (const source of welcomes) {
      expect(source).toMatch(/className="composer-tray composer-tray--inside"/);
      expect(source).not.toMatch(/footer=\{\s*<div className="composer-tray"/);
      expect(source).not.toContain("context-strip");
    }
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
    expect(activePane).toMatch(/background:\s*transparent/);
    expect(activePane).not.toMatch(/border-color:\s*var\(--octant-border-strong\)/);
  });

  it("gives icon-only controls two sizes: the rail button and the row action", () => {
    const styles = readFileSync(join(webRoot, "styles/project-threads.css"), "utf8");
    const code = readFileSync(join(webRoot, "styles/code.css"), "utf8");
    // A panel's icon control is the 28px rail button. The terminal's actions
    // button was 26px and both Refresh buttons took a rem size from the recipe,
    // which rendered 25px and 29px beside the 28px controls around them.
    const terminal = code.match(/\.code-terminal-pane__actions-trigger\s*\{[^}]+\}/)?.[0] ?? "";
    expect(terminal).toContain("width: var(--oct-rail-button-h);");
    expect(terminal).toContain("height: var(--oct-rail-button-h);");
    for (const file of ["code/CodeFileExplorer.tsx", "work/WorkFilesPanel.tsx"]) {
      const source = readFileSync(join(webRoot, file), "utf8");
      expect(source).toMatch(/<OctantIconButton[^>]*label="Refresh files"/s);
    }
    // An action inside a row is a 24px square, on a Project row as on a thread row.
    const projectAction = styles.match(/\.project-row__action--icon\s*\{[^}]+\}/)?.[0] ?? "";
    expect(projectAction).toContain("height: 24px;");
    expect(projectAction).not.toContain("height: var(--oct-nav-row-h);");
  });

  it("retires the legacy underline tab paint from feature surfaces", () => {
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    const artifacts = readFileSync(join(webRoot, "artifacts/ArtifactLibraryView.tsx"), "utf8");

    expect(system).not.toMatch(/^\.tabs\s*\{/m);
    expect(system).not.toMatch(/^\.tab\s*\{/m);
    expect(artifacts).not.toContain('className="artifact-library__tabs tabs"');
    expect(artifacts).not.toContain('className="artifact-library__tab tab"');
  });

  it("aligns Appearance subgroups to the open section edge like every other row", () => {
    const settings = readFileSync(join(webRoot, "styles/settings.css"), "utf8");
    const themeGroup = settings.match(/\.settings-view__theme-group \{[^}]+\}/)?.[0] ?? "";
    const legend = settings.match(/\.settings-view__theme-group legend \{[^}]+\}/)?.[0] ?? "";

    expect(themeGroup).toMatch(/padding:\s*0;/);
    expect(themeGroup).not.toMatch(/padding:\s*12px 20px 8px/);
    // An unfloated legend is the fieldset's rendered legend and notches the
    // group's top rule; the subgroup label has to lay out as an ordinary child
    // wearing the section-label recipe over its own hairline.
    expect(legend).toMatch(/float:\s*left/);
    expect(legend).toMatch(/border-bottom:\s*1px solid var\(--oct-hairline\)/);
    expect(legend).toMatch(/font-size:\s*var\(--oct-text-sm\)/);
  });

  it("uses the open layout for Settings groups and inline editors", () => {
    const settings = readFileSync(join(webRoot, "styles/settings.css"), "utf8");

    expect(settings).toMatch(
      /\.settings-view\s*\{[^}]*background:\s*var\(--octant-app-background\)/,
    );
    expect(settings).toMatch(/--oct-settings-reading-width:\s*920px/);
    expect(settings).toMatch(/\.settings-view__content-inner\s*\{[^}]*margin:\s*0/);
    expect(settings).toMatch(/\.settings-card-section\s*\{[^}]*box-shadow:\s*none/);
    expect(settings).toMatch(/\.settings-card-section--open\s*\{[^}]*box-shadow:\s*none/);
    // The section itself stays unboxed: its label and description sit on the
    // page, and the card is the group inside it (see sectionObject.test.ts).
    expect(settings).toMatch(/\.settings-card-section\s*\{[^}]*border:\s*0/);
    expect(settings).not.toMatch(/border-inline:\s*1px solid var\(--oct-hairline\)/);
    expect(settings).toMatch(
      /\.settings-card-section\s*>\s*h2,[\s\S]*?\.settings-card-section\s*>\s*legend\s*\{[\s\S]*?text-transform:\s*none/,
    );
    expect(settings).not.toMatch(
      /\.settings-theme-editor__disclosure,\n\.settings-theme-editor__accessibility \{\n(?:.*\n)*?background:\s*none/,
    );
    // Chat and Code defaults are SettingRows in the open grammar; the
    // bespoke field recipes that laid them out as a form are gone, and their
    // free-text controls take the shared control column.
    expect(settings).not.toMatch(/\.code-settings__field/);
    expect(settings).not.toMatch(/\.code-settings__section/);
    expect(settings).toMatch(
      /\.code-settings \.setrow-control > \.settings-view__text-input\s*\{[^}]*width:\s*var\(--oct-settings-control\)/,
    );
    // Actions that act on a whole collection sit on the label line, not in a
    // card header or a floating toolbar.
    expect(settings).toMatch(/\.settings-section-head\s*\{[^}]*justify-content:\s*space-between/);
    expect(settings).not.toMatch(/\.octant-switch\s*\{/);
  });

  it("keeps Settings navigation and explanatory text readable without shouting", () => {
    const settings = readFileSync(join(webRoot, "styles/settings.css"), "utf8");
    const navigation =
      settings.match(/(?:^|\n)\.settings-navigation \.setnav-section\s*\{[^}]+\}/)?.[0] ?? "";
    const hint = settings.match(/\.setrow-hint\s*\{[^}]+\}/)?.[0] ?? "";

    expect(navigation).toMatch(/font-size:\s*var\(--oct-text-detail\)/);
    expect(navigation).toMatch(/font-weight:\s*var\(--oct-weight-regular\)/);
    expect(navigation).toMatch(/text-transform:\s*none/);
    expect(navigation).toMatch(/letter-spacing:\s*normal/);
    // The desktop rail shows its group labels; a quiet label is what separates
    // one group of pages from the next, not a hairline and not a hidden name.
    // Any way of hiding them counts: the sr-only recipe, display, visibility.
    const sidebarLabelRules = settings.match(
      /\.settings-view__sidebar[^{]*\.setnav-section[^{]*\{[^}]*\}/g,
    );
    for (const rule of sidebarLabelRules ?? []) {
      expect(rule).not.toMatch(
        /clip-path|display:\s*none|visibility:\s*hidden|width:\s*1px|font-size:\s*0/,
      );
    }
    expect(settings).not.toMatch(
      /\.settings-navigation__group \+ \.settings-navigation__group\s*\{[^}]*border-top/,
    );
    expect(hint).toMatch(/font-size:\s*var\(--oct-text-detail\)/);
  });

  it("gives every single-line Settings control one height", () => {
    const settings = readFileSync(join(webRoot, "styles/settings.css"), "utf8");
    const runtime = readFileSync(join(webRoot, "styles.css"), "utf8");
    // The recipe's default is 28px. The older field rows set 32px while the
    // newer sections took the recipe's height, so the same select was 32px on
    // one page and 28px on the next, and steppers stood 32px beside both.
    const heights = [...settings.matchAll(/--oct-settings-control-height:\s*([^;]+);/g)].map(
      (match) => match[1],
    );
    expect(heights.length).toBeGreaterThan(0);
    expect(new Set(heights)).toEqual(new Set(["28px"]));
    expect(settings).toMatch(
      /\.octant-number-stepper__input \{[^}]*height: calc\(var\(--oct-settings-control-height, 28px\) - 2px\);/,
    );
    expect(runtime).toMatch(
      /\.settings-view__text-input\[type="color"\] \{[^}]*height: var\(--oct-settings-control-height, 28px\);/,
    );
  });

  describe("categorical colour in the context window", () => {
    const css = readFileSync(join(webRoot, "context/context.css"), "utf8");
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((match) => ({
      selector: (match[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "").trim(),
      body: match[2] ?? "",
    }));
    const toneRule = (tone: number) =>
      rules.find((rule) => rule.selector.endsWith(`[data-tone="${String(tone)}"]`));
    const hues = ["blue", "orange", "purple", "teal", "green", "pink", "yellow"];

    it("gives the parts of the window a hue in every style, from the palette roles", () => {
      // The Default style is monochrome chrome; the parts of a context window
      // are categorical data, which DESIGN.md allows to keep colour beside a
      // name. Seven hues in two steps; red stays the ring's near-full warning.
      hues.forEach((hue, index) => {
        expect(toneRule(index + 1)?.body).toContain(`var(--octant-palette-${hue},`);
        const shaded = toneRule(index + 8)?.body ?? "";
        expect(shaded).toContain(`var(--octant-palette-${hue},`);
        expect(shaded).toContain("var(--octant-text-primary)");
      });
      expect(toneRule(15)).toBeUndefined();
      expect(css).not.toMatch(/data-tone[^{]*\{[^}]*--octant-palette-red/);
    });

    it("confines palette colour in that sheet to the window's tones, the ring and the limit bars", () => {
      const withPalette = rules.filter((rule) => rule.body.includes("--octant-palette-"));

      expect(withPalette.length).toBeGreaterThan(0);
      for (const rule of withPalette) {
        expect(rule.selector).toMatch(
          /\[data-tone="\d+"\]|\.composer-context-meter\b|\.context-window-popover__limit/,
        );
      }
    });

    it("keeps free space and reserved room neutral", () => {
      const neutral = rules.find(
        (rule) =>
          rule.selector.includes(".context-window-popover,") &&
          rule.selector.includes(".context-entry-card"),
      );

      // A segment with no tone takes the neutral fill: ink over the panel.
      expect(neutral?.body).toMatch(
        /--context-window-tone:\s*color-mix\(\s*in oklab,\s*var\(--octant-text-primary\)[^;]*var\(--octant-floating\)\s*\)/,
      );
      expect(neutral?.body).not.toContain("--octant-palette-");
      // Free space is the empty track, drawn as the track.
      const freeSwatch = rules.find((rule) =>
        rule.selector.includes('tr[data-kind="free"] .context-window-popover__swatch'),
      );
      expect(freeSwatch?.body).toContain("background: var(--context-window-track)");
      expect(
        rules.some(
          (rule) =>
            /data-kind="(?:free|reserved)"/.test(rule.selector) &&
            rule.body.includes("--octant-palette-"),
        ),
      ).toBe(false);
    });

    it("keeps every tone legible on the popover and every pair of neighbours clearly apart, in both themes", () => {
      // Seven hues cannot all be far apart in lightness while each holds 5:1
      // against the panel, so neighbours are separated by hue: a perceptual
      // distance in OKLab, on top of the one-pixel gap and the names beside
      // every swatch.
      const styles = readFileSync(join(webRoot, "styles.css"), "utf8");
      const lightAt = styles.indexOf('html[data-octant-theme-mode="light"] {');
      const sheets = { dark: styles.slice(0, lightAt), light: styles.slice(lightAt) };
      const shade =
        Number(/\[data-tone="8"\][^{]*\{[^}]*?\)\s*(\d+)%,/.exec(css)?.[1] ?? "NaN") / 100;
      expect(shade).toBeGreaterThan(0);

      const channel = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      const rgb = (value: string) =>
        [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255) as [number, number, number];
      const oklab = ([r, g, b]: readonly [number, number, number]) => {
        const [R, G, B] = [channel(r), channel(g), channel(b)] as const;
        const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
        const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
        const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
        return [
          0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
          1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
          0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
        ] as const;
      };
      const luminance = (value: readonly [number, number, number]) =>
        0.2126 * channel(value[0]) + 0.7152 * channel(value[1]) + 0.0722 * channel(value[2]);
      const ratio = (
        a: readonly [number, number, number],
        b: readonly [number, number, number],
      ) => {
        const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
        return (hi + 0.05) / (lo + 0.05);
      };
      // The shaded step mixes the hue toward the ink in OKLab, as color-mix does.
      const shaded = (
        hue: readonly [number, number, number],
        ink: readonly [number, number, number],
      ) => {
        const [h, i] = [oklab(hue), oklab(ink)];
        const [L, a, b] = h.map((v, n) => v * shade + (i[n] ?? 0) * (1 - shade)) as [
          number,
          number,
          number,
        ];
        const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
        const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
        const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
        const lin = [
          4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
          -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
          -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
        ];
        return lin.map((c) =>
          Math.min(1, Math.max(0, c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)),
        ) as [number, number, number];
      };
      const distance = (
        a: readonly [number, number, number],
        b: readonly [number, number, number],
      ) => {
        const [x, y] = [oklab(a), oklab(b)];
        return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
      };

      const planned = [
        ...CONTEXT_CATEGORY_ORDER.filter((key) => key !== "reserves"),
        "observed-overhead",
      ];
      // A part Octant counted appears only when the runtime reported none, so
      // the two never stand in one bar.
      const octantOnly: ReadonlyArray<string> = [
        "octant-instructions",
        "octant-tools",
        "attachments",
      ];
      const reported = [
        ...PROVIDER_PART_ORDER.filter((key) => key !== "reserved" && !octantOnly.includes(key)),
        "other-provider",
      ];
      // Everything Octant can count for a runtime that reports one figure, in
      // the order the bar lists it.
      const counted = [
        ...PROVIDER_PART_ORDER.filter((key) => octantOnly.includes(key) || key === "skills"),
        "other-provider",
      ];

      for (const [theme, sheet] of Object.entries(sheets)) {
        const grab = (name: string) =>
          new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i").exec(sheet)?.[1] ?? "";
        const floating = rgb(grab("--octant-floating"));
        const ink = rgb(grab("--octant-text-primary"));
        const tones = new Map<number, [number, number, number]>();
        hues.forEach((hue, index) => {
          const base = rgb(grab(`--octant-palette-${hue}`));
          tones.set(index + 1, base);
          tones.set(index + 8, shaded(base, ink));
        });
        const colour = (key: string) => {
          const tone = contextCategoryTone(key);
          expect(tone, `${key} has a tone`).toBeDefined();
          return tones.get(tone as number) as [number, number, number];
        };
        for (const order of [planned, reported, counted]) {
          order.forEach((key, index) => {
            expect(
              ratio(colour(key), floating),
              `${theme} ${key} against the popover`,
            ).toBeGreaterThanOrEqual(3);
            const before = order[index - 1];
            if (before !== undefined) {
              expect(
                distance(colour(key), colour(before)),
                `${theme}: ${before} next to ${key}`,
              ).toBeGreaterThanOrEqual(0.1);
            }
          });
        }
      }
    });

    it("leaves the context ring coloured, amber and then red when nearly full", () => {
      expect(css).toMatch(
        /\.composer-context-meter \{\s*--composer-context-meter-ink: var\(--octant-palette-orange/,
      );
      expect(css).toMatch(
        /\.composer-context-meter\[data-fill="high"\] \{\s*--composer-context-meter-ink: var\(--octant-palette-red/,
      );
    });
  });

  it("keeps Usage on the open grammar instead of stat cards", () => {
    const usage = readFileSync(join(webRoot, "styles/usage.css"), "utf8");
    const dashboard = readFileSync(join(webRoot, "usage/UsageDashboard.tsx"), "utf8");
    const limits = readFileSync(join(webRoot, "usage/ProviderUsageLimitsPanel.tsx"), "utf8");

    // Totals are labelled numbers, exports are ordinary buttons, and provider
    // limits are rows over hairlines: no tile or card recipe carries a lift.
    expect(usage).not.toMatch(
      /\.usage-(?:stat-card|dashboard__total-card|total)[^{]*\{[^}]*box-shadow/,
    );
    expect(usage).not.toMatch(/text-transform:\s*uppercase/);
    expect(usage).toMatch(/\.usage-total__value\s*\{[^}]*font-size:\s*var\(--oct-text-xl\)/);
    expect(dashboard).not.toMatch(/text-transform:\s*uppercase|\buppercase\b/);
    expect(dashboard).not.toContain("OctantCard");
    expect(dashboard).toContain('className="surface-toolbar"');
    expect(dashboard).toContain("<SurfaceSection");
    expect(dashboard).toContain("<SurfaceEmpty");
    expect(limits).not.toContain("OctantCard");
    expect(limits).toContain('className="surface-row provider-limits__row"');
  });
});
