import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
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
  const terminal = new Terminal({
    convertEol: true,
    disableStdin: !interactive,
    fontFamily: typography.fontFamily,
    fontSize: typography.fontSize,
    fontWeight: typography.fontWeight,
    lineHeight: typography.lineHeight,
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
