import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { XtermAdapterRuntime, XtermAdapterSession } from "./XtermTerminalAdapter";
import {
  DEFAULT_TERMINAL_TYPOGRAPHY,
  type TerminalTypographyProjection,
} from "@octant/theme/typography";

export const mount: XtermAdapterRuntime["mount"] = (element, options) => {
  let interactive = options.interactive;
  let output = options.output;
  const typography = options.typography ?? DEFAULT_TERMINAL_TYPOGRAPHY;
  const theme = resolvedTerminalTheme();
  const terminal = new Terminal({
    convertEol: true,
    disableStdin: !interactive,
    fontFamily: typography.fontFamily,
    fontSize: typography.fontSize,
    fontWeight: typography.fontWeight,
    lineHeight: typography.lineHeight,
    ...(theme === undefined ? {} : { theme }),
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(element);
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
  } satisfies XtermAdapterSession;
};

/**
 * The terminal wears the resolved theme instead of xterm's stock palette,
 * which ignored the roles the app publishes and left every terminal navy-on-
 * black inside a warm-graphite workspace. Roles are read at mount, the same
 * moment the stock palette would have applied; nothing re-themes a live
 * session today (typography flows through props, colors do not), so a theme
 * switched mid-session repaints on the terminal's next mount.
 */
function resolvedTerminalTheme(): ITheme | undefined {
  if (typeof document === "undefined") return undefined;
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const role = (id: string): string | undefined => {
    const value = styles.getPropertyValue(`--octant-${id}`).trim();
    return value === "" ? undefined : value;
  };
  const ink = role("text-primary");
  const ground = role("workspace");
  const base = role("app-background");
  const gray = role("text-muted");
  const selection = role("selection");
  const red = role("palette-red");
  const green = role("palette-green");
  const yellow = role("palette-yellow");
  const blue = role("palette-blue");
  const purple = role("palette-purple");
  const teal = role("palette-teal");
  // An unstyled document (runtime tests mount without the app stylesheet)
  // resolves no roles; keep xterm's own palette rather than painting half
  // a theme over it.
  if (
    ink === undefined ||
    ground === undefined ||
    base === undefined ||
    gray === undefined ||
    selection === undefined ||
    red === undefined ||
    green === undefined ||
    yellow === undefined ||
    blue === undefined ||
    purple === undefined ||
    teal === undefined
  ) {
    return undefined;
  }
  // Resolved roles flip with the mode, but ANSI black must stay dark and
  // white light in either mode, so the pair maps to whichever of ink and
  // ground is which under the resolved mode.
  const dark = root.dataset.octantThemeMode !== "light";
  const black = dark ? base : ink;
  const white = dark ? ink : base;
  return {
    background: ground,
    foreground: ink,
    cursor: ink,
    cursorAccent: ground,
    selectionBackground: selection,
    black,
    red,
    green,
    yellow,
    blue,
    magenta: purple,
    cyan: teal,
    white,
    // The theme publishes one hue per family and no bright set, so the
    // bright variants reuse the same roles; brightBlack is the muted ink
    // so dim output stays readable instead of vanishing into the ground.
    brightBlack: gray,
    brightRed: red,
    brightGreen: green,
    brightYellow: yellow,
    brightBlue: blue,
    brightMagenta: purple,
    brightCyan: teal,
    brightWhite: white,
  };
}

function applyTerminalTypography(
  terminal: Terminal,
  element: HTMLElement,
  typography: TerminalTypographyProjection,
): void {
  terminal.options.fontFamily = typography.fontFamily;
  terminal.options.fontSize = typography.fontSize;
  terminal.options.fontWeight = typography.fontWeight;
  terminal.options.lineHeight = typography.lineHeight;
  element.style.fontVariantLigatures = typography.fontLigatures ? "common-ligatures" : "none";
}
