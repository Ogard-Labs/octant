import { describe, expect, it } from "vitest";
import {
  chromeButtonIndex,
  deviceElements,
  deviceScreenRect,
  driverKeyFor,
  elementAtPoint,
  elementForTarget,
  isDeviceHubWindow,
  keyPressesFor,
  windowPointFor,
} from "./deviceHubInput";

// Device Hub 27.0 showing an iPhone 17 Pro at 1783,774 in a 429×929 window,
// with the Settings root screen bridged into the tree.
const window = { x: 1783, y: 774, width: 429, height: 929 };
const frame = { width: 1206, height: 2622 };
const elements = [
  { element_index: 0, role: "AXWindow", label: "iPhone 17 Pro – iOS 27.0", actions: [] },
  {
    element_index: 4,
    role: "AXButton",
    label: "Generelt",
    actions: ["AXPress"],
    frame: { x: 1830.5, y: 1187.1, w: 335, h: 47.2 },
  },
  {
    element_index: 13,
    role: "AXTextField",
    label: "Søk",
    actions: ["AXPress"],
    frame: { x: 1841.4, y: 1575.1, w: 313.3, h: 25.4 },
  },
  {
    element_index: 29,
    role: "AXButton",
    label: "Home",
    actions: ["AXPress"],
    frame: { x: 1926, y: 1663, w: 32, h: 28 },
  },
  {
    element_index: 31,
    role: "AXButton",
    label: "Record",
    actions: ["AXPress"],
    frame: { x: 1994, y: 1663, w: 32, h: 28 },
  },
  {
    element_index: 33,
    role: "AXToolbar",
    label: "",
    actions: [],
    frame: { x: 1783, y: 774, w: 429, h: 52 },
  },
  {
    element_index: 34,
    role: "AXButton",
    label: "Show in Device Hub",
    parent_index: 33,
    actions: ["AXPress"],
    frame: { x: 2131, y: 774, w: 36, h: 52 },
  },
];

describe("Device Hub input geometry", () => {
  it("keeps Device Hub's own controls out of the device's pressable elements", () => {
    const labels = deviceElements(elements, window).map((element) => element.label);
    expect(labels).toEqual(["Generelt", "Søk"]);
  });

  it("maps a screenshot pixel onto the row drawn there and never onto the bars", () => {
    const screen = deviceScreenRect(window, frame);
    // Measured on the real window: the light screen area began at 33,68 and was 793 px tall.
    expect(Math.abs(screen.x - 33)).toBeLessThan(2);
    expect(Math.abs(screen.y - 68)).toBeLessThan(2);
    expect(Math.abs(screen.height - 793)).toBeLessThan(2);
    const device = deviceElements(elements, window);
    const generelt = elementAtPoint(device, windowPointFor({ x: 562, y: 1221 }, frame, screen));
    expect(generelt?.label).toBe("Generelt");
    // The bottom of the screenshot sits over Device Hub's Record button; the
    // point must resolve to nothing rather than to the recording control.
    expect(
      elementAtPoint(device, windowPointFor({ x: 1000, y: 2610 }, frame, screen)),
    ).toBeUndefined();
  });

  it("finds a named target exactly before by containment, and Device Hub's Home control by label", () => {
    const device = deviceElements(elements, window);
    expect(elementForTarget(device, "generelt")?.index).toBe(4);
    expect(elementForTarget(device, "Sø")?.index).toBe(13);
    expect(elementForTarget(device, "Record")).toBeUndefined();
    expect(chromeButtonIndex(elements, "Home")).toBe(29);
  });

  it("recognises the device window by app and title, on screen only", () => {
    expect(
      isDeviceHubWindow(
        { app_name: "Device Hub", title: "iPhone 17 Pro", is_on_screen: true },
        "iPhone 17 Pro",
      ),
    ).toBe(true);
    expect(
      isDeviceHubWindow(
        { app_name: "Device Hub", title: "iPhone 17 Pro – iOS 27.0" },
        "iPhone 17 Pro",
      ),
    ).toBe(true);
    expect(
      isDeviceHubWindow(
        { app_name: "Device Hub", title: "", is_on_screen: false },
        "iPhone 17 Pro",
      ),
    ).toBe(false);
    expect(isDeviceHubWindow({ app_name: "Finder", title: "iPhone 17 Pro" }, "iPhone 17 Pro")).toBe(
      false,
    );
  });
});

describe("Device Hub keyboard delivery", () => {
  it("sends letters, digits, space and newline as key presses and names what it cannot type", () => {
    expect(keyPressesFor("Hi 42\n")).toEqual({
      kind: "presses",
      presses: [
        { key: "h", modifiers: ["shift"] },
        { key: "i" },
        { key: "space" },
        { key: "4" },
        { key: "2" },
        { key: "return" },
      ],
    });
    expect(keyPressesFor("a@b.c")).toEqual({ kind: "unsupported", characters: ["@", "."] });
  });

  it("maps the workbench key names the pane and the tool send", () => {
    expect(driverKeyFor("Return")).toBe("return");
    expect(driverKeyFor("enter")).toBe("return");
    expect(driverKeyFor("Arrow-Down")).toBe("down");
    expect(driverKeyFor("backspace")).toBe("delete");
    expect(driverKeyFor("home")).toBeUndefined();
    expect(driverKeyFor("f13")).toBeUndefined();
  });
});
