import { describe, expect, it, vi } from "vitest";
import { mount } from "./xtermRuntime";

/**
 * These run the real terminal engine: whether a key becomes bytes for the shell
 * is the engine's decision, so a stub could only repeat what the code asks of it.
 */
function stubMatchMedia(): void {
  // jsdom has no media queries; the engine asks for the pixel ratio on open.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
  });
}

function mounted(interceptKey?: (event: KeyboardEvent) => boolean) {
  stubMatchMedia();
  const host = document.createElement("div");
  document.body.append(host);
  const onData = vi.fn();
  const session = mount(host, {
    interactive: true,
    onData,
    onResize: vi.fn(),
    output: "",
    ...(interceptKey === undefined ? {} : { interceptKey }),
  });
  const input = host.querySelector("textarea");
  if (input === null) throw new Error("The terminal did not open its input.");
  const press = (init: KeyboardEventInit & { key: string }) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    input.dispatchEvent(event);
    return event;
  };
  return { host, input, onData, press, session };
}

describe("terminal keyboard", () => {
  it("sends an ordinary Tab, Shift+Tab and Escape to the shell", () => {
    const { host, onData, press, session } = mounted(() => false);

    press({ key: "Tab", code: "Tab", keyCode: 9 });
    press({ key: "Tab", code: "Tab", keyCode: 9, shiftKey: true });
    press({ key: "Escape", code: "Escape", keyCode: 27 });

    expect(onData.mock.calls.map(([data]) => data)).toEqual(["\t", "\u001b[Z", "\u001b"]);
    session.dispose();
    host.remove();
  });

  it("sends nothing to the shell for a key the app claims", () => {
    const claimed = (event: KeyboardEvent) => event.key === "Escape" && event.metaKey;
    const { host, onData, press, session } = mounted(claimed);

    press({ key: "Escape", code: "Escape", keyCode: 27, metaKey: true });
    expect(onData).not.toHaveBeenCalled();

    press({ key: "Escape", code: "Escape", keyCode: 27 });
    expect(onData).toHaveBeenCalledWith("\u001b");
    session.dispose();
    host.remove();
  });
});
