import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  DEFAULT_TERMINAL_COLORS,
  type TerminalColorProjection,
} from "@octant/theme/terminal-colors";
import type { XtermAdapterRuntime, XtermAdapterSession } from "./XtermTerminalAdapter";
import {
  DEFAULT_TERMINAL_TYPOGRAPHY,
  type TerminalTypographyProjection,
} from "@octant/theme/typography";

export const mount: XtermAdapterRuntime["mount"] = (element, options) => {
  let interactive = options.interactive;
  let output = options.output;
  const typography = options.typography ?? DEFAULT_TERMINAL_TYPOGRAPHY;
  const colors = options.colors ?? DEFAULT_TERMINAL_COLORS;
  const terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    disableStdin: !interactive,
    fontFamily: withPromptIconFonts(typography.fontFamily),
    fontSize: typography.fontSize,
    fontWeight: typography.fontWeight,
    lineHeight: typography.lineHeight,
    minimumContrastRatio: colors.minimumContrastRatio,
    theme: terminalTheme(element, colors),
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(element);
  // The engine would otherwise turn a claimed key into bytes for the shell;
  // returning false from its handler is how it is told to send nothing.
  terminal.attachCustomKeyEventHandler((event) => options.interceptKey?.(event) !== true);
  if (options.describedBy !== undefined) {
    terminal.textarea?.setAttribute("aria-describedby", options.describedBy);
  }
  const renderer = attachGpuRenderer(terminal);
  applyTerminalTypography(terminal, element, typography);
  terminal.write(options.output);
  const data = terminal.onData((value) => {
    if (interactive) options.onData(value);
  });
  const resize = terminal.onResize(({ cols, rows }) => options.onResize(cols, rows));
  const observer =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => {
          fit.fit();
        });
  observer?.observe(element);
  fit.fit();

  return {
    dispose: () => {
      observer?.disconnect();
      data.dispose();
      resize.dispose();
      renderer?.dispose();
      terminal.dispose();
    },
    focus: () => terminal.focus(),
    readSelection: () => terminal.getSelection(),
    setInteractive: (next) => {
      interactive = next;
      terminal.options.disableStdin = !next;
    },
    setOutput: (nextOutput) => {
      if (nextOutput === output) return;
      if (nextOutput.startsWith(output)) {
        terminal.write(nextOutput.slice(output.length));
      } else {
        terminal.reset();
        terminal.write(nextOutput);
      }
      output = nextOutput;
    },
    setTypography: (next) => applyTerminalTypography(terminal, element, next),
    // Assigning a new theme makes the engine repaint every cell in place, so
    // the scrollback keeps its text and takes the new colours.
    setColors: (next) => {
      terminal.options.minimumContrastRatio = next.minimumContrastRatio;
      terminal.options.theme = terminalTheme(element, next);
    },
  } satisfies XtermAdapterSession;
};

/**
 * Moves painting onto the GPU, and gives up quietly when it cannot.
 *
 * The stock renderer draws every cell as DOM, which is what made a busy build
 * log crawl. WebGL is the engine's own answer to that, but it fails for
 * reasons the app does not control — a machine with no GPU context to give, a
 * context lost while the tab sat in the background, a headless test document.
 * Every one of those falls back to the DOM renderer, which is the behaviour
 * this terminal already had, so the worst case is no slower than before.
 */
function attachGpuRenderer(terminal: Terminal): { readonly dispose: () => void } | undefined {
  try {
    const webgl = new WebglAddon();
    // A lost context is not recoverable in place: dispose the addon and let
    // xterm fall back, rather than leaving a terminal painting nothing.
    webgl.onContextLoss(() => {
      console.warn("Octant terminal lost its WebGL context; painting with the DOM renderer.");
      webgl.dispose();
    });
    terminal.loadAddon(webgl);
    return webgl;
  } catch (error) {
    // Logged once per mount so a slow terminal can be traced to the fallback.
    console.warn(
      "Octant terminal could not start the WebGL renderer; using the DOM renderer.",
      error,
    );
    return undefined;
  }
}

/**
 * The terminal wears the theme's projection instead of xterm's stock palette,
 * which left every terminal navy-on-black inside a warm-graphite workspace.
 * The plate under the cells depends on where the terminal sits, so it is
 * worked out here each time the colours arrive.
 */
function terminalTheme(element: HTMLElement, colors: TerminalColorProjection): ITheme {
  const plate = glassPlate(element, colors.palette.background, colors.palette.foreground);
  return { ...colors.palette, background: plate, cursorAccent: plate };
}

function applyTerminalTypography(
  terminal: Terminal,
  element: HTMLElement,
  typography: TerminalTypographyProjection,
): void {
  terminal.options.fontFamily = withPromptIconFonts(typography.fontFamily);
  terminal.options.fontSize = typography.fontSize;
  terminal.options.fontWeight = typography.fontWeight;
  terminal.options.lineHeight = typography.lineHeight;
  element.style.fontVariantLigatures = typography.fontLigatures ? "common-ligatures" : "none";
}

/**
 * Shell prompts (Powerline, Starship, oh-my-posh) draw their separators and
 * icons from Nerd Font code points. The stack named only the symbols-only
 * Nerd Font, which few people install, so a prompt drew empty boxes even on a
 * Mac that had a full Nerd Font such as Hack's. The common Nerd Font families
 * join the stack just before its generic family, after every face the person
 * chose, so they only ever supply the glyphs those faces lack.
 */
const PROMPT_ICON_FONTS = [
  "Symbols Nerd Font Mono",
  "Symbols Nerd Font",
  "Hack Nerd Font Mono",
  "JetBrainsMono Nerd Font Mono",
  "MesloLGS Nerd Font Mono",
  "MesloLGS NF",
  "FiraCode Nerd Font Mono",
] as const;

export function withPromptIconFonts(family: string): string {
  const named = family.toLowerCase();
  const missing = PROMPT_ICON_FONTS.filter((font) => !named.includes(font.toLowerCase())).map(
    (font) => `'${font}'`,
  );
  if (missing.length === 0) return family;
  const generic = /,\s*(monospace|ui-monospace)\s*$/i.exec(family);
  return generic === null
    ? `${family}, ${missing.join(", ")}`
    : `${family.slice(0, generic.index)}, ${missing.join(", ")}${generic[0]}`;
}

/**
 * Under Glass the terminal is a grey plate rather than the page colour: on an
 * OLED preset that colour is black, and the terminal stood as a black slab in
 * the frosted dock. The plate is the page colour with 12% of the ink, the same
 * mix the stylesheet paints around the cells. The terminal stays opaque so the
 * ground's letters never run behind its text.
 */
function glassPlate(element: HTMLElement, ground: string, ink: string): string {
  const glass =
    element.closest(".shell--material-translucent") !== null &&
    document.documentElement.dataset.octantReducedTransparency !== "true";
  if (!glass) return ground;
  return mixHex(ground, ink, 0.12) ?? ground;
}

function mixHex(base: string, tint: string, amount: number): string | undefined {
  const parse = (value: string) =>
    /^#[0-9a-f]{6}$/i.test(value)
      ? [1, 3, 5].map((start) => Number.parseInt(value.slice(start, start + 2), 16))
      : undefined;
  const from = parse(base);
  const to = parse(tint);
  if (from === undefined || to === undefined) return undefined;
  return `#${from
    .map((channel, index) =>
      Math.round(channel + ((to[index] ?? channel) - channel) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
