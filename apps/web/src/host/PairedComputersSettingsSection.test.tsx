import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RemotePairingClient } from "@octant/client-runtime";
import {
  createClientHostRegistry,
  createInMemoryClientHostRegistryStorage,
} from "@octant/client-runtime/host-federation-registry";
import { createHostFederationLifecycle } from "@octant/client-runtime/host-federation-lifecycle";
import { createHostReadModelCache } from "@octant/client-runtime/host-federation-merged-reads";
import { createHostFederationTransports } from "@octant/client-runtime/host-federation-transports";
import { createInMemoryDeviceKeyStore } from "@octant/client-runtime/remote-pairing-client";
import { ALL_ENVIRONMENTS } from "@octant/client-runtime/environment-selection";
import { decodeHostId } from "@octant/contracts/host";
import type { PairedComputersBridge } from "../shell/hostBridge";
import { EnvironmentFilter } from "../shell/EnvironmentFilter";
import { PairedComputersSettingsSection } from "./PairedComputersSettingsSection";
import { HostFederationStackContext, type HostFederationStack } from "./useHostFederationLifecycle";

const studio = { origin: "https://100.101.102.103:8443", displayName: "Studio Mac" };
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const ticket = { ticketId: "3f6c1d2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f", ticketProof: "proof" };

function bridgeWith(overrides: Partial<PairedComputersBridge> = {}): PairedComputersBridge {
  return {
    pairWithPairingCode: vi.fn(async () => ({
      status: "verified" as const,
      computer: studio,
      ticket,
      pin: "sha256-pinned",
    })),
    listPairedComputers: vi.fn(async () => []),
    forgetPairedComputer: vi.fn(async () => ({ status: "forgotten" as const })),
    requestPairedComputer: vi.fn(async () => ({
      status: "refused" as const,
      message: "unused in this test",
    })),
    ...overrides,
  };
}

