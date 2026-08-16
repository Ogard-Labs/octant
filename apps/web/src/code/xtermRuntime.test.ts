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
  write: vi.fn(),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(function FitAddonMock() {
    return { fit: mocks.fit };
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

describe("Xterm runtime", () => {
  beforeEach(() => vi.clearAllMocks());

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
});
