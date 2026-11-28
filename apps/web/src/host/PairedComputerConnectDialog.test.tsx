import { createHostFederationLifecycle } from "@octant/client-runtime/host-federation-lifecycle";
import { createHostReadModelCache } from "@octant/client-runtime/host-federation-merged-reads";
import {
  createClientHostRegistry,
  createInMemoryClientHostRegistryStorage,
} from "@octant/client-runtime/host-federation-registry";
import { createHostFederationTransports } from "@octant/client-runtime/host-federation-transports";
import {
  createInMemoryDeviceKeyStore,
  type RemotePairingClient,
} from "@octant/client-runtime/remote-pairing-client";
import { decodeHostId } from "@octant/contracts/host";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PairedComputersBridge } from "../shell/hostBridge";
import { PairedComputerConnectDialog } from "./PairedComputerConnectDialog";
import type { HostFederationStack } from "./useHostFederationLifecycle";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://100.101.102.105:8443";
const PIN = "sha256-studio-pin";
const TICKET = { ticketId: "3f6c1d2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f", ticketProof: "proof" };

async function introducedStack() {
  const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
  const deviceKeyStore = createInMemoryDeviceKeyStore();
  const createdBridges: Array<{
    readonly keyId: string | undefined;
    readonly disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  const transports = createHostFederationTransports({
    registry,
    deviceKeyStore,
    factory: {
      createRemoteBridge: (registration) => {
        const disconnect = vi.fn();
        createdBridges.push({ keyId: registration.credential?.keyId, disconnect });
        return {
          getState: () => ({
            kind: "ready" as const,
            hostId: registration.hostId,
            displayName: registration.displayName,
          }),
          subscribe: () => () => {},
          resume: vi.fn(),
          connect: vi.fn(),
          reconnect: vi.fn(),
          disconnect,
          connection: () => undefined,
          forgetDeviceKey: vi.fn(),
          stageDeviceKeyRotation: vi.fn(),
        } as never;
      },
    },
  });
  const cache = createHostReadModelCache();
  const lifecycle = createHostFederationLifecycle({ registry, transports, deviceKeyStore, cache });
  await registry.upsertRemote({
    hostId: decodeHostId(HOST_ID),
    kind: "remote",
    displayName: "Studio",
    origin: ORIGIN,
    enabled: true,
    through: "hub",
    credential: {
      keyId: "hub-key-1",
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
      deviceId: "hub-device-1",
      listenerTrust: { current: { kind: "pinned", pin: PIN } },
    },
  });
  await lifecycle.sync();
  const stack: HostFederationStack = { lifecycle, transports, registry, deviceKeyStore, cache };
  return { stack, createdBridges };
}

function desktopBridge(overrides: Partial<PairedComputersBridge> = {}): PairedComputersBridge {
  return {
    pairWithPairingCode: vi.fn(async () => ({
      status: "verified" as const,
      computer: { origin: ORIGIN, displayName: "Studio" },
      ticket: TICKET,
      pin: PIN,
    })),
    listPairedComputers: vi.fn(async () => []),
    forgetPairedComputer: vi.fn(async () => ({ status: "forgotten" as const })),
    settlePairedComputer: vi.fn(async () => ({ status: "settled" as const })),
    requestPairedComputer: vi.fn(async () => ({
      status: "refused" as const,
      message: "unused",
    })),
    ...overrides,
  };
}

function pairingClient(outcome: "approved" | "denied"): RemotePairingClient {
  return {
    requestHostHello: async () =>
      ({
        displayName: "Studio",
        hostId: HOST_ID,
        hostKeyFingerprint: "a".repeat(64),
        remoteOrigin: ORIGIN,
      }) as never,
    claimPairing: async () =>
      ({
        ticketId: TICKET.ticketId,
        hostId: HOST_ID,
        hostDisplayName: "Studio",
        hostKeyFingerprint: "a".repeat(64),
        origin: ORIGIN,
        comparisonCode: "482-913",
        deviceKeyFingerprint: "b".repeat(64),
        deviceKeyId: "direct-key-2",
        deviceLabel: "Octant desktop",
        sourceClass: "tailscale",
        claimedAt: "2026-11-28T10:00:00.000Z",
        expiresAt: "2026-11-28T10:05:00.000Z",
      }) as never,
    pollPairingStatus: async () =>
      outcome === "approved"
        ? ({
            kind: "approved",
            approval: {
              ticketId: TICKET.ticketId,
              hostId: HOST_ID,
              deviceId: "direct-device-2",
              credentialGeneration: 1,
              deviceKeyId: "direct-key-2",
              origin: ORIGIN,
              hostKeyFingerprint: "a".repeat(64),
              listenerTrust: { current: { kind: "pinned", pin: PIN } },
            },
          } as never)
        : ({
            kind: "failed",
            category: "denied",
            retryable: false,
            message: "Studio denied the pairing request.",
          } as never),
    removeDeviceKey: vi.fn(async () => {}),
  };
}

describe("Connect to reply pairing handoff", () => {
  it("replaces the hub-introduced record with a direct pairing and reopens the session on approval", async () => {
    const user = userEvent.setup();
    const { stack, createdBridges } = await introducedStack();
    const bridge = desktopBridge();
    const onConnected = vi.fn();

    render(
      <PairedComputerConnectDialog
        bridge={bridge}
        expectedPin={PIN}
        federation={stack}
        hostName="Studio"
        onClose={vi.fn()}
        onConnected={onConnected}
        open
        origin={ORIGIN}
        pairingClient={pairingClient("approved")}
      />,
    );

    expect(screen.getByText(ORIGIN)).toBeVisible();
    expect(screen.getByText(PIN)).toBeVisible();

    await user.type(screen.getByLabelText("Pairing code"), "octant-pair-1.valid");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await user.click(await screen.findByRole("button", { name: "Ask Studio to approve" }));

    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
    const updated = await stack.registry.get(HOST_ID);
    expect(updated?.through).toBeUndefined();
    expect(updated?.credential?.keyId).toBe("direct-key-2");
    expect(updated?.credential?.deviceId).toBe("direct-device-2");
    expect(createdBridges[0]?.disconnect).toHaveBeenCalledOnce();
    expect(createdBridges.map((entry) => entry.keyId)).toEqual(["hub-key-1", "direct-key-2"]);
  });

  it("stays Watching and keeps the introduced record when pairing is denied", async () => {
    const user = userEvent.setup();
    const { stack } = await introducedStack();
    const bridge = desktopBridge();
    const onConnected = vi.fn();
    const onClose = vi.fn();

    render(
      <PairedComputerConnectDialog
        bridge={bridge}
        expectedPin={PIN}
        federation={stack}
        hostName="Studio"
        onClose={onClose}
        onConnected={onConnected}
        open
        origin={ORIGIN}
        pairingClient={pairingClient("denied")}
      />,
    );

    await user.type(screen.getByLabelText("Pairing code"), "octant-pair-1.valid");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await user.click(await screen.findByRole("button", { name: "Ask Studio to approve" }));

    expect(await screen.findByText("Studio denied the pairing request.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onConnected).not.toHaveBeenCalled();
    const untouched = await stack.registry.get(HOST_ID);
    expect(untouched?.through).toBe("hub");
    expect(untouched?.credential?.keyId).toBe("hub-key-1");
  });

  it("refuses a pairing code whose origin or pin does not match and stays Watching", async () => {
    const user = userEvent.setup();
    const { stack } = await introducedStack();
    const bridge = desktopBridge({
      pairWithPairingCode: vi.fn(async () => ({
        status: "verified" as const,
        computer: { origin: "https://100.101.102.200:8443", displayName: "Other Mac" },
        ticket: TICKET,
        pin: "sha256-other-pin",
      })),
    });

    render(
      <PairedComputerConnectDialog
        bridge={bridge}
        expectedPin={PIN}
        federation={stack}
        hostName="Studio"
        onClose={vi.fn()}
        onConnected={vi.fn()}
        open
        origin={ORIGIN}
      />,
    );

    await user.type(screen.getByLabelText("Pairing code"), "octant-pair-1.other");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(
      await screen.findByText(/does not match Studio's address or certificate pin/i),
    ).toBeVisible();
    expect(bridge.settlePairedComputer).toHaveBeenCalledWith(
      "https://100.101.102.200:8443",
      "abandoned",
    );
    expect((await stack.registry.get(HOST_ID))?.through).toBe("hub");
  });
});