/** This window's federation stack over in-memory storage, with a bridge that is ready as soon as it is resumed. */
function federationStack(options: { onForget?: (origin: string) => Promise<void> } = {}) {
  const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
  const deviceKeyStore = createInMemoryDeviceKeyStore();
  const transports = createHostFederationTransports({
    registry,
    deviceKeyStore,
    factory: {
      createRemoteBridge: (registration) => {
        const listeners = new Set<(state: never) => void>();
        const state = {
          kind: "ready",
          hostId: registration.hostId,
          displayName: registration.displayName,
        } as const;
        return {
          getState: () => state,
          subscribe: (listener: (next: never) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          resume: vi.fn(),
          connect: vi.fn(),
          reconnect: vi.fn(),
          disconnect: vi.fn(),
          connection: () => undefined,
          forgetDeviceKey: vi.fn(),
          stageDeviceKeyRotation: vi.fn(),
        } as never;
      },
    },
  });
  const cache = createHostReadModelCache();
  const lifecycle = createHostFederationLifecycle({
    registry,
    transports,
    deviceKeyStore,
    cache,
    onHostCleared: async (_hostId, origin) => {
      if (origin !== undefined) await options.onForget?.(origin);
    },
  });
  const stack: HostFederationStack = { lifecycle, transports, registry, deviceKeyStore };
  return { stack, cache };
}

/** The pairing client of a host that approves as soon as it is asked. */
function approvingClient(
  deviceKeyStore: HostFederationStack["deviceKeyStore"],
): RemotePairingClient {
  const claim = {
    ticketId: ticket.ticketId,
    hostId: HOST_ID,
    hostDisplayName: studio.displayName,
    hostKeyFingerprint: "a".repeat(64),
    origin: studio.origin,
    comparisonCode: "123-456",
    deviceKeyFingerprint: "b".repeat(64),
    deviceKeyId: "key-1",
    deviceLabel: "Octant desktop",
    sourceClass: "tailscale",
    claimedAt: "2026-10-17T10:00:00.000Z",
    expiresAt: "2026-10-17T10:05:00.000Z",
  } as never;
  return {
    requestHostHello: async () =>
      ({
        displayName: studio.displayName,
        hostId: HOST_ID,
        hostKeyFingerprint: "a".repeat(64),
        remoteOrigin: studio.origin,
      }) as never,
    claimPairing: async () => claim,
    pollPairingStatus: async () => {
      void deviceKeyStore;
      return {
        kind: "approved" as const,
        approval: {
          ticketId: ticket.ticketId,
          hostId: HOST_ID,
          deviceId: "device-1",
          credentialGeneration: 1,
          deviceKeyId: "key-1",
          origin: studio.origin,
          hostKeyFingerprint: "a".repeat(64),
          listenerTrust: { current: { kind: "pinned" as const, pin: "sha256-pinned" } },
        },
      } as never;
    },
    removeDeviceKey: vi.fn(async () => {}),
  };
}

function renderSection(
  bridge: PairedComputersBridge,
  stack: HostFederationStack | undefined,
  pairingClient?: RemotePairingClient,
) {
  return render(
    <HostFederationStackContext.Provider value={stack}>
      <PairedComputersSettingsSection
        bridge={bridge}
        {...(pairingClient === undefined ? {} : { pairingClient })}
      />
    </HostFederationStackContext.Provider>,
  );
}

describe("pairing this desktop app with another computer", () => {
  it("claims the ticket main handed back, and the computer joins the Environments filter once approved", async () => {
    const { stack } = federationStack();
    await stack.lifecycle.sync();
    const listPairedComputers = vi
      .fn<PairedComputersBridge["listPairedComputers"]>()
      .mockResolvedValueOnce([])
      .mockResolvedValue([studio]);
    const bridge = bridgeWith({ listPairedComputers });
    renderSection(bridge, stack, approvingClient(stack.deviceKeyStore));

    await userEvent.type(screen.getByLabelText("Pairing code"), "octant-pair-1.abc");
    await userEvent.click(screen.getByRole("button", { name: "Pair" }));
    expect(bridge.pairWithPairingCode).toHaveBeenCalledWith("octant-pair-1.abc");

    await userEvent.click(await screen.findByRole("button", { name: "Ask Studio Mac to approve" }));
    expect(await screen.findByText("Paired Studio Mac.")).toBeTruthy();

    const registered = await stack.registry.get(HOST_ID);
    expect(registered).toMatchObject({
      kind: "remote",
      displayName: "Studio Mac",
      origin: studio.origin,
      credential: { listenerTrust: { current: { kind: "pinned", pin: "sha256-pinned" } } },
    });
    expect(stack.lifecycle.toHostIdentities().map((host) => host.displayName)).toContain(
      "Studio Mac",
    );
    const environments = render(
      <EnvironmentFilter
        hostStates={stack.lifecycle.toFederatedHostStates()}
        onSelectionChange={vi.fn()}
        selection={ALL_ENVIRONMENTS}
      />,
    );
    await userEvent.click(within(environments.container).getByRole("button"));
    expect(await screen.findByRole("menuitemcheckbox", { name: /Studio Mac/ })).toBeTruthy();
    expect(bridge.forgetPairedComputer).not.toHaveBeenCalled();
  });

  it("shows the comparison code while the other computer decides", async () => {
    const { stack } = federationStack();
    await stack.lifecycle.sync();
    const client = approvingClient(stack.deviceKeyStore);
    renderSection(bridgeWith(), stack, {
      ...client,
      pollPairingStatus: async (input) => ({ kind: "pending", claim: input.claim }),
    });

    await userEvent.type(screen.getByLabelText("Pairing code"), "octant-pair-1.abc");
    await userEvent.click(screen.getByRole("button", { name: "Pair" }));
    await userEvent.click(await screen.findByRole("button", { name: "Ask Studio Mac to approve" }));

    expect(await screen.findByText("123-456")).toBeTruthy();
    expect(
      screen.getByText(/Approve there only if it shows the same comparison code/),
    ).toBeTruthy();
  });

  it("forgets the pin and the pairing when the person cancels before the other computer approves", async () => {
    const { stack } = federationStack();
    await stack.lifecycle.sync();
    const client = approvingClient(stack.deviceKeyStore);
    const bridge = bridgeWith();
    renderSection(bridge, stack, {
      ...client,
      pollPairingStatus: async (input) => ({ kind: "pending", claim: input.claim }),
    });

    await userEvent.type(screen.getByLabelText("Pairing code"), "octant-pair-1.abc");
    await userEvent.click(screen.getByRole("button", { name: "Pair" }));
    await userEvent.click(await screen.findByRole("button", { name: "Ask Studio Mac to approve" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(bridge.forgetPairedComputer).toHaveBeenCalledWith(studio.origin));
    expect(await stack.registry.get(HOST_ID)).toBeUndefined();
  });

  it("shows the refusal the desktop app gives and keeps the code for a second look", async () => {
    const message =
      "This isn't the computer you paired with: its security key has changed. Octant stopped before sending anything. If its key was replaced on purpose, pair again from that computer.";
    const { stack } = federationStack();
    await stack.lifecycle.sync();
    const bridge = bridgeWith({
      pairWithPairingCode: vi.fn(async () => ({ status: "refused" as const, message })),
    });
    renderSection(bridge, stack);

    await userEvent.type(screen.getByLabelText("Pairing code"), "octant-pair-1.abc");
    await userEvent.click(screen.getByRole("button", { name: "Pair" }));

    expect(await screen.findByText(message)).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByLabelText("Pairing code") as HTMLTextAreaElement).value).toBe(
        "octant-pair-1.abc",
      ),
    );
  });
});

