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

  it("never underlines the model picker's settings group", () => {
    // The group holds labels and a slider, not a link. A leftover link recipe
    // on the same class underlined Effort, Default, Faster and Smarter.
    const rules = cssFiles(webRoot).flatMap((path) =>
      [
        ...readFileSync(path, "utf8").matchAll(/\.composer-model-picker__settings\s*\{([^}]*)\}/g),
      ].map((match) => match[1] ?? ""),
    );

    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule).not.toMatch(/text-decoration/);
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
    // The recipes' scale keeps its one root, so the two numbers are
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
    // A raised step is light on its top edge, then the shadow that lifts it.
    expect(darkShadow).toMatch(/inset 0 1px 0 var\(--octant-bevel\)/);
    expect(darkShadow).toMatch(/0 12px 24px -8px/);
    expect(lightTheme).toMatch(/--octant-shadow-md:[^;]*0 12px 24px -8px/s);
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
    // One line and 12px above and under it: the 44px pill.
    expect(input).toMatch(/padding:\s*12px var\(--oct-composer-gutter\);/);
  });

  it("draws no focus edge, border change, or lift on the composer frame", () => {
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");

    expect(system).not.toMatch(/\.composer[\w.-]*:focus-within/);
    expect(system).not.toMatch(/\.thread-composer__surface:focus-within/);
  });

  it("wraps the model picker's catalog filters instead of hiding the later ones behind a sideways scroll", () => {
    const css = readFileSync(join(webRoot, "styles.css"), "utf8");
    const rule = /\.composer-model-picker__catalogs\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/flex-wrap:\s*wrap/);
    expect(rule).not.toMatch(/overflow-x:\s*auto/);
  });

  it("wraps a composer notice so a narrow pane still shows the whole instruction", () => {
    const css = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    const notice = /\.composer-status__notice\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const strip =
      /\.thread-composer__feedback > \.composer-status:has\(> \.composer-status__notice\)\s*\{([^}]*)\}/.exec(
        css,
      )?.[1] ?? "";
    expect(notice).toMatch(/white-space:\s*normal/);
    expect(strip).toMatch(/flex:\s*1 1 auto/);
    expect(strip).toMatch(/min-width:\s*0/);
  });

  it("lets a Project overview's actions drop below the name so a half-width pane never draws the name field over its kind chip", () => {
    const css = readFileSync(join(webRoot, "styles/project-threads.css"), "utf8");
    const toolbar = /\.project-overview__toolbar\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const name = /\.project-overview__name\s*\{([^}]*min-width:[^}]*)\}/.exec(css)?.[1] ?? "";
    expect(toolbar).toMatch(/flex-wrap:\s*wrap/);
    expect(name).toMatch(/max-width:\s*100%/);
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
    // A control filled with the primary text colour would do the same, so it
    // draws the edge in the page colour.
    expect(withoutComments).toMatch(
      /\[data-slot="button"\]\[data-variant="solid"\]:focus-visible\s*\{[^}]*outline-color:[^;]*--octant-workspace/,
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
          /outline(?:-color)?:[^;]*(?:solid|focus-ring)|box-shadow:[^;]*focus-ring|stroke:/,
        );
      }
    }

    // An unconditional reset in a feature stylesheet loads after octant.css at
    // the same specificity, so it removes the edge as surely as a focus rule
    // does: the dock and sidebar resize handles lost it that way. Only these
    // may reset it: containers that hold the keyboard for the item inside
    // them, and text fields set inside a frame that is itself the field.
    const mayReset = new Set([
      ".octant-menu__positioner",
      ".octant-menu__popup",
      ".octant-menu__item",
      ".model-picker__listbox",
      ".settings-search-results",
      ".review-page__body",
      ".zen-surface",
      ".browser-workspace__remote",
      ".octant-dialog__popup",
      ".octant-sheet__popup",
      ".folder-picker__search input",
      ".octant-popover-search input",
      ".artifact-library__search-input",
      ".artifact-tags__input",
      ".browser-workspace__omnibox input",
    ]);
    const resets: string[] = [];
    for (const file of cssFiles(webRoot)) {
      if (file.endsWith(join("styles", "octant.css"))) continue;
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const block of source.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
        const selector = (block[1] ?? "").trim();
        if (selector.includes(":focus-visible") || selector.startsWith("@")) continue;
        if (!/(?:^|;|\s)outline:\s*(?:none|0)\s*;/.test(block[2] ?? "")) continue;
        for (const part of selector.split(",").map((each) => each.trim())) {
          if (!mayReset.has(part)) resets.push(`${relative(webRoot, file)}: ${part}`);
        }
      }
    }
    expect(resets).toEqual([]);
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

  it("lets everything in a reply, prose included, reach the reading width the person chose", () => {
    const chat = readFileSync(join(webRoot, "styles/chat.css"), "utf8");
    // The column is the measure. A cap on the wrapper kept tables narrow, and
    // a 72ch cap on prose stopped paragraphs short of the divider, the bubble
    // and the composer at every width past Narrow.
    const parts = chat.match(/\.chat-transcript__parts\s*\{[^}]+\}/)?.[0] ?? "";
    expect(parts).not.toContain("max-width");
    expect(chat).not.toMatch(/\.chat-rich-text > :is\([^)]*\)\s*\{\s*max-width/);
    expect(chat).not.toMatch(/\.chat-transcript__parts > \.thinking\s*\{\s*max-width/);
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

  it("keeps the light theme's faint controls and dimmed text readable", () => {
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    const shell = readFileSync(join(webRoot, "styles/shell.css"), "utf8");
    const rule = (css: string, selector: string) =>
      css.match(new RegExp(`${selector}\\s*\\{[^}]+\\}`))?.[0] ?? "";

    // The chosen segment is a stronger tint than its tray, not the tray itself.
    expect(rule(system, '\\.modeswitch__tray > \\.mode\\[aria-current="page"\\]')).toMatch(
      /background:\s*color-mix\(in srgb, var\(--oct-fg\) 12%, transparent\)/,
    );
    // Dimming a muted role with opacity fell under 4.5:1 on the page.
    for (const selector of [
      "\\.project-threads__more",
      "\\.draft-thread__hint,\\s*\\.work-composer-adapter__hint",
    ]) {
      expect(rule(shell, selector)).not.toMatch(/opacity/);
    }
    // An off switch's edge and an unchecked checkbox are found at a glance.
    expect(rule(system, '\\.octant-switch\\[data-slot="switch"\\]')).toMatch(
      /border:\s*1px solid var\(--octant-divider-strong\)/,
    );
    expect(readFileSync(join(webRoot, "ui/shadcn/checkbox.tsx"), "utf8")).toContain(
      "border-(--octant-divider-strong)",
    );
    // The inverse tooltip takes no inset bevel: its white line drew on the dark pill.
    expect(rule(system, "\\.octant-tooltip").match(/box-shadow:[^;]+;/)?.[0]).not.toContain(
      "inset",
    );
    // Only a locked model's picker keeps full ink.
    expect(system).toMatch(
      /\.composer-model-picker__trigger--locked:disabled\s*\{\s*opacity:\s*1;/,
    );
    expect(system).not.toMatch(/\.composer-model-picker__trigger:disabled\s*\{/);
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

  it("holds the shared context row as plain chips above the composer on every welcome", () => {
    const surface = readFileSync(join(webRoot, "styles/surface.css"), "utf8");
    const stack = surface.match(/\.composer-stack \{\n(?:.*\n)*?\}/m)?.[0] ?? "";
    const strip = surface.match(/\.composer-tray--start \{\n(?:.*\n)*?\}/m)?.[0] ?? "";
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    const prompt = system.match(/\.composer-input \{\n(?:.*\n)*?\}/m)?.[0] ?? "";
    const welcomes = [
      "chat/ChatWelcome.tsx",
      "work/composer/WorkComposerAdapter.tsx",
      "code/composer/CodeComposerAdapter.tsx",
    ].map((path) => readFileSync(join(webRoot, path), "utf8"));

    expect(stack).toMatch(/flex-direction:\s*column/);
    // Where the thread runs is one row above the card, as small chips with no
    // band behind them, so the card holds only the prompt and a control
    // opening a list can never push the prompt down the page.
    expect(strip).toMatch(/display:\s*flex/);
    expect(strip).not.toMatch(/box-shadow/);
    expect(strip).not.toMatch(/position:\s*absolute/);
    expect(strip).not.toMatch(/background/);
    expect(strip).not.toMatch(/border-top/);
    // Every composer, start screen or thread, has one prompt. A start screen
    // redefining it made the same message change shape between the first send
    // and the next. The empty prompt is one line on a start screen and under a
    // thread alike, and no surface or presentation sizes it again.
    expect(prompt).toMatch(/min-height:\s*calc\(1lh \+ 24px\)/);
    expect(system).not.toMatch(/\.composer--follow-up \.composer-input \{/);
    expect(surface).not.toMatch(/\.composer-stack > \.composer > \.composer-input \{/);
    for (const source of welcomes) {
      expect(source).toMatch(/className="composer-tray composer-tray--start"/);
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
    expect(legend).toMatch(/color:\s*var\(--octant-text-secondary\)/);
    expect(legend).toMatch(/font-weight:\s*var\(--oct-weight-strong\)/);
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
    const baseSectionLabel =
      settings.match(
        /\.settings-card-section\s*>\s*h2,[\s\S]*?\.settings-card-section\s*>\s*legend\s*\{[^}]+\}/,
      )?.[0] ?? "";
    expect(baseSectionLabel).toMatch(/color:\s*var\(--octant-text-secondary\)/);
    expect(baseSectionLabel).toMatch(/font-weight:\s*var\(--oct-weight-strong\)/);
    expect(baseSectionLabel).toMatch(/text-transform:\s*none/);
    const openSectionHeading =
      settings.match(
        /\.settings-view\s+\.settings-card-section\.settings-card-section--open\s*>\s*h2,[\s\S]*?\.settings-section-head\s*>\s*h2\s*\{[^}]+\}/,
      )?.[0] ?? "";
    expect(openSectionHeading).toMatch(/color:\s*var\(--octant-text-secondary\)/);
    expect(openSectionHeading).toMatch(/font-weight:\s*var\(--oct-weight-strong\)/);
    const openSectionDisclosure =
      settings.match(
        /\.settings-view\s+\.settings-card-section\.settings-card-section--open\s*>\s*:is\(legend,\s*summary\)\s*\{[^}]+\}/,
      )?.[0] ?? "";
    expect(openSectionDisclosure).toMatch(/color:\s*var\(--octant-text-secondary\)/);
    expect(openSectionDisclosure).toMatch(/font-weight:\s*var\(--oct-weight-strong\)/);
    const providerLimitsLabel =
      settings.match(
        /\.settings-view\s+\.provider-limits\s*>\s*\.oct-section-label,[\s\S]*?\.surface-section__head\s*>\s*\.oct-section-label\s*\{[^}]+\}/,
      )?.[0] ?? "";
    expect(providerLimitsLabel).toMatch(/color:\s*var\(--octant-text-secondary\)/);
    expect(providerLimitsLabel).toMatch(/font-weight:\s*var\(--oct-weight-strong\)/);
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
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    const navigation =
      settings.match(/(?:^|\n)\.settings-navigation \.setnav-section\s*\{[^}]+\}/)?.[0] ?? "";
    // A rail group heading is the Section label role: its type is defined once,
    // in the base rule, and the rail's rule only sets its room.
    const sectionLabel = system.match(/(?:^|\n)\.setnav-section\s*\{[^}]+\}/)?.[0] ?? "";
    const hint = settings.match(/\.setrow-hint\s*\{[^}]+\}/)?.[0] ?? "";

    expect(sectionLabel).toMatch(/font-size:\s*var\(--oct-text-sm\)/);
    expect(sectionLabel).toMatch(/font-weight:\s*var\(--oct-weight-strong\)/);
    expect(sectionLabel).toMatch(/letter-spacing:\s*var\(--oct-tracking-snug\)/);
    expect(navigation).not.toMatch(/font-size|font-weight|letter-spacing/);
    expect(navigation).toMatch(/text-transform:\s*none/);
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

  it("never lets the sidebar header's mode tray shrink under its action buttons", () => {
    // jsdom has no layout, so the rule is pinned in the CSS. The tray shrank to
    // 38px in a 220-236px sidebar while Home, Search, New, Hide and history
    // kept their width, and Code painted 18px under Home. The row must wrap
    // the actions below a tray that keeps its own width instead.
    const shell = readFileSync(join(webRoot, "styles/shell.css"), "utf8");
    const rule = (selector: string) =>
      shell.match(new RegExp(`(?:^|\\n)${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

    expect(rule("\\.sidebar__chrome")).toMatch(/flex-wrap:\s*wrap/);
    const tray = rule("\\.sidebar__chrome \\.modeswitch");
    expect(tray).toMatch(/flex:\s*1 0 auto/);
    expect(tray).toMatch(/min-width:\s*min-content/);
    // The row sits in a scrolling column: a long thread list shrank it to its
    // min-height and left the wrapped second row of buttons under the list.
    expect(rule("\\.sidebar__chrome")).toMatch(/flex:\s*0 0 auto/);
  });

  it("lets the dock's labelled quick tool ellipsize instead of clipping mid-word", () => {
    const dock = readFileSync(join(webRoot, "styles/dock.css"), "utf8");
    const rule = (selector: string) =>
      dock.match(new RegExp(`(?:^|\\n)${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

    const tool = rule('\\.dock-quick-tools > \\.dock-quick-tools__tool\\[data-labelled="true"\\]');
    expect(tool).toMatch(/min-width:\s*0/);
    expect(tool).toMatch(/flex:\s*0 1 auto/);
    expect(rule('\\.dock-quick-tools__tool\\[data-labelled="true"\\] > span')).toMatch(
      /text-overflow:\s*ellipsis/,
    );
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

  describe("count hues in the rail and the narrow rows", () => {
    const shell = readFileSync(join(webRoot, "styles", "shell.css"), "utf8");

    it("keeps the rail's and the rows' icons in the sidebar ink in every style", () => {
      for (const id of ["inbox", "running", "review", "done"]) {
        // One definition per hue: the tile face still takes it.
        expect(
          shell.match(new RegExp(`--sidebar-tile-hue:\\s*var\\(--oct-colour-${id}`, "g")),
        ).toHaveLength(1);
      }
      // No rule paints a glyph in a tile's hue: a column of grey marks carried
      // four coloured ones under Colour.
      expect(shell).not.toMatch(/\.sidebar-rail__face\s*\{[^}]*color:\s*var\(--sidebar-tile-hue\)/);
      expect(shell).not.toMatch(/\.sidebar-tile__icon\s*\{[^}]*color:\s*var\(--sidebar-tile-hue\)/);
      expect(shell).toMatch(/\.sidebar-rail__face \{[^}]*color:\s*var\(--oct-muted\)/);
    });

    it("draws the narrow rows without a media query of their own and without a fill", () => {
      const rule = shell.match(
        /:root\[data-octant-style\]\[data-octant-theme-mode\] \.sidebar-tiles--rows \.sidebar-tile__face \{([^}]*)\}/,
      );
      expect(rule?.[1]).toMatch(/background:\s*transparent/);
      expect(rule?.[1]).toMatch(/box-shadow:\s*none/);
      const at = shell.indexOf(".sidebar-tiles--rows {");
      expect(shell.lastIndexOf("@media", at)).toBeLessThan(shell.lastIndexOf("}\n\n", at));
    });
  });

  describe("overlays and pick-lists", () => {
    const components = readFileSync(join(webRoot, "styles", "components.css"), "utf8");
    const system = readFileSync(join(webRoot, "styles", "octant.css"), "utf8");
    const base = readFileSync(join(webRoot, "styles.css"), "utf8");
    const overlays = [
      '[data-slot="dropdown-menu-content"]',
      '[data-slot="context-menu-content"]',
      '[data-slot="popover-content"]',
      '[data-slot="select-content"]',
      '[data-slot="combobox-content"]',
      '[data-slot="tooltip-content"]',
      '[data-slot="preview-card-content"]',
      ".octant-dialog__popup",
      ".octant-dialog__backdrop",
      ".octant-sheet__popup",
      ".octant-sheet__backdrop",
    ];
    /** The rules whose selector list names every overlay, flattened to one line each. */
    const overlayRules = [...components.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map((match) => ({
        selector: (match[1] ?? "")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\s+/g, " ")
          .trim(),
        body: (match[2] ?? "").replace(/\s+/g, " ").trim(),
      }))
      .filter((rule) => overlays.every((overlay) => rule.selector.includes(overlay)));
    const bodyOf = (selector: RegExp) => overlayRules.find((rule) => selector.test(rule.selector));

    it("moves every overlay in and out the same way, on the motion tokens", () => {
      // A menu and a popover settled in over 150ms while a context menu, a
      // select, a tooltip, a dialog and Settings' sheet appeared and vanished
      // in one frame. In is the base duration, out the fast one.
      const rest = bodyOf(/^:is\([^)]*\)$/);
      for (const property of ["opacity", "scale", "translate"]) {
        expect(rest?.body).toContain(`${property} var(--oct-dur-base) var(--oct-ease-motion)`);
      }
      const hidden = bodyOf(/\):is\(\[data-starting-style\], \[data-ending-style\]\)$/);
      expect(hidden?.body).toBe("opacity: 0;");
      const leaving = bodyOf(/\)\[data-ending-style\]$/);
      expect(leaving?.body).toContain("transition-duration: var(--oct-dur-fast);");
      expect(leaving?.body).toContain("transition-timing-function: var(--oct-ease-color);");
      // A popup and a dialog settle from 98%; the sheet rises instead.
      expect(components).toMatch(
        /\.octant-dialog__popup\s*\):is\(\[data-starting-style\], \[data-ending-style\]\) \{\s*scale: 0\.98;\s*\}/,
      );
      expect(components).toMatch(
        /\.octant-sheet__popup:is\(\[data-starting-style\], \[data-ending-style\]\) \{\s*translate: 0 var\(--oct-space-2\);\s*\}/,
      );
      // No overlay rests on a scale or a translate of its own: `scale: 1`
      // makes a popup the containing block of what is position-fixed in it.
      expect(rest?.body).not.toMatch(/(?:^|; )(?:scale|translate|transform):/);
    });

    it("gives a dialog or sheet that is mounted already open the same arrival", () => {
      // Most dialogs are rendered only while open, so the library never marks
      // them as starting; `@starting-style` is their way in.
      const starting = components.slice(components.indexOf("@starting-style {"));
      const block = starting.slice(0, starting.indexOf("\n}\n"));
      for (const overlay of overlays) expect(block).toContain(overlay);
      expect(block).toMatch(/\.octant-dialog__popup \{\s*scale: 0\.98;/);
      expect(block).toMatch(/\.octant-sheet__popup \{\s*translate: 0 var\(--oct-space-2\);/);
    });

    it("takes the motion away under reduced motion, from the system or from Octant's setting", () => {
      const media = components.slice(components.indexOf("Reduced motion, from the system"));
      const system = media.slice(media.indexOf("@media (prefers-reduced-motion: reduce) {"));
      const systemBlock = system.slice(0, system.indexOf("\n}\n"));
      for (const overlay of overlays) expect(systemBlock).toContain(overlay);
      expect(systemBlock).toMatch(/\{\s*transition: none;\s*\}/);
      const setting = bodyOf(/^html\[data-octant-reduced-motion="true"\] :is\(/);
      expect(setting?.body).toContain("transition: none;");
      // A feature's own animation on the shared popup stops with it.
      expect(setting?.body).toContain("animation: none;");
    });

    it("leaves no recipe with an arrival or a departure of its own", () => {
      // One definition: a recipe that carried its own classes animated while
      // its neighbours did not, and none of them heard Octant's setting.
      const own = /data-(?:starting|ending)-style:|transition-\[opacity|motion-reduce:/;
      const strays = sourceFiles(join(webRoot, "ui"), ".tsx")
        .filter((path) => !path.includes(".test."))
        .filter((path) => own.test(readFileSync(path, "utf8")))
        .map((path) => relative(webRoot, path));

      expect(strays).toEqual([]);
      expect(components).not.toContain("@keyframes octant-dialog-enter");
    });

    it("draws every pick-list row at one height and one inset", () => {
      // The same one-line row was 24px in a menu, 26px in a context menu and
      // a select, 30px in a combobox and a picker, 34px in the palette and
      // 24px in a typeahead, on a 6.5, 8 or 12px inset.
      expect(system).toMatch(/--oct-menu-row-h:\s*28px;/);
      expect(system).toMatch(/--oct-menu-row-inset:\s*var\(--oct-space-2\);/);
      expect(system).toMatch(/--oct-menu-inset:\s*var\(--oct-space-1\);/);

      const row = readFileSync(join(webRoot, "ui/shadcn/menu-row.ts"), "utf8");
      expect(row).toContain("min-h-(--oct-menu-row-h)");
      expect(row).toContain("px-(--oct-menu-row-inset)");
      for (const recipe of ["dropdown-menu", "context-menu", "select", "combobox"]) {
        const source = readFileSync(join(webRoot, "ui/shadcn", `${recipe}.tsx`), "utf8");
        expect(source, recipe).toContain("menuRow");
        // The rows stand in from the popup's edge by one inset.
        expect(source, recipe).toContain("p-(--oct-menu-inset)");
        // No recipe sizes a row of its own beside the shared one.
        expect(source, recipe).not.toMatch(/data-highlighted:bg-accent/);
      }

      const palette = readFileSync(join(webRoot, "styles", "palette.css"), "utf8");
      const chat = readFileSync(join(webRoot, "styles", "chat.css"), "utf8");
      const rule = (source: string, selector: string) =>
        source.match(
          new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&")} \\{([^}]*)\\}`),
        )?.[1] ?? "";
      for (const body of [
        rule(components, ".octant-popover-option"),
        rule(palette, ".command-palette__result"),
      ]) {
        expect(body).toContain("min-height: var(--oct-menu-row-h);");
        expect(body).toContain("var(--oct-menu-row-inset)");
      }
      for (const body of [
        rule(palette, ".chat-composer__command-option > button"),
        rule(chat, ".thread-mention__option > button"),
      ]) {
        expect(body).toContain("height: var(--oct-menu-row-h);");
        expect(body).toContain("padding-inline: var(--oct-menu-row-inset);");
      }
    });

    it("declares the scrollbar once and lets no stylesheet draw a second one", () => {
      // A second colour stood in octant.css and lost on source order alone.
      // The treatment is the two standard properties in styles.css; a feature
      // may hide a scrollbar in a named place and may never recolour or widen one.
      const hidden = [
        ".code-project-views__inline",
        ".dock-browser-pages",
        ".phone-scroll",
        ".setnav",
        ".sidebar-rail__column",
      ];
      const strays: string[] = [];
      for (const path of cssFiles(webRoot)) {
        const name = relative(webRoot, path);
        const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
          const selector = (match[1] ?? "").replace(/\s+/g, " ").trim();
          const body = match[2] ?? "";
          if (/scrollbar-color:/.test(body) && name !== "styles.css") {
            strays.push(`${name}: ${selector} sets scrollbar-color`);
          }
          const width = body.match(/scrollbar-width:\s*([a-z]+)/)?.[1];
          if (width === undefined || width === "thin") continue;
          if (width === "none" && hidden.some((allowed) => selector.endsWith(allowed))) continue;
          if (width === "auto" && name === "styles.css") continue;
          strays.push(`${name}: ${selector} sets scrollbar-width: ${width}`);
        }
      }

      expect(strays).toEqual([]);
      expect(base).toMatch(
        /:where\(\*\) \{\s*scrollbar-color: var\(--octant-border-strong\) transparent;\s*scrollbar-width: thin;\s*\}/,
      );
    });

    it("styles Settings' loading outline from a stylesheet that is there before Settings is", () => {
      // settings.css arrives in the same chunk as Settings. Styled from it,
      // the outline was a blank panel for exactly the moment it covers.
      const dock = readFileSync(join(webRoot, "styles", "dock.css"), "utf8");
      const settings = readFileSync(join(webRoot, "styles", "settings.css"), "utf8");
      const outline = readFileSync(join(webRoot, "shell", "SettingsLoading.tsx"), "utf8");
      expect(dock).toMatch(/\.settings-loading \{[^}]*display: grid;/);
      expect(settings).not.toContain(".settings-loading");
      expect(outline).not.toMatch(/className="[^"]*settings-view/);
    });

    it("stills a skeleton's sheen under both reduced-motion signals", () => {
      expect(system).toMatch(
        /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.skeleton::after \{\s*display: none;/,
      );
      expect(system).toMatch(
        /html\[data-octant-reduced-motion="true"\] \.skeleton::after \{\s*display: none;\s*\}/,
      );
    });
  });
});
