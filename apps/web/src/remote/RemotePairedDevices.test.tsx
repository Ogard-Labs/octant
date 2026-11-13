import type { PairedDeviceAdministrationClient } from "@octant/client-runtime/paired-device-administration-client";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RemotePairedDevices } from "./RemotePairedDevices";

const device = {
  hostId: "host",
  deviceId: "22222222-2222-4222-8222-222222222222",
  deviceKeyFingerprint: "ab:cd",
  deviceLabel: "Phone",
  origin: "https://host.example:13774",
  protocolFloor: 1,
  credentialGeneration: 1,
  createdAt: "2026-11-12T10:00:00.000Z",
  expiresAt: "2027-11-12T10:00:00.000Z",
  lastSeenAt: "2026-11-12T10:00:00.000Z",
  state: "active" as const,
};
const request = {
  kind: "pending" as const,
  ticketId: "33333333-3333-4333-8333-333333333333",
  hostId: "host",
  deviceLabel: "Tablet",
  deviceKeyFingerprint: "ef:01",
  origin: "https://host.example:13774",
  sourceClass: "lan-private" as const,
  comparisonCode: "123-456",
  claimedAt: "2026-11-12T10:00:00.000Z",
  expiresAt: "2026-11-12T10:05:00.000Z",
};

function client(overrides: Partial<PairedDeviceAdministrationClient> = {}) {
  const ok = async () => ({ status: "ok" as const });
  return {
    listDevices: vi.fn(async () => ({ status: "ok" as const, value: [device] })),
    listPairingRequests: vi.fn(async () => ({ status: "ok" as const, value: [request] })),
    renameDevice: vi.fn(ok),
    revokeDevice: vi.fn(ok),
    revokeAllDevices: vi.fn(ok),
    reconcileExpiredDevices: vi.fn(ok),
    approvePairingRequest: vi.fn(ok),
    denyPairingRequest: vi.fn(ok),
    createPairingTicket: vi.fn(async () => ({
      status: "ok" as const,
      value: {
        ticketId: request.ticketId,
        ticketProof: "proof",
        expiresAt: 1,
        sourceClass: "lan-private" as const,
      },
    })),
    ...overrides,
  } satisfies PairedDeviceAdministrationClient;
}

describe("paired devices in a browser the host's own person paired", () => {
  it("lists the devices, renames and revokes one, and revokes all only after a second press", async () => {
    const user = userEvent.setup();
    const host = client();
    render(<RemotePairedDevices client={host} origin="https://host.example:13774" />);

    const row = (await screen.findByText("Phone")).closest("li");
    if (row === null) throw new Error("Missing device row");
    await user.click(within(row).getByRole("button", { name: "Rename" }));
    const label = within(row).getByRole("textbox", { name: "Name for Phone" });
    await user.clear(label);
    await user.type(label, "Work phone");
    await user.click(within(row).getByRole("button", { name: "Save" }));
    expect(host.renameDevice).toHaveBeenCalledWith(device.deviceId, "Work phone");

    await user.click(within(row).getByRole("button", { name: "Revoke" }));
    expect(host.revokeDevice).toHaveBeenCalledWith(device.deviceId);

    await user.click(screen.getByRole("button", { name: "Revoke all devices" }));
    expect(host.revokeAllDevices).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Revoke all, this browser included" }));
    expect(host.revokeAllDevices).toHaveBeenCalledTimes(1);
  });

  it("shows a new device's request with its comparison code, and the host's refusal of an approval plainly", async () => {
    const user = userEvent.setup();
    const refusal =
      "The host did not take this approval. A device cannot approve its own pairing request; approve it from another paired device or at the host.";
    const host = client({
      approvePairingRequest: vi.fn(async () => ({ status: "refused" as const, message: refusal })),
    });
    render(<RemotePairedDevices client={host} origin="https://host.example:13774" />);

    expect(await screen.findByText("Tablet")).toBeInTheDocument();
    expect(screen.getByText("123-456")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve Tablet" }));
    expect(await screen.findByText(refusal)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Deny Tablet" }));
    expect(host.denyPairingRequest).toHaveBeenCalledWith(request.ticketId);
  });

  it("starts a pairing and shows the link the new device opens", async () => {
    const user = userEvent.setup();
    const host = client();
    render(<RemotePairedDevices client={host} origin="https://host.example:13774" />);

    await user.click(await screen.findByRole("button", { name: "Pair another device" }));
    expect(host.createPairingTicket).toHaveBeenCalledWith("lan-private");
    expect(await screen.findByRole("textbox", { name: "Pairing link" })).toHaveValue(
      `https://host.example:13774/#ticketId=${request.ticketId}&ticketProof=proof`,
    );
  });

  it("shows a pairing request that arrives while the panel is open, on Refresh or by itself, and stops reading once closed", async () => {
    vi.useFakeTimers();
    try {
      let arrived = false;
      const listPairingRequests = vi.fn(async () => ({
        status: "ok" as const,
        value: arrived ? [request] : [],
      }));
      const host = client({ listPairingRequests });
      const { unmount } = render(
        <RemotePairedDevices client={host} origin="https://host.example:13774" />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.queryByText("Tablet")).toBeNull();

      // The new device claims its ticket after the panel's first read.
      arrived = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(screen.getByText("Tablet")).toBeInTheDocument();

      const reads = listPairingRequests.mock.calls.length;
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(listPairingRequests.mock.calls.length).toBe(reads + 1);

      unmount();
      const readsWhenClosed = listPairingRequests.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(listPairingRequests.mock.calls.length).toBe(readsWhenClosed);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says so when the host refuses a restricted session the list", async () => {
    const refused = async () => ({
      status: "refused" as const,
      message: "Local device administration is unauthorized.",
    });
    render(
      <RemotePairedDevices
        client={client({ listDevices: vi.fn(refused), listPairingRequests: vi.fn(refused) })}
        origin="https://host.example:13774"
      />,
    );

    expect(
      await screen.findByText("Local device administration is unauthorized."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });
});
