import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachCustomKeyEventHandler: vi.fn(),
  dataDispose: vi.fn(),
  fit: vi.fn(),
  loadAddon: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onResize: vi.fn(() => ({ dispose: vi.fn() })),
  open: vi.fn(),
  reset: vi.fn(),
  resizeDispose: vi.fn(),
  terminalDispose: vi.fn(),
  terminalFocus: vi.fn(),
  terminal: vi.fn(),
  terminalOptions: { disableStdin: false },
  webglDispose: vi.fn(),
  webglOnContextLoss: vi.fn(),
  webglConstruct: vi.fn(),
  write: vi.fn(),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(function FitAddonMock() {
    return { fit: mocks.fit };
  }),
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn(function WebglAddonMock() {
    mocks.webglConstruct();
    return { dispose: mocks.webglDispose, onContextLoss: mocks.webglOnContextLoss };
  }),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: mocks.terminal.mockImplementation(function TerminalMock() {
    return {
      attachCustomKeyEventHandler: mocks.attachCustomKeyEventHandler,
      dispose: mocks.terminalDispose,
      focus: mocks.terminalFocus,
      loadAddon: mocks.loadAddon,
      onData: mocks.onData,
      onResize: vi.fn(() => ({ dispose: mocks.resizeDispose })),
      open: mocks.open,
      options: mocks.terminalOptions,
      reset: mocks.reset,
      write: mocks.write,
    };
  }),
}));

import { resolveTerminalColorProjection } from "@octant/theme/terminal-colors";
import { DEFAULT_DARK_TOKENS, DEFAULT_LIGHT_TOKENS } from "@octant/theme/tokens";
import { mount, withPromptIconFonts } from "./xtermRuntime";

const darkColors = resolveTerminalColorProjection({ mode: "dark", tokens: DEFAULT_DARK_TOKENS });
const lightColors = resolveTerminalColorProjection({ mode: "light", tokens: DEFAULT_LIGHT_TOKENS });

