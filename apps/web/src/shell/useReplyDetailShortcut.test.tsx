import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isApplePlatform } from "../platform";
import { useReplyDetailShortcut } from "./useReplyDetailShortcut";

function Shortcut(props: { readonly onCycle: () => boolean }) {
  useReplyDetailShortcut(props.onCycle);
  return null;
}

function pressReplyDetailChord(): KeyboardEvent {
  const apple = isApplePlatform();
  const event = new KeyboardEvent("keydown", {
    key: "D",
    shiftKey: true,
    metaKey: apple,
    ctrlKey: !apple,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

describe("the reply detail shortcut", () => {
  it("changes the thread in front on Mod+Shift+D and keeps the key from the browser", () => {
    const onCycle = vi.fn(() => true);
    render(<Shortcut onCycle={onCycle} />);
    const event = pressReplyDetailChord();
    expect(onCycle).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves the key to the browser when no thread is in front", () => {
    const onCycle = vi.fn(() => false);
    render(<Shortcut onCycle={onCycle} />);
    const event = pressReplyDetailChord();
    expect(onCycle).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });
});