describe("forgetting a paired computer", () => {
  async function pairedStack(onForget?: (origin: string) => Promise<void>) {
    const built = federationStack(onForget === undefined ? {} : { onForget });
    await built.stack.registry.upsertRemote({
      hostId: decodeHostId(HOST_ID),
      kind: "remote",
      displayName: studio.displayName,
      origin: studio.origin,
      enabled: true,
      credential: {
        keyId: "key-1",
        credentialGeneration: 1,
        hostKeyFingerprint: "a".repeat(64),
        deviceId: "device-1",
      },
    });
    await built.stack.lifecycle.sync();
    return built.stack;
  }

  it("asks first, and forgets nothing when the person keeps it", async () => {
    const stack = await pairedStack();
    const bridge = bridgeWith({ listPairedComputers: vi.fn(async () => [studio]) });
    renderSection(bridge, stack);

    await userEvent.click(await screen.findByRole("button", { name: "Forget Studio Mac" }));
    expect(screen.getByRole("dialog", { name: "Forget Studio Mac?" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Keep it" }));

    expect(bridge.forgetPairedComputer).not.toHaveBeenCalled();
    expect(await stack.registry.get(HOST_ID)).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("removes the computer from this window and from the desktop on confirm", async () => {
    const forgotten = new Set<string>();
    const stack = await pairedStack(async (origin) => void forgotten.add(origin));
    const listPairedComputers = vi
      .fn<PairedComputersBridge["listPairedComputers"]>()
      .mockResolvedValueOnce([studio])
      .mockResolvedValue([]);
    const bridge = bridgeWith({ listPairedComputers });
    renderSection(bridge, stack);

    await userEvent.click(await screen.findByRole("button", { name: "Forget Studio Mac" }));
    await userEvent.click(screen.getByRole("button", { name: "Forget computer" }));

    expect(await screen.findByText("Forgot Studio Mac.")).toBeTruthy();
    expect(await stack.registry.get(HOST_ID)).toBeUndefined();
    expect(stack.lifecycle.toHostIdentities().map((host) => host.displayName)).not.toContain(
      "Studio Mac",
    );
    expect(forgotten).toEqual(new Set([studio.origin]));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Forget Studio Mac" })).toBeNull(),
    );
  });

  it("forgets a computer that has a pin here but no record in this window", async () => {
    const { stack } = federationStack();
    await stack.lifecycle.sync();
    const listPairedComputers = vi
      .fn<PairedComputersBridge["listPairedComputers"]>()
      .mockResolvedValueOnce([studio])
      .mockResolvedValueOnce([studio])
      .mockResolvedValue([]);
    const bridge = bridgeWith({ listPairedComputers });
    renderSection(bridge, stack);
    expect(await screen.findByText(/Not connected in this window/)).toBeTruthy();

    await userEvent.click(await screen.findByRole("button", { name: "Forget Studio Mac" }));
    await userEvent.click(screen.getByRole("button", { name: "Forget computer" }));

    expect(bridge.forgetPairedComputer).toHaveBeenCalledWith(studio.origin);
    expect(await screen.findByText("Forgot Studio Mac.")).toBeTruthy();
  });

  it("shows the refusal the desktop app gives", async () => {
    const { stack } = federationStack();
    await stack.lifecycle.sync();
    const bridge = bridgeWith({
      listPairedComputers: vi.fn(async () => [studio]),
      forgetPairedComputer: vi.fn(async () => ({ status: "refused" as const, message: "Nope." })),
    });
    renderSection(bridge, stack);

    await userEvent.click(await screen.findByRole("button", { name: "Forget Studio Mac" }));
    await userEvent.click(screen.getByRole("button", { name: "Forget computer" }));

    expect(await screen.findByText("Nope.")).toBeTruthy();
  });
});
