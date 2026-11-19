import type { NewDeviceAlertsClient } from "@octant/client-runtime/new-device-alerts-client";
import { decodeNewDeviceAlertList, type NewDeviceAlertList } from "@octant/contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NewDeviceAlerts } from "./NewDeviceAlerts";

const tablet = {
  kind: "hub-member",
  alertId: "00000000-0000-4000-8000-000000000a01",
  name: "Tablet",
  role: "spoke",
  identityKeyFingerprint: "c".repeat(64),
  raisedAt: "2026-11-19T22:00:00.000Z",
  privateAddress: "100.101.102.106",
} as const;

const phone = {
  kind: "paired-device",
  alertId: "00000000-0000-4000-8000-000000000b01",
  deviceId: "00000000-0000-4000-8000-000000000b02",
  name: "Ada's phone",
  deviceKeyFingerprint: "d".repeat(64),
  raisedAt: "2026-11-19T22:05:00.000Z",
  privateAddress: "192.168.1.20",
} as const;

function client(raw: {
  readonly alerts: ReadonlyArray<typeof tablet | typeof phone>;
  readonly removesHere: boolean;
}): NewDeviceAlertsClient & {
  readonly dismissed: string[];
} {
  const list: NewDeviceAlertList = decodeNewDeviceAlertList(raw);
  const dismissed: string[] = [];
  return {
    dismissed,
    read: vi.fn(async () => list),
    dismiss: vi.fn(async (alertId: string) => {
      dismissed.push(alertId);
      return true;
    }),
  };
}

describe("new-device alerts", () => {
  it("names each new device and its private address, and says where to remove it from on a device that cannot", async () => {
    render(<NewDeviceAlerts client={client({ alerts: [tablet, phone], removesHere: false })} />);
    expect(await screen.findByText("Tablet joined the hub")).toBeTruthy();
    expect(screen.getByText("Ada's phone paired with this computer")).toBeTruthy();
    expect(screen.getByText(/100\.101\.102\.106/)).toBeTruthy();
    expect(screen.getByText(/192\.168\.1\.20/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(
      screen.getAllByText(/remove it from a window on this computer or an owner device/i),
    ).toHaveLength(2);
  });

  it("lets a window dismiss a paired device's alert or remove the device", async () => {
    const alerts = client({ alerts: [phone], removesHere: true });
    const removed: string[] = [];
    render(
      <NewDeviceAlerts
        client={alerts}
        onRemoveDevice={async (deviceId) => void removed.push(deviceId)}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss Ada's phone" }));
    await waitFor(() => expect(alerts.dismissed).toEqual([phone.alertId]));
    await act(async () => {
      await userEvent.click(
        screen.getByRole("button", { name: "Remove Ada's phone from this computer" }),
      );
    });
    expect(removed).toEqual([phone.deviceId]);
  });

  it("shows only the kinds a surface asks for", async () => {
    render(
      <NewDeviceAlerts
        client={client({ alerts: [tablet, phone], removesHere: true })}
        kinds={["paired-device"]}
      />,
    );
    expect(await screen.findByText("Ada's phone paired with this computer")).toBeTruthy();
    expect(screen.queryByText("Tablet joined the hub")).toBeNull();
  });
});
