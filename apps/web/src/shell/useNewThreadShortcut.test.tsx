import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isApplePlatform } from "../platform";
import { useNewThreadShortcut } from "./useNewThreadShortcut";

function Shortcut(props: { readonly onNewThread: () => void }) {
  useNewThreadShortcut(props.onNewThread);
  return <textarea aria-label="Prompt" />;
}

function press(key: string, target: EventTarget): KeyboardEvent {
  const apple = isApplePlatform();
  const event = new KeyboardEvent("keydown", {
    key,
    metaKey: apple,
    ctrlKey: !apple,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe("the new thread shortcut", () => {
  it("starts a thread on Mod+N from inside the prompt and keeps the key from the browser", () => {
    const onNewThread = vi.fn();
    const view = render(<Shortcut onNewThread={onNewThread} />);
    const event = press("n", view.getByLabelText("Prompt"));
    expect(onNewThread).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores a bare N typed into the prompt", () => {
    const onNewThread = vi.fn();
    const view = render(<Shortcut onNewThread={onNewThread} />);
    view
      .getByLabelText("Prompt")
      .dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true, cancelable: true }));
    expect(onNewThread).not.toHaveBeenCalled();
  });
});