describe("Xterm runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("paints on the GPU and releases it with the session", () => {
    const session = mount(document.createElement("div"), {
      interactive: false,
      onData: vi.fn(),
      onResize: vi.fn(),
      output: "ready\n",
    });

    expect(mocks.webglConstruct).toHaveBeenCalledOnce();
    expect(mocks.webglOnContextLoss).toHaveBeenCalledOnce();
    session.dispose();
    expect(mocks.webglDispose).toHaveBeenCalledOnce();
  });

  it("still opens a terminal on a machine that refuses a GPU context", () => {
    mocks.webglConstruct.mockImplementationOnce(() => {
      throw new Error("WebGL is unavailable.");
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = mount(document.createElement("div"), {
      interactive: false,
      onData: vi.fn(),
      onResize: vi.fn(),
      output: "ready\n",
    });

    expect(mocks.write).toHaveBeenCalledWith("ready\n");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    expect(() => session.dispose()).not.toThrow();
    expect(mocks.terminalDispose).toHaveBeenCalledOnce();
  });

  it("says so once when the GPU context is lost and the terminal falls back to DOM", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mount(document.createElement("div"), {
      interactive: false,
      onData: vi.fn(),
      onResize: vi.fn(),
      output: "",
    });
    const onLoss = mocks.webglOnContextLoss.mock.calls[0]?.[0] as (() => void) | undefined;
    onLoss?.();

    expect(warn).toHaveBeenCalledOnce();
    expect(mocks.webglDispose).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("appends replay deltas and resets only when retained history diverges", () => {
    const session = mount(document.createElement("div"), {
      interactive: false,
      onData: vi.fn(),
      onResize: vi.fn(),
      output: "first",
    });
    mocks.reset.mockClear();
    mocks.write.mockClear();

    session.setOutput("first second");
    expect(mocks.reset).not.toHaveBeenCalled();
    expect(mocks.write).toHaveBeenCalledWith(" second");

    mocks.reset.mockClear();
    mocks.write.mockClear();
    session.setOutput("replacement");
    expect(mocks.reset).toHaveBeenCalledOnce();
    expect(mocks.write).toHaveBeenCalledWith("replacement");

    mocks.reset.mockClear();
    mocks.write.mockClear();
    session.setOutput("replacement");
    expect(mocks.reset).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    session.dispose();
  });

  it("lets a prompt's icons fall back to an installed Nerd Font after the chosen faces", () => {
    const family = withPromptIconFonts(
      "'JetBrains Mono', 'SF Mono', Menlo, 'Symbols Nerd Font Mono', monospace",
    );
    // The chosen faces lead, the Nerd Fonts follow, and the generic family stays last.
    expect(
      family.startsWith("'JetBrains Mono', 'SF Mono', Menlo, 'Symbols Nerd Font Mono', "),
    ).toBe(true);
    expect(family).toContain("'Hack Nerd Font Mono'");
    expect(family.endsWith(", monospace")).toBe(true);
    expect(family.match(/Symbols Nerd Font Mono/g)).toHaveLength(1);
  });

  it("projects terminal typography at mount and on live updates", () => {
    const element = document.createElement("div");
    const session = mount(element, {
      interactive: false,
      onData: vi.fn(),
      onResize: vi.fn(),
      output: "first",
      typography: {
        fontFamily: "JetBrains Mono",
        fontSize: 12,
        fontWeight: 300,
        lineHeight: 1.3,
        fontLigatures: true,
      },
    });

    expect(mocks.terminal).toHaveBeenCalledWith(
      expect.objectContaining({
        fontFamily: expect.stringMatching(/^JetBrains Mono, /),
        fontSize: 12,
        fontWeight: 300,
        lineHeight: 1.3,
      }),
    );
    session.setTypography?.({
      fontFamily: "SF Mono",
      fontSize: 13,
      fontWeight: 500,
      lineHeight: 1.5,
      fontLigatures: false,
    });
    expect(mocks.terminalOptions).toMatchObject({
      fontFamily: expect.stringMatching(/^SF Mono, /),
      fontSize: 13,
      fontWeight: 500,
      lineHeight: 1.5,
    });
    expect(element.style.fontVariantLigatures).toBe("none");
    session.dispose();
  });

  it("paints the terminal from the theme's projection instead of xterm's stock palette", () => {
    const session = mount(document.createElement("div"), {
      colors: darkColors,
      interactive: false,
      onData: vi.fn(),
      onResize: vi.fn(),
      output: "",
    });

    expect(mocks.terminal).toHaveBeenCalledWith(
      expect.objectContaining({
        minimumContrastRatio: 4.5,
        theme: expect.objectContaining({
          background: "#1a1a1a",
          foreground: "#f5f5f7",
          black: "#151515",
          red: "#d95778",
          brightBlack: "#949494",
        }),
      }),
    );
    session.dispose();
  });

  it("repaints an open terminal on a live light/dark or contrast switch", () => {
    const session = mount(document.createElement("div"), {
      colors: darkColors,
      interactive: false,
      onData: vi.fn(),
      onResize: vi.fn(),
      output: "",
    });

    session.setColors?.(
      resolveTerminalColorProjection(
        { mode: "light", tokens: DEFAULT_LIGHT_TOKENS },
        { increasedContrast: true },
      ),
    );
    expect(mocks.terminalOptions).toMatchObject({
      minimumContrastRatio: 7,
      theme: expect.objectContaining({
        background: "#ffffff",
        foreground: "#0e0f11",
        black: "#0e0f11",
        white: "#fafaf9",
      }),
    });
    expect(mocks.terminal).toHaveBeenCalledOnce();
    session.dispose();
  });

  it("keeps the Glass plate under the terminal when the theme switches live", () => {
    const shell = document.createElement("div");
    shell.className = "shell--material-translucent";
    const element = document.createElement("div");
    shell.append(element);
    const session = mount(element, {
      colors: darkColors,
      interactive: false,
      onData: vi.fn(),
      onResize: vi.fn(),
      output: "",
    });

    session.setColors?.(lightColors);
    // The light ground with 12% of the light ink, not the bare ground.
    expect(mocks.terminalOptions).toMatchObject({
      theme: expect.objectContaining({ background: "#e3e3e3", cursorAccent: "#e3e3e3" }),
    });
    session.dispose();
  });

  it("paints the stylesheet's dark default when no theme reaches the terminal", () => {
    const session = mount(document.createElement("div"), {
      interactive: false,
      onData: vi.fn(),
      onResize: vi.fn(),
      output: "",
    });

    expect(mocks.terminal).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: expect.objectContaining({ background: "#1a1a1a", foreground: "#f5f5f7" }),
      }),
    );
    session.dispose();
  });
});
