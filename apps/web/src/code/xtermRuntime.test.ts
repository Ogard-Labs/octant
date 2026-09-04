import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
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

import { mount } from "./xtermRuntime";

const THEME_ROLES: Readonly<Record<string, string>> = {
  "text-primary": "#f2f1ed",
  workspace: "#14130f",
  "app-background": "#0e0d0a",
  "text-muted": "#787773",
  selection: "#353430",
  "palette-red": "#d95778",
  "palette-green": "#93cb58",
  "palette-yellow": "#d9a441",
  "palette-blue": "#74b0f3",
  "palette-purple": "#ab98f2",
  "palette-teal": "#45c8bc",
};

function publishThemeRoles(): void {
  for (const [role, color] of Object.entries(THEME_ROLES)) {
    document.documentElement.style.setProperty(`--octant-${role}`, color);
  }
}

function clearThemeRoles(): void {
  for (const role of Object.keys(THEME_ROLES)) {
    document.documentElement.style.removeProperty(`--octant-${role}`);
  }
  delete document.documentElement.dataset.octantThemeMode;
}

describe("Xterm runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearThemeRoles();
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

    const session = mount(document.createElement("div"), {
      interactive: false,
      onData: vi.fn(),
      onResize: vi.fn(),
      output: "ready\n",
    });

    expect(mocks.write).toHaveBeenCalledWith("ready\n");
    expect(() => session.dispose()).not.toThrow();
    expect(mocks.terminalDispose).toHaveBeenCalledOnce();
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
        fontFamily: "JetBrains Mono",
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
      fontFamily: "SF Mono",
      fontSize: 13,
      fontWeight: 500,
      lineHeight: 1.5,
    });
    expect(element.style.fontVariantLigatures).toBe("none");
    session.dispose();
  });

  it("paints the terminal with the resolved theme roles instead of xterm's stock palette", () => {
    publishThemeRoles();
    document.documentElement.dataset.octantThemeMode = "dark";
    const session = mount(document.createElement("div"), {
      interactive: false,
      onData: vi.fn(),
      onResize: vi.fn(),
      output: "",
    });

    expect(mocks.terminal).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: expect.objectContaining({
          background: "#14130f",
          foreground: "#f2f1ed",
          cursor: "#f2f1ed",
          selectionBackground: "#353430",
          red: "#d95778",
          green: "#93cb58",
          yellow: "#d9a441",
          blue: "#74b0f3",
          magenta: "#ab98f2",
          cyan: "#45c8bc",
          // Dark mode: black is the ground family, white the ink.
          black: "#0e0d0a",
          white: "#f2f1ed",
          // No bright set is published, so bright variants reuse the hues.
          brightRed: "#d95778",
          brightBlack: "#787773",
        }),
      }),
    );
    session.dispose();
  });

  it("keeps ANSI black dark and white light when the resolved mode is light", () => {
    publishThemeRoles();
    // In light mode the ink role resolves dark and the ground light, so the
    // ANSI black/white pair must swap sources to keep black dark.
    document.documentElement.style.setProperty("--octant-text-primary", "#26251e");
    document.documentElement.style.setProperty("--octant-app-background", "#edece7");
    document.documentElement.dataset.octantThemeMode = "light";
    const session = mount(document.createElement("div"), {
      interactive: false,
      onData: vi.fn(),
      onResize: vi.fn(),
      output: "",
    });

    expect(mocks.terminal).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: expect.objectContaining({ black: "#26251e", white: "#edece7" }),
      }),
    );
    session.dispose();
  });

  it("leaves xterm's own palette in place when the document resolves no theme roles", () => {
    const session = mount(document.createElement("div"), {
      interactive: false,
      onData: vi.fn(),
      onResize: vi.fn(),
      output: "",
    });

    const options: unknown = mocks.terminal.mock.calls[0]?.[0];
    expect(options).toBeDefined();
    expect(options).not.toHaveProperty("theme");
    session.dispose();
  });
});
