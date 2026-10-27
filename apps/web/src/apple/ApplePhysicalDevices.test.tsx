import {
  decodeAppleDeviceResponse,
  type AppleDeviceDiscovery,
  type AppleDeviceRecord,
} from "@octant/contracts/apple-toolchain";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplePhysicalDevices, type ApplePhysicalDevicesProps } from "./ApplePhysicalDevices";

const ids = {
  wired: "60000000-0000-4000-8000-000000000001",
  network: "60000000-0000-4000-8000-000000000002",
  locked: "60000000-0000-4000-8000-000000000003",
  developerModeOff: "60000000-0000-4000-8000-000000000004",
  untrusted: "60000000-0000-4000-8000-000000000005",
  unavailable: "60000000-0000-4000-8000-000000000006",
};

function record(
  id: string,
  name: string,
  state: AppleDeviceRecord["state"],
  connection: AppleDeviceRecord["connection"] = "wired",
) {
  return {
    deviceId: id,
    name,
    model: "iPhone 16 Pro",
    platform: "ios",
    osVersion: "26.1",
    connection,
    state,
  };
}

function discovery(overrides: Record<string, unknown> = {}): AppleDeviceDiscovery {
  const answer = decodeAppleDeviceResponse({
    kind: "apple-device-discovery",
    discovery: {
      devices: [
        record(ids.wired, "Henrik's iPhone", "connected"),
        record(ids.network, "Studio iPad", "connected", "network"),
        record(ids.locked, "Test iPhone", "locked"),
        record(ids.developerModeOff, "Family iPhone", "developer-mode-off"),
        record(ids.untrusted, "Borrowed iPhone", "untrusted"),
        record(ids.unavailable, "Old iPad", "unavailable", "network"),
      ],
      tooling: ["list-devices", "install-app", "launch-app", "screenshot"],
      leases: [],
      discoveredAt: "2026-10-27T12:00:00.000Z",
      ...overrides,
    },
  });
  if (answer.kind !== "apple-device-discovery") throw new Error("not a discovery");
  return answer.discovery;
}

function show(overrides: Partial<ApplePhysicalDevicesProps> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onUseDevice: vi.fn(),
    onRelease: vi.fn(),
    onCapture: vi.fn(),
    onTeamChange: vi.fn(),
    onCheckAgain: vi.fn(),
  };
  const props: ApplePhysicalDevicesProps = {
    status: "ready",
    discovery: discovery(),
    selectedDeviceId: ids.wired,
    team: "",
    busy: false,
    canConfirmLease: true,
    ...handlers,
    ...overrides,
  };
  render(<ApplePhysicalDevices {...props} />);
  return handlers;
}

const checklist = () => within(screen.getByRole("list", { name: "Device setup" }));

afterEach(cleanup);

