import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { HubAdministrationOperation } from "../shell/hostBridge";
import HubDeviceRelaySection from "./HubDeviceRelaySection";

type Answer = { readonly status: number; readonly body: unknown };

function renderRelay(options: {
  readonly hubOn?: boolean;
  readonly member?: boolean;
  readonly relayGranted?: boolean;
  readonly hubEnabled?: boolean;
  readonly devices?: ReadonlyArray<{ deviceId: string; allowed: boolean }>;
  readonly answers?: Partial<Record<HubAdministrationOperation, Answer>>;
}) {
  const calls: Array<{ operation: HubAdministrationOperation; body: unknown }> = [];
  const request = vi.fn(async (operation: HubAdministrationOperation, sent?: unknown) => {
    calls.push({ operation, body: sent });
    return options.answers?.[operation] ?? { status: 200, body: { status: "changed" } };
  });
  const onChanged = vi.fn(async () => undefined);
  render(
    <HubDeviceRelaySection
      body={{
        hub: { enabled: options.hubEnabled ?? false, hosts: 2, tunnels: 1 },
        devices: options.devices ?? [],
      }}
      deviceNames={new Map([["phone-1", "Henrik's phone"]])}
      hubOn={options.hubOn ?? false}
      member={options.member ?? true}
      onChanged={onChanged}
      relayGranted={options.relayGranted ?? true}
      request={request}
    />,
  );
  return { calls, onChanged };
}

describe("HubDeviceRelaySection", () => {
  it("turns the hub's device relay on from the hub's window", async () => {
    const user = userEvent.setup();
    const { calls, onChanged } = renderRelay({ hubOn: true, member: false });
    expect(screen.getByText(/Off by default\./)).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Device relay" }));
    expect(calls).toEqual([{ operation: "relay", body: { enabled: true } }]);
    expect(
      await screen.findByText(
        "Device relay is on. A member's device comes through only if that member lists it.",
      ),
    ).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it("shows no relay switch on a member that is not the hub", () => {
    renderRelay({ devices: [{ deviceId: "phone-1", allowed: false }] });
    expect(screen.queryByRole("switch", { name: "Device relay" })).not.toBeInTheDocument();
  });

  it("lets a member allow one of its paired devices through the hub, by name", async () => {
    const user = userEvent.setup();
    const { calls } = renderRelay({ devices: [{ deviceId: "phone-1", allowed: false }] });
    expect(screen.getByText("Private network only")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Let Henrik's phone through the hub" }));
    expect(calls).toEqual([
      { operation: "relay-device", body: { deviceId: "phone-1", allowed: true } },
    ]);
    expect(
      await screen.findByText("Henrik's phone may reach this computer through the hub."),
    ).toBeInTheDocument();
  });

  it("withdraws an allowed device, and says why the host refused one it no longer knows", async () => {
    const user = userEvent.setup();
    renderRelay({
      devices: [{ deviceId: "phone-1", allowed: true }],
      answers: {
        "relay-device": { status: 409, body: { status: "refused", kind: "unknown-device" } },
      },
    });
    await user.click(screen.getByRole("switch", { name: "Let Henrik's phone through the hub" }));
    expect(
      await screen.findByText("That device is no longer paired with this computer."),
    ).toBeInTheDocument();
  });

  it("asks for the Relay grant item before a device can be allowed, but still lets one be withdrawn", () => {
    renderRelay({
      relayGranted: false,
      devices: [
        { deviceId: "phone-1", allowed: false },
        { deviceId: "laptop-1", allowed: true },
      ],
    });
    expect(
      screen.getByText(
        "Tick Relay in this computer's hub grant to let a device come through the hub.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Let Henrik's phone through the hub" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("switch", { name: "Let A paired device through the hub" }),
    ).not.toHaveAttribute("aria-disabled", "true");
  });
});
