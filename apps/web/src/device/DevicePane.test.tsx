import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceProblemFor, type DeviceChoice, type DeviceView } from "./deviceModel";
import { DevicePane, type DevicePaneProps } from "./DevicePane";

const iphone: DeviceChoice = { id: "sim-1", name: "iPhone 17", os: "iOS 27.0", state: "booted" };
const ipad: DeviceChoice = { id: "sim-2", name: "iPad Air", os: "iOS 27.0", state: "shutdown" };
const pixel: DeviceChoice = { id: "avd-1", name: "Pixel 9", os: "API 36", state: "booted" };

const streaming = (device: DeviceChoice = iphone): DeviceView => ({
  kind: "live",
  device,
  screen: { kind: "stream", size: { width: 1206, height: 2622 }, attach: () => undefined },
  liveView: "streaming",
});

function pane(overrides: Partial<DevicePaneProps> = {}) {
  const onAction = vi.fn();
  const onInput = vi.fn();
  const props: DevicePaneProps = {
    platform: "ios",
    view: streaming(),
    devices: [iphone, ipad],
    busy: false,
    onAction,
    onInput,
    inputAllowed: true,
    needsApproval: false,
    diagnostics: { facts: [{ label: "Live view", value: "Streaming" }], running: [], recent: [] },
    ...overrides,
  };
  const view = render(<DevicePane {...props} />);
  return { ...view, onAction, onInput, props };
}

