import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { decodeAppleSimulatorId } from "@octant/contracts/apple-toolchain";
import type { AppleSimulatorLiveFrame } from "@octant/domain";
import { AppleSimulatorLiveFrameView } from "./AppleSimulatorLiveFrame";

const simulatorId = decodeAppleSimulatorId("90000000-0000-4000-8000-000000000006");

describe("AppleSimulatorLiveFrameView", () => {
  it("states why the frame is unavailable on a host without Apple tooling", () => {
    const frame: AppleSimulatorLiveFrame = {
      status: "unavailable",
      reason: "toolchain-missing",
      title: "Simulator is unavailable",
      message:
        "Install or select Xcode and an iOS Simulator runtime on the Mac that owns this Code thread, then retry.",
    };
    expect(renderToStaticMarkup(<AppleSimulatorLiveFrameView frame={frame} />)).toContain(
      "Simulator is unavailable",
    );
    expect(renderToStaticMarkup(<AppleSimulatorLiveFrameView frame={frame} />)).not.toContain(
      "<video",
    );
  });

  it("keeps a remote client from presenting a fake live video", () => {
    const frame: AppleSimulatorLiveFrame = {
      status: "unavailable",
      reason: "not-attachable",
      title: "Simulator frame is not attachable",
      message:
        "This client cannot attach a live Simulator frame. Open the thread on the Mac that owns the destination.",
    };
    const html = renderToStaticMarkup(<AppleSimulatorLiveFrameView frame={frame} />);
    expect(html).toContain("not attachable");
    expect(html).not.toContain("<video");
    expect(html).not.toContain("<img");
  });

  it("labels stale-after-restart instead of showing the destination as live", () => {
    const frame: AppleSimulatorLiveFrame = {
      status: "stale-after-restart",
      simulatorId,
      name: "iPhone 16",
      lastScreen: { reference: "apple-screenshot-before-restart" },
      title: "Simulator is stale after restart",
      message:
        "Ownership was reconciled after a host restart. This is not a live frame until the destination is observed again.",
    };
    render(<AppleSimulatorLiveFrameView frame={frame} />);
    expect(screen.getByLabelText("iOS Simulator live frame")).toHaveAttribute(
      "data-status",
      "stale-after-restart",
    );
    expect(screen.getByText("Simulator is stale after restart")).toBeVisible();
    expect(screen.getByText("apple-screenshot-before-restart")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("reports a pending capture until the host-held image URL is available", () => {
    const frame: AppleSimulatorLiveFrame = {
      status: "live",
      simulatorId,
      name: "iPhone 16",
      screen: { kind: "screenshot", reference: "apple-screenshot-live" },
      title: "Live · iPhone 16",
      message:
        "Showing the latest host-held screen capture for this thread. This is not a video stream.",
    };
    render(<AppleSimulatorLiveFrameView frame={frame} />);
    expect(screen.getByText(/captured screen is not available/)).toBeVisible();
    expect(screen.queryByText(/Showing the latest/)).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("shows a live still from a host-held evidence URL, never a video element", () => {
    const frame: AppleSimulatorLiveFrame = {
      status: "live",
      simulatorId,
      name: "iPhone 16",
      screen: { kind: "screenshot", reference: "apple-screenshot-live" },
      title: "Live · iPhone 16",
      message:
        "Showing the latest host-held screen capture for this thread. This is not a video stream.",
    };
    render(
      <AppleSimulatorLiveFrameView frame={frame} screenUrl="blob:https://octant.local/screen" />,
    );
    expect(screen.getByLabelText("iOS Simulator live frame")).toHaveAttribute(
      "data-status",
      "live",
    );
    expect(screen.getByRole("img", { name: "iPhone 16 screen" })).toHaveAttribute(
      "src",
      "blob:https://octant.local/screen",
    );
    expect(document.querySelector("video")).toBeNull();
  });

  it("offers tap, type, and key controls only when the live frame is input-enabled", () => {
    const frame: AppleSimulatorLiveFrame = {
      status: "live",
      simulatorId,
      name: "iPhone 16",
      screen: { kind: "screenshot", reference: "apple-screenshot-live" },
      title: "Live · iPhone 16",
      message: "Showing the latest host-held screen capture for this thread.",
    };
    const { rerender } = render(
      <AppleSimulatorLiveFrameView frame={frame} screenUrl="blob:https://octant.local/screen" />,
    );
    expect(screen.queryByLabelText("Simulator input")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Tap on iPhone 16 Simulator screen")).not.toBeInTheDocument();

    const onInput = vi.fn();
    rerender(
      <AppleSimulatorLiveFrameView
        frame={frame}
        inputEnabled
        onInput={onInput}
        screenUrl="blob:https://octant.local/screen"
      />,
    );
    expect(screen.getByLabelText("Simulator input")).toBeVisible();
    expect(screen.getByLabelText("Tap on iPhone 16 Simulator screen")).toBeEnabled();
    expect(screen.getByLabelText("Type into Simulator")).toBeVisible();
    expect(screen.getByRole("button", { name: "Return" })).toBeVisible();
  });

  it("sends taps in screenshot image pixels even when the screen renders scaled down", () => {
    const frame: AppleSimulatorLiveFrame = {
      status: "live",
      simulatorId,
      name: "iPhone 16",
      screen: { kind: "screenshot", reference: "apple-screenshot-live" },
      title: "Live · iPhone 16",
      message: "Showing the latest host-held screen capture for this thread.",
    };
    const onInput = vi.fn();
    render(
      <AppleSimulatorLiveFrameView
        frame={frame}
        inputEnabled
        onInput={onInput}
        screenUrl="blob:https://octant.local/screen"
      />,
    );
    const image = screen.getByRole("img", { name: "iPhone 16 screen" });
    // The capture is 1179×2556 but the pane renders it at a third of that.
    Object.defineProperty(image, "naturalWidth", { value: 1179 });
    Object.defineProperty(image, "naturalHeight", { value: 2556 });
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 393, 852));
    fireEvent.click(screen.getByLabelText("Tap on iPhone 16 Simulator screen"), {
      clientX: 10 + 100,
      clientY: 20 + 200,
    });
    expect(onInput).toHaveBeenCalledWith({ kind: "tap", point: { x: 300, y: 600 } });
  });

  it("drops a tap that lands before the screenshot has decoded", () => {
    const frame: AppleSimulatorLiveFrame = {
      status: "live",
      simulatorId,
      name: "iPhone 16",
      screen: { kind: "screenshot", reference: "apple-screenshot-live" },
      title: "Live · iPhone 16",
      message: "Showing the latest host-held screen capture for this thread.",
    };
    const onInput = vi.fn();
    render(
      <AppleSimulatorLiveFrameView
        frame={frame}
        inputEnabled
        onInput={onInput}
        screenUrl="blob:https://octant.local/screen"
      />,
    );
    const image = screen.getByRole("img", { name: "iPhone 16 screen" });
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 393, 852));
    // jsdom leaves naturalWidth/naturalHeight at 0, exactly like an undecoded image.
    fireEvent.click(screen.getByLabelText("Tap on iPhone 16 Simulator screen"), {
      clientX: 100,
      clientY: 200,
    });
    expect(onInput).not.toHaveBeenCalled();
  });

  it("keeps unavailable frames read-only even when input is requested", () => {
    const frame: AppleSimulatorLiveFrame = {
      status: "unavailable",
      reason: "not-attachable",
      title: "Simulator frame is not attachable",
      message:
        "This client cannot attach a live Simulator frame. Open the thread on the Mac that owns the destination.",
    };
    render(<AppleSimulatorLiveFrameView frame={frame} inputEnabled onInput={vi.fn()} />);
    expect(screen.queryByLabelText("Simulator input")).not.toBeInTheDocument();
  });

  describe("with a live view", () => {
    const frame: AppleSimulatorLiveFrame = {
      status: "live",
      simulatorId,
      name: "iPhone 17",
      // No capture has been taken: the live view needs none.
      screen: { kind: "pending" },
      title: "Live · iPhone 17",
      message: "The destination is live.",
    };

    it("shows the streamed screen on a canvas without waiting for a capture", () => {
      const attach = vi.fn();
      render(
        <AppleSimulatorLiveFrameView
          frame={frame}
          liveScreen={{ status: "live", screen: { width: 1206, height: 2622 }, attach }}
        />,
      );

      const canvas = screen.getByLabelText("iPhone 17 live screen");
      expect(canvas.tagName).toBe("CANVAS");
      expect(attach).toHaveBeenCalledWith(canvas);
      expect(document.querySelector("img")).toBeNull();
    });

    // jsdom has no PointerEvent; a MouseEvent carries the same coordinates.
    if (typeof globalThis.PointerEvent === "undefined") {
      (globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {
        readonly isPrimary: boolean;
        constructor(type: string, init?: MouseEventInit & { readonly isPrimary?: boolean }) {
          super(type, init);
          this.isPrimary = init?.isPrimary ?? true;
        }
      };
    }
    afterEach(() => {
      vi.useRealTimers();
    });

    function liveView(props: { readonly busy?: boolean; readonly onInput: () => void }) {
      return (
        <AppleSimulatorLiveFrameView
          busy={props.busy === true}
          frame={frame}
          inputEnabled
          liveScreen={{ status: "live", screen: { width: 1206, height: 2622 }, attach: vi.fn() }}
          onInput={props.onInput}
        />
      );
    }
    function drawnAt402() {
      const canvas = screen.getByLabelText("iPhone 17 live screen");
      vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 402, 874));
      return screen.getByLabelText("Tap on iPhone 17 Simulator screen");
    }

    it("sends a press and release in one place as a tap on the device's own screen", () => {
      const onInput = vi.fn();
      render(liveView({ onInput }));
      const region = drawnAt402();

      fireEvent.pointerDown(region, { clientX: 10 + 201, clientY: 20 + 437, isPrimary: true });
      fireEvent.pointerUp(region, { clientX: 10 + 202, clientY: 20 + 437, isPrimary: true });

      expect(onInput).toHaveBeenCalledTimes(1);
      expect(onInput).toHaveBeenCalledWith({ kind: "tap", point: { x: 603, y: 1311 } });
    });

    it("leaves a right-click to the app instead of touching the device", () => {
      const onInput = vi.fn();
      render(liveView({ onInput }));
      const region = drawnAt402();

      // A right-click from the mouse, then a second touch point that is not primary.
      fireEvent.pointerDown(region, { clientX: 211, clientY: 457, button: 2, isPrimary: true });
      fireEvent.pointerUp(region, { clientX: 211, clientY: 457, button: 2, isPrimary: true });
      fireEvent.pointerDown(region, { clientX: 211, clientY: 457, button: 0, isPrimary: false });
      fireEvent.pointerUp(region, { clientX: 211, clientY: 457, button: 0, isPrimary: false });

      expect(onInput).not.toHaveBeenCalled();
    });

    it("sends a drag as one swipe when the finger lifts", () => {
      const onInput = vi.fn();
      render(liveView({ onInput }));
      const region = drawnAt402();

      fireEvent.pointerDown(region, { clientX: 211, clientY: 800, isPrimary: true });
      fireEvent.pointerUp(region, { clientX: 211, clientY: 300, isPrimary: true });

      expect(onInput).toHaveBeenCalledTimes(1);
      expect(onInput.mock.calls[0]?.[0]).toMatchObject({
        kind: "swipe",
        from: { x: 603, y: 2340 },
        to: { x: 603, y: 840 },
      });
    });

    it("types what is typed on the focused screen as one text once the typing pauses", () => {
      vi.useFakeTimers();
      const onInput = vi.fn();
      render(liveView({ onInput }));
      const region = drawnAt402();

      for (const key of ["O", "c", "t"]) fireEvent.keyDown(region, { key });
      expect(onInput).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(400);
      });

      expect(onInput).toHaveBeenCalledTimes(1);
      expect(onInput).toHaveBeenCalledWith({ kind: "type-text", text: "Oct" });
    });

    it("sends the text typed so far before a key that acts on it", () => {
      vi.useFakeTimers();
      const onInput = vi.fn();
      const { rerender } = render(liveView({ onInput }));
      const region = drawnAt402();

      fireEvent.keyDown(region, { key: "h" });
      fireEvent.keyDown(region, { key: "i" });
      fireEvent.keyDown(region, { key: "Enter" });

      // One action at a time: the text goes first, Return waits for it.
      expect(onInput.mock.calls.map(([intent]) => intent)).toEqual([
        { kind: "type-text", text: "hi" },
      ]);
      rerender(liveView({ onInput, busy: true }));
      rerender(liveView({ onInput, busy: false }));
      expect(onInput.mock.calls.map(([intent]) => intent)).toEqual([
        { kind: "type-text", text: "hi" },
        { kind: "key-press", key: "return" },
      ]);
    });

    it("sends text typed during an action once that action is over and the typing has paused", () => {
      vi.useFakeTimers();
      const onInput = vi.fn();
      const { rerender } = render(liveView({ onInput, busy: true }));
      const region = drawnAt402();

      fireEvent.keyDown(region, { key: "o" });
      fireEvent.keyDown(region, { key: "k" });
      // The running action finishes before the typing pause has passed.
      rerender(liveView({ onInput, busy: false }));
      expect(onInput).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(400);
      });

      expect(onInput).toHaveBeenCalledWith({ kind: "type-text", text: "ok" });
    });

    it("does not hold later input forever when an input never made the pane busy", () => {
      vi.useFakeTimers();
      const onInput = vi.fn();
      render(liveView({ onInput }));
      const region = drawnAt402();

      fireEvent.keyDown(region, { key: "Enter" });
      fireEvent.keyDown(region, { key: "Escape" });
      expect(onInput).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(1_100);
      });

      expect(onInput.mock.calls.map(([intent]) => intent)).toEqual([
        { kind: "key-press", key: "return" },
        { kind: "key-press", key: "escape" },
      ]);
    });

    it("never sends what was typed on one Simulator to the one the frame shows next", () => {
      vi.useFakeTimers();
      const onInput = vi.fn();
      const view = (name: string, id: string, busy: boolean) => (
        <AppleSimulatorLiveFrameView
          busy={busy}
          frame={{ ...frame, name, simulatorId: decodeAppleSimulatorId(id) }}
          inputEnabled
          liveScreen={{ status: "live", screen: { width: 1206, height: 2622 }, attach: vi.fn() }}
          onInput={onInput}
        />
      );
      const { rerender } = render(view("iPhone A", "90000000-0000-4000-8000-0000000000a1", true));
      fireEvent.keyDown(screen.getByLabelText("Tap on iPhone A Simulator screen"), { key: "x" });

      // A's shutdown finishes and the frame moves on to B while "x" is still waiting.
      rerender(view("iPhone B", "90000000-0000-4000-8000-0000000000b2", false));
      act(() => {
        vi.advanceTimersByTime(2_000);
      });

      expect(onInput).not.toHaveBeenCalled();
    });

    it("pairs a release with the finger that pressed, not with another one lifting", () => {
      const onInput = vi.fn();
      render(liveView({ onInput }));
      const region = drawnAt402();

      fireEvent.pointerDown(region, { clientX: 211, clientY: 800, isPrimary: true, pointerId: 1 });
      // A second finger comes and goes elsewhere while the first is still down.
      fireEvent.pointerUp(region, { clientX: 60, clientY: 100, isPrimary: false, pointerId: 2 });
      expect(onInput).not.toHaveBeenCalled();
      fireEvent.pointerUp(region, { clientX: 211, clientY: 300, isPrimary: true, pointerId: 1 });

      expect(onInput).toHaveBeenCalledTimes(1);
      expect(onInput.mock.calls[0]?.[0]).toMatchObject({
        kind: "swipe",
        from: { x: 603, y: 2340 },
        to: { x: 603, y: 840 },
      });
    });

    it("sends a space typed on its own as the Space key, since blank text is not a request", () => {
      vi.useFakeTimers();
      const onInput = vi.fn();
      render(liveView({ onInput }));
      const region = drawnAt402();

      fireEvent.keyDown(region, { key: " " });
      act(() => {
        vi.advanceTimersByTime(400);
      });

      expect(onInput.mock.calls.map(([intent]) => intent)).toEqual([
        { kind: "key-press", key: "space" },
      ]);
    });

    it("leaves app shortcuts alone while the screen has focus", () => {
      const onInput = vi.fn();
      render(liveView({ onInput }));
      const region = drawnAt402();

      const handled = fireEvent.keyDown(region, { key: "k", metaKey: true });

      expect(handled).toBe(true);
      expect(onInput).not.toHaveBeenCalled();
    });

    it("offers Home and Lock as the device's buttons", () => {
      const onInput = vi.fn();
      render(liveView({ onInput }));

      fireEvent.click(screen.getByRole("button", { name: "Home" }));
      fireEvent.click(screen.getByRole("button", { name: "Lock" }));

      expect(onInput.mock.calls.map(([intent]) => intent)).toEqual([
        { kind: "key-press", key: "home" },
        { kind: "key-press", key: "lock" },
      ]);
    });

    it("falls back to the captured still when the host has no live view", () => {
      render(
        <AppleSimulatorLiveFrameView
          frame={{ ...frame, screen: { kind: "screenshot", reference: "apple-screenshot-live" } }}
          liveScreen={{ status: "unavailable", message: "The live Simulator view stopped." }}
          screenUrl="blob:https://octant.local/screen"
        />,
      );

      expect(screen.getByRole("img", { name: "iPhone 17 screen" })).toBeDefined();
      expect(screen.queryByLabelText("iPhone 17 live screen")).toBeNull();
    });
  });
});