describe("ApplePhysicalDevices", () => {
  it("lists every paired device with its connection and its state in words", () => {
    show();
    const picker = within(screen.getByRole("list", { name: "Paired devices" }));
    expect(picker.getByRole("button", { name: /Henrik's iPhone/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const [name, words] of [
      ["Henrik's iPhone", "Cable · Ready"],
      ["Studio iPad", "Network · Ready"],
      ["Test iPhone", "Cable · Locked"],
      ["Family iPhone", "Cable · Developer Mode off"],
      ["Borrowed iPhone", "Cable · Not trusted"],
      ["Old iPad", "Network · Unavailable"],
    ] as const) {
      expect(picker.getByRole("button", { name: new RegExp(name) })).toHaveTextContent(words);
    }
  });

  it("shows the one setup step each device state still needs, and nothing as passed that was not checked", () => {
    const cases = [
      [ids.wired, ["ok", "ok", "ok"], "Ready to use."],
      [ids.locked, ["ok", "ok", "ok"], "Unlock it"],
      [ids.developerModeOff, ["ok", "ok", "missing"], "Developer Mode"],
      [ids.untrusted, ["ok", "missing", "waiting"], "Trust"],
      [ids.unavailable, ["missing", "waiting", "waiting"], "cable"],
    ] as const;
    for (const [deviceId, rows, sentence] of cases) {
      show({ selectedDeviceId: deviceId });
      const states = ["Reachable from this Mac", "Paired and trusted", "Developer Mode on"].map(
        (label) => checklist().getByText(label).closest("li")?.getAttribute("data-state"),
      );
      expect(states).toEqual(rows);
      expect(screen.getByRole("status")).toHaveTextContent(sentence);
      cleanup();
    }
  });

  it("asks for the development team and counts only a real team ID", () => {
    const { onTeamChange } = show();
    expect(
      checklist().getByText("Development team").closest("li")?.getAttribute("data-state"),
    ).toBe("missing");
    fireEvent.change(screen.getByLabelText("Team ID"), { target: { value: "a1b2c3d4e5" } });
    expect(onTeamChange).toHaveBeenCalledWith("A1B2C3D4E5");
    cleanup();
    show({ team: "A1B2C3D4E5" });
    expect(
      checklist().getByText("Development team").closest("li")?.getAttribute("data-state"),
    ).toBe("ok");
  });

  it("lets this thread use a free device only through the confirmation at the Mac", () => {
    const { onUseDevice, onCapture } = show();
    fireEvent.click(screen.getByRole("button", { name: "Let this thread use Henrik's iPhone…" }));
    expect(onUseDevice).toHaveBeenCalledWith(ids.wired);
    // Nothing on the device is offered before the lease.
    expect(screen.queryByRole("button", { name: /Capture/ })).toBeNull();
    expect(onCapture).not.toHaveBeenCalled();
    cleanup();
    show({ canConfirmLease: false });
    expect(screen.queryByRole("button", { name: /Let this thread use/ })).toBeNull();
    expect(screen.getByText(/confirmed in Octant on the Mac/)).toBeInTheDocument();
    cleanup();
    show({ selectedDeviceId: ids.unavailable });
    expect(screen.queryByRole("button", { name: /Let this thread use/ })).toBeNull();
  });

  it("never offers another thread's device, and does not name that thread", () => {
    show({ discovery: discovery({ leases: [{ deviceId: ids.wired, holder: "another-thread" }] }) });
    expect(screen.getByText("Another thread is using Henrik's iPhone.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Let this thread use|Release|Capture/ }),
    ).toBeNull();
  });

  it("captures and shows the latest screenshot of the device this thread holds", () => {
    const leased = discovery({ leases: [{ deviceId: ids.wired, holder: "this-thread" }] });
    const { onCapture, onRelease } = show({
      discovery: leased,
      screenshotUrl: "blob:latest",
    });
    fireEvent.click(screen.getByRole("button", { name: "Capture Henrik's iPhone's screen" }));
    expect(onCapture).toHaveBeenCalledWith(ids.wired);
    expect(
      screen.getByRole("img", { name: "Latest screenshot of Henrik's iPhone" }),
    ).toHaveAttribute("src", "blob:latest");
    expect(screen.getByText(/no live view/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop using Henrik's iPhone" }));
    expect(onRelease).toHaveBeenCalledWith(ids.wired);
  });

  it("does not offer a capture a locked phone would refuse", () => {
    show({
      discovery: discovery({ leases: [{ deviceId: ids.locked, holder: "this-thread" }] }),
      selectedDeviceId: ids.locked,
    });
    expect(screen.getByRole("button", { name: "Capture Test iPhone's screen" })).toBeDisabled();
  });

  it("says screenshots are unavailable when this Mac's Xcode offers none", () => {
    show({
      discovery: discovery({
        tooling: ["list-devices", "install-app", "launch-app"],
        leases: [{ deviceId: ids.wired, holder: "this-thread" }],
      }),
    });
    expect(screen.queryByRole("button", { name: /Capture/ })).toBeNull();
    expect(
      screen.getByText(
        "Screenshots are unavailable: this Mac's Xcode offers no device screenshot.",
      ),
    ).toBeInTheDocument();
  });

  it("names a missing device layer and offers to check again", () => {
    const { onCheckAgain } = show({
      status: "failed",
      failure: "Physical devices need Xcode on this Mac.",
    });
    expect(screen.getByText("Physical devices need Xcode on this Mac.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onCheckAgain).toHaveBeenCalled();
    cleanup();
    show({ discovery: discovery({ devices: [] }) });
    expect(screen.getByText(/No iPhone or iPad is paired with this Mac/)).toBeInTheDocument();
  });
});