/** The streamed screen measures taps against the drawn canvas. */
function placeCanvas() {
  const canvas = screen.getByRole("img", { name: "iPhone 17 live screen" });
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 201, height: 437, right: 201, bottom: 437 }) as DOMRect;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DevicePane", () => {
  it("names the running device and its state in words in one toolbar", () => {
    pane();
    const toolbar = screen.getByRole("toolbar", { name: "iOS Simulator controls" });
    expect(toolbar).toHaveTextContent("iPhone 17");
    expect(toolbar).toHaveTextContent("iOS 27.0 ·");
    expect(toolbar).toHaveTextContent("Running");
    expect(within(toolbar).getByRole("button", { name: "Home" })).toBeEnabled();
    expect(within(toolbar).getByRole("button", { name: "Screenshot" })).toBeEnabled();
    expect(within(toolbar).queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "iPhone 17 screen. Click to tap, drag to swipe, type while focused",
      }),
    ).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("moves between toolbar controls with the arrow keys", () => {
    pane();
    const home = screen.getByRole("button", { name: "Home" });
    home.focus();
    fireEvent.keyDown(home, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "Screenshot" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement ?? home, { key: "ArrowLeft" });
    expect(home).toHaveFocus();
  });

  it("says where the keys go while the screen has focus", () => {
    pane();
    const screenControl = screen.getByRole("button", { name: /iPhone 17 screen/ });
    const caption = screen.getByText("Keys go to iPhone 17 · Tab to leave");
    expect(caption).not.toBeVisible();
    fireEvent.focus(screenControl);
    expect(caption).toBeVisible();
    fireEvent.blur(screenControl);
    expect(caption).not.toBeVisible();
  });

  it("shows a setup checklist whose missing row says the one fix", () => {
    const { onAction } = pane({
      view: {
        kind: "setup",
        title: "Set up the iOS Simulator",
        checks: [
          { id: "xcode", label: "Xcode selected", state: "ok", detail: "Xcode 26.0" },
          {
            id: "runtime",
            label: "iOS Simulator runtime",
            state: "missing",
            detail: "None installed.",
            fix: "Add one in Xcode › Settings › Components.",
          },
          { id: "project", label: "Project found", state: "waiting" },
        ],
      },
      devices: [],
    });
    expect(screen.getByRole("toolbar")).toHaveTextContent("Not set up");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("Add one in Xcode › Settings › Components.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Home" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onAction).toHaveBeenCalledWith({ kind: "check-again" });
  });

  it("offers a picker when nothing is running and boots the device chosen", () => {
    const { onAction } = pane({
      view: { kind: "pick" },
      devices: [
        { ...iphone, state: "shutdown" },
        ipad,
        { id: "sim-3", name: "Broken", state: "unavailable" },
      ],
    });
    expect(screen.getByRole("toolbar")).toHaveTextContent("No device running");
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.textContent)).toEqual([
      expect.stringContaining("iPhone 17"),
      expect.stringContaining("iPad Air"),
    ]);
    fireEvent.click(screen.getByRole("radio", { name: /iPad Air/ }));
    expect(screen.getByRole("radio", { name: /iPad Air/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Boot iPad Air" }));
    expect(onAction).toHaveBeenCalledWith({ kind: "boot", deviceId: "sim-2" });
  });

  it("keeps the silhouette while booting and disables the device's buttons", () => {
    pane({ view: { kind: "booting", device: { ...iphone, state: "booting" } } });
    expect(screen.getByRole("toolbar")).toHaveTextContent("Booting");
    expect(screen.getByText("Booting iPhone 17…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Home" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Screenshot" })).toBeDisabled();
  });

  it("asks to allow input in one line and never from a click on the screen", () => {
    const { onAction, onInput } = pane({ inputAllowed: false, needsApproval: true });
    const line = screen.getByRole("status");
    expect(line).toHaveTextContent("Allow input on iPhone 17?");
    const screenControl = screen.getByRole("button", { name: "iPhone 17 screen" });
    expect(screenControl).toBeDisabled();
    fireEvent.pointerDown(screenControl, { button: 0, isPrimary: true, pointerId: 1 });
    fireEvent.pointerUp(screenControl, { button: 0, isPrimary: true, pointerId: 1 });
    expect(onAction).not.toHaveBeenCalled();
    expect(onInput).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Home" })).toBeDisabled();

    fireEvent.click(within(line).getByRole("button", { name: "Allow" }));
    expect(onAction).toHaveBeenCalledWith({ kind: "allow-input" });
  });

  it("leaves the screen view only after Not now, and View only brings the line back", () => {
    pane({ inputAllowed: false, needsApproval: true });
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText(/Allow input on/)).not.toBeInTheDocument();
    const viewOnly = screen.getByRole("button", { name: "View only" });
    fireEvent.click(viewOnly);
    expect(screen.getByRole("status")).toHaveTextContent("Allow input on iPhone 17?");
    expect(screen.getByRole("button", { name: "Allow" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "View only" })).not.toBeInTheDocument();
  });

  it("asks again for the next device after Not now on this one", () => {
    const { rerender, props } = pane({ inputAllowed: false, needsApproval: true });
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    rerender(
      <DevicePane {...props} view={streaming({ ...iphone, id: "sim-9", name: "iPhone Air" })} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Allow input on iPhone Air?");
  });

  it("sends toolbar Home after the text typed just before it", () => {
    vi.useFakeTimers();
    const { onInput, rerender, props } = pane();
    const screenControl = screen.getByRole("button", { name: /iPhone 17 screen/ });
    screenControl.focus();
    fireEvent.keyDown(screenControl, { key: "h" });
    fireEvent.keyDown(screenControl, { key: "i" });
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(onInput).toHaveBeenNthCalledWith(1, { kind: "type-text", text: "hi" });
    expect(onInput).toHaveBeenCalledTimes(1);
    // The text is running; Home waits for it rather than overtaking.
    rerender(<DevicePane {...props} busy />);
    rerender(<DevicePane {...props} busy={false} />);
    expect(onInput).toHaveBeenNthCalledWith(2, { kind: "key-press", key: "home" });
  });

  it("sends a press and release on the screen as one tap in the device's pixels", () => {
    const { onInput } = pane();
    placeCanvas();
    const screenControl = screen.getByRole("button", { name: /iPhone 17 screen/ });
    fireEvent.pointerDown(screenControl, {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      clientX: 100,
      clientY: 200,
    });
    fireEvent.pointerUp(screenControl, { pointerId: 1, clientX: 100, clientY: 200 });
    expect(onInput).toHaveBeenCalledWith({ kind: "tap", point: { x: 600, y: 1200 } });
  });

  it("lists only what the host supports in More, and Shut down asks to shut down", async () => {
    const user = userEvent.setup();
    const { onAction } = pane();
    const more = screen.getByRole("button", { name: "More" });
    more.focus();
    await user.keyboard("{Enter}");
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Type text…",
      "Lock",
      "Switch device…",
      "Diagnostics",
      "Stop live view",
      "Shut down iPhone 17",
    ]);
    for (const later of [/Rotate/, /Volume/, /Record/, /Open URL/]) {
      expect(screen.queryByRole("menuitem", { name: later })).not.toBeInTheDocument();
    }
    await user.click(screen.getByRole("menuitem", { name: "Shut down iPhone 17" }));
    expect(onAction).toHaveBeenCalledWith({ kind: "shutdown" });
  });

  it("offers neither typing nor the device's buttons in More until input is allowed", async () => {
    const user = userEvent.setup();
    pane({ inputAllowed: false, needsApproval: true });
    screen.getByRole("button", { name: "More" }).focus();
    await user.keyboard("{Enter}");
    await screen.findAllByRole("menuitem");
    expect(screen.queryByRole("menuitem", { name: "Type text…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Lock" })).not.toBeInTheDocument();
  });

  it("types text from More through the same queue", async () => {
    const user = userEvent.setup();
    const { onInput } = pane();
    screen.getByRole("button", { name: "More" }).focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: "Type text…" }));
    const field = await screen.findByRole("textbox", { name: "Text to type on iPhone 17" });
    await user.type(field, "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onInput).toHaveBeenCalledWith({ kind: "type-text", text: "hello" });
  });

  it("switches device from the toolbar's device menu", async () => {
    const user = userEvent.setup();
    const { onAction } = pane();
    screen.getByRole("button", { name: "iPhone 17, switch device" }).focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitemradio", { name: "iPad Air" }));
    expect(onAction).toHaveBeenCalledWith({ kind: "select", deviceId: "sim-2" });
  });

  it("adds Back for Android and leaves it out for the iOS Simulator", () => {
    const { onInput } = pane({ platform: "android", view: streaming(pixel), devices: [pixel] });
    expect(screen.getByRole("region", { name: "Android emulator" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onInput).toHaveBeenCalledWith({ kind: "key-press", key: "back" });
  });

  it("shows an error as one sentence with exactly one fix", () => {
    const retry = vi.fn();
    const problem = deviceProblemFor(
      {
        kind: "outcome",
        intent: { kind: "tap", simulatorId: "sim-1" },
        outcome: "failed",
      },
      { platform: "ios", deviceName: "iPhone 17", retry },
    );
    pane({ problem });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Input didn't reach iPhone 17.");
    expect(alert).not.toHaveTextContent("Apple tap failed");
    const buttons = within(alert).getAllByRole("button");
    expect(
      buttons.map((button) => button.textContent || button.getAttribute("aria-label")),
    ).toEqual(["Try again", "Dismiss"]);
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledWith({ kind: "tap", simulatorId: "sim-1" });
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says a refusal the host names in one sentence with its one fix", () => {
    const allowInput = vi.fn();
    const retry = vi.fn();
    const intent = { kind: "key-press", simulatorId: "sim-1" };
    const context = { platform: "ios", deviceName: "iPhone 17", retry, allowInput } as const;
    expect(deviceProblemFor({ kind: "refused", intent, reason: "unauthorized" }, context)).toEqual({
      message: "Input on iPhone 17 isn't allowed right now.",
      fix: { label: "Allow input", run: allowInput },
    });
    const unknown = deviceProblemFor({ kind: "refused", intent, reason: "something-new" }, context);
    expect(unknown.message).toBe("iPhone 17 refused that action.");
    unknown.fix?.run();
    expect(retry).toHaveBeenCalledWith(intent);
  });

  it("keeps a dismissed error hidden until that failure clears and a new one comes", () => {
    const { rerender, props } = pane({ problem: { message: "Input didn't reach iPhone 17." } });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    // The adapters rebuild the problem on every render.
    rerender(<DevicePane {...props} problem={{ message: "Input didn't reach iPhone 17." }} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const { problem: _cleared, ...withoutProblem } = props;
    rerender(<DevicePane {...withoutProblem} />);
    rerender(<DevicePane {...props} problem={{ message: "Input didn't reach iPhone 17." }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Input didn't reach iPhone 17.");
  });

  it("puts an error ahead of the approval line", () => {
    pane({
      inputAllowed: false,
      needsApproval: true,
      problem: { message: "Nothing ran, because it wasn't approved." },
    });
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.queryByText(/Allow input on/)).not.toBeInTheDocument();
  });

  it("offers Reconnect when the live view stops, with the last frame dimmed", () => {
    const { onAction } = pane({
      view: {
        kind: "live",
        device: iphone,
        screen: { kind: "still", url: "https://octant.test/still.png" },
        liveView: "lost",
      },
    });
    expect(screen.getByRole("toolbar")).toHaveTextContent("Live view lost");
    expect(screen.getByText("Last frame")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(onAction).toHaveBeenCalledWith({ kind: "reconnect" });
  });

  it("says a stale screen is from before the restart", () => {
    pane({ view: { kind: "last-screen", device: iphone, reason: "restart" } });
    expect(screen.getByRole("toolbar")).toHaveTextContent("Last screen");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Showing the last screen from before Octant restarted.",
    );
  });

  it("says a device bound to another thread is unavailable, with nothing to press", () => {
    pane({
      view: { kind: "unavailable", message: "This Simulator belongs to another Code thread." },
    });
    const line = screen.getByRole("status");
    expect(line).toHaveTextContent("This Simulator belongs to another Code thread.");
    expect(within(line).queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers no control at all on a surface that may only look", () => {
    render(
      <DevicePane
        busy={false}
        devices={[iphone]}
        diagnostics={{ facts: [], running: [], recent: [] }}
        inputAllowed
        needsApproval={false}
        platform="ios"
        view={streaming()}
      />,
    );
    expect(screen.getByRole("button", { name: "Home" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Screenshot" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "iPhone 17 screen" })).toBeDisabled();
  });

  it("opens Diagnostics with the reason behind a line", async () => {
    const user = userEvent.setup();
    pane({
      diagnostics: {
        facts: [{ label: "Last problem", value: "tap: failed" }],
        running: [],
        recent: [{ id: "1", label: "Tap", outcome: "Failed", detail: "helper exited" }],
      },
    });
    screen.getByRole("button", { name: "More" }).focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: "Diagnostics" }));
    const card = screen.getByRole("region", { name: "Diagnostics" });
    expect(card).toHaveTextContent("tap: failed");
    expect(card).toHaveTextContent("helper exited");
    // The menu hands focus back to More; Escape inside the card closes it.
    act(() => {
      fireEvent.keyDown(within(card).getByRole("button", { name: "Close diagnostics" }), {
        key: "Escape",
      });
    });
    expect(screen.queryByRole("region", { name: "Diagnostics" })).not.toBeInTheDocument();
  });
});
