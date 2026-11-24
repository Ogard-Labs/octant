import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MicrophonePicker } from "./MicrophonePicker";

function installDevices(devices: ReadonlyArray<Partial<MediaDeviceInfo>>) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: vi.fn(async () => devices),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
}

afterEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

describe("MicrophonePicker", () => {
  it("lists real microphones and remembers the one picked on this computer", async () => {
    const user = userEvent.setup();
    installDevices([
      { kind: "audioinput", deviceId: "default", label: "Default - MacBook Microphone" },
      { kind: "audioinput", deviceId: "built-in", label: "MacBook Microphone" },
      { kind: "audioinput", deviceId: "usb-headset", label: "USB Headset" },
      { kind: "audiooutput", deviceId: "speakers", label: "Speakers" },
    ]);
    render(<MicrophonePicker />);

    const select = screen.getByRole("combobox", { name: "Microphone" });
    expect(select.textContent).toContain("System default");
    await user.click(select);
    await screen.findByRole("option", { name: "USB Headset" });
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "System default",
      "MacBook Microphone",
      "USB Headset",
    ]);
    await user.click(screen.getByRole("option", { name: "USB Headset" }));

    expect(localStorage.getItem("octant.voice-microphone.v1")).toBe("usb-headset");
    expect(screen.getByRole("combobox", { name: "Microphone" }).textContent).toContain(
      "USB Headset",
    );
  });

  it("says when the chosen microphone is not connected", async () => {
    installDevices([{ kind: "audioinput", deviceId: "built-in", label: "MacBook Microphone" }]);
    localStorage.setItem("octant.voice-microphone.v1", "usb-headset");
    render(<MicrophonePicker />);

    expect((await screen.findByRole("status")).textContent).toBe(
      "That microphone isn't connected, so the system default records instead.",
    );
  });

  it("says how to reveal microphones the browser hides until it is allowed", async () => {
    installDevices([{ kind: "audioinput", deviceId: "", label: "" }]);
    render(<MicrophonePicker />);

    expect(
      await screen.findByText(
        "Allow the microphone once, for example with Test microphone, to see each one by name.",
      ),
    ).toBeVisible();
  });
});
