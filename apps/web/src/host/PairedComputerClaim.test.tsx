import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import type { RemotePairingClient } from "@octant/client-runtime";
import {
  createClientHostRegistry,
  createInMemoryClientHostRegistryStorage,
} from "@octant/client-runtime/host-federation-registry";
import { createHostFederationLifecycle } from "@octant/client-runtime/host-federation-lifecycle";
import { createHostFederationTransports } from "@octant/client-runtime/host-federation-transports";
import { createInMemoryDeviceKeyStore } from "@octant/client-runtime/remote-pairing-client";
import { PairedComputerClaim } from "./PairedComputerClaim";
import type { HostFederationStack } from "./useHostFederationLifecycle";

const pairing = {
  computer: { origin: "https://100.101.102.103:8443", displayName: "Studio Mac" },
  ticket: { ticketId: "3f6c1d2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f", ticketProof: "proof" },
  pin: "sha256-pinned",
};
const HOST_ID = "11111111-1111-4111-8111-111111111111";

function stack(): HostFederationStack {
  const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
  const deviceKeyStore = createInMemoryDeviceKeyStore();
  const transports = createHostFederationTransports({
    registry,
    deviceKeyStore,
    factory: {
      createRemoteBridge: (registration) =>
        ({
          getState: () => ({
            kind: "ready",
            hostId: registration.hostId,
            displayName: registration.displayName,
          }),
          subscribe: () => () => {},
          resume: vi.fn(),
          disconnect: vi.fn(),
          connection: () => undefined,
        }) as never,
    },
  });
  return {
    lifecycle: createHostFederationLifecycle({ registry, transports, deviceKeyStore }),
    transports,
    registry,
    deviceKeyStore,
  };
}

function client(approves: boolean): RemotePairingClient {
  return {
    requestHostHello: async () =>
      ({
        displayName: "Studio Mac",
        hostId: HOST_ID,
        hostKeyFingerprint: "a".repeat(64),
        remoteOrigin: pairing.computer.origin,
      }) as never,
    claimPairing: async () =>
      ({
        ticketId: pairing.ticket.ticketId,
        hostId: HOST_ID,
        hostDisplayName: "Studio Mac",
        hostKeyFingerprint: "a".repeat(64),
        origin: pairing.computer.origin,
        comparisonCode: "123-456",
        deviceKeyFingerprint: "b".repeat(64),
        deviceKeyId: "key-1",
        deviceLabel: "Octant desktop",
        sourceClass: "tailscale",
        claimedAt: "2026-10-17T10:00:00.000Z",
        expiresAt: "2026-10-17T10:05:00.000Z",
      }) as never,
    pollPairingStatus: async (input) =>
      approves
        ? ({
            kind: "approved",
            approval: {
              ticketId: pairing.ticket.ticketId,
              hostId: HOST_ID,
              deviceId: "device-1",
              credentialGeneration: 1,
              deviceKeyId: "key-1",
              origin: pairing.computer.origin,
              hostKeyFingerprint: "a".repeat(64),
              listenerTrust: { current: { kind: "pinned", pin: pairing.pin } },
            },
          } as never)
        : { kind: "pending", claim: input.claim },
    removeDeviceKey: async () => {},
  };
}

function bridge() {
  return {
    requestPairedComputer: vi.fn(),
    settlePairedComputer: vi.fn(async () => ({ status: "settled" as const })),
  };
}

async function reachWaiting() {
  await userEvent.click(await screen.findByRole("button", { name: "Ask Studio Mac to approve" }));
  await screen.findByText("123-456");
}

describe("leaving a pairing that main already recorded a pin for", () => {
  it("abandons the pairing when the window unmounts before the other computer approves", async () => {
    const desktop = bridge();
    const view = render(
      <PairedComputerClaim
        bridge={desktop}
        client={client(false)}
        federation={stack()}
        onFinished={vi.fn()}
        pairing={pairing}
      />,
    );
    await reachWaiting();

    view.unmount();

    await waitFor(() =>
      expect(desktop.settlePairedComputer).toHaveBeenCalledWith(
        pairing.computer.origin,
        "abandoned",
      ),
    );
    expect(desktop.settlePairedComputer).toHaveBeenCalledOnce();
  });

  it("tells the desktop to keep the pin once the other computer approved", async () => {
    const desktop = bridge();
    const onFinished = vi.fn();
    render(
      <PairedComputerClaim
        bridge={desktop}
        client={client(true)}
        federation={stack()}
        onFinished={onFinished}
        pairing={pairing}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Ask Studio Mac to approve" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledWith("paired"));

    expect(desktop.settlePairedComputer).toHaveBeenCalledWith(pairing.computer.origin, "approved");
    expect(desktop.settlePairedComputer).toHaveBeenCalledOnce();
  });

  it("says so, and does not connect, when the desktop no longer has the pairing open", async () => {
    const desktop = bridge();
    desktop.settlePairedComputer.mockResolvedValue({
      status: "refused" as never,
      message: "That pairing is no longer open.",
    } as never);
    const onFinished = vi.fn();
    render(
      <PairedComputerClaim
        bridge={desktop}
        client={client(true)}
        federation={stack()}
        onFinished={onFinished}
        pairing={pairing}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Ask Studio Mac to approve" }));

    expect(await screen.findByText(/couldn't finish saving it/)).toBeTruthy();
    expect(onFinished).not.toHaveBeenCalled();
  });

  it("keeps the pin when the window unmounts after the computer was paired", async () => {
    const desktop = bridge();
    const onFinished = vi.fn();
    const view = render(
      <PairedComputerClaim
        bridge={desktop}
        client={client(true)}
        federation={stack()}
        onFinished={onFinished}
        pairing={pairing}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Ask Studio Mac to approve" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledWith("paired"));

    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(desktop.settlePairedComputer).not.toHaveBeenCalledWith(
      pairing.computer.origin,
      "abandoned",
    );
  });

  it("keeps the pin when it is unmounted once approved but before the host is saved", async () => {
    const desktop = bridge();
    const built = stack();
    const never: HostFederationStack = {
      ...built,
      lifecycle: { ...built.lifecycle, sync: () => new Promise(() => {}) },
    };
    const view = render(
      <PairedComputerClaim
        bridge={desktop}
        client={client(true)}
        federation={never}
        onFinished={vi.fn()}
        pairing={pairing}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Ask Studio Mac to approve" }));
    await screen.findByText(/Contacting Studio Mac/);
    await new Promise((resolve) => setTimeout(resolve, 20));

    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(desktop.settlePairedComputer).not.toHaveBeenCalledWith(
      pairing.computer.origin,
      "abandoned",
    );
  });

  it("does not abandon a pairing that a development double mount remounted", async () => {
    const desktop = bridge();
    const view = render(
      <StrictMode>
        <PairedComputerClaim
          bridge={desktop}
          client={client(false)}
          federation={stack()}
          onFinished={vi.fn()}
          pairing={pairing}
        />
      </StrictMode>,
    );
    await reachWaiting();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(desktop.settlePairedComputer).not.toHaveBeenCalledWith(
      pairing.computer.origin,
      "abandoned",
    );
    view.unmount();
    await waitFor(() => expect(desktop.settlePairedComputer).toHaveBeenCalledOnce());
  });
});
