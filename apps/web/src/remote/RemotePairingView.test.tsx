import { describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decodeHostHelloV1, decodeStableHostId } from "@octant/contracts/remote-access";
import type { HostHelloV1 } from "@octant/contracts/remote-access";
import type {
  RemotePairingClaim,
  RemotePairingClient,
  RemotePairingStatus,
  RemoteSessionBridge,
  RemoteSessionBridgeState,
} from "@octant/client-runtime";
import { RemotePairingView } from "./RemotePairingView";

const hostId = "11111111-1111-4111-8111-111111111111";
const ticketId = "00000000-0000-4000-8000-000000000001";
const ticketProof = "proof1234567890abcdefghijklmnopqrstuvwxyz";
const serverBaseUrl = "https://mac.example.test";

const hostHello: HostHelloV1 = decodeHostHelloV1({
  productId: "octant",
  hostId,
  displayName: "This Mac",
  hostKeyFingerprint: "a".repeat(64),
  serverBuildVersion: "0.1.0",
  supportedProtocolRange: { min: 1, max: 1 },
  authenticationProtocolVersions: [1],
  securityFloor: 1,
  remoteOrigin: serverBaseUrl,
  nonce: "nonce1234567890",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  signature: "sig",
});

const pairingClaim: RemotePairingClaim = {
  ticketId,
  hostId: decodeStableHostId(hostId),
  hostDisplayName: "This Mac",
  hostKeyFingerprint: "a".repeat(64),
  origin: serverBaseUrl,
  comparisonCode: "123456",
  deviceKeyFingerprint: "b".repeat(64),
  deviceKeyId: "key-1",
  deviceLabel: "Remote browser",
  sourceClass: "lan-private",
  claimedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
};

function createMockClient(overrides?: Partial<RemotePairingClient>): RemotePairingClient {
  return {
    requestHostHello: vi.fn(async () => hostHello),
    claimPairing: vi.fn(async () => pairingClaim),
    pollPairingStatus: vi.fn(async () => ({ kind: "pending" as const, claim: pairingClaim })),
    removeDeviceKey: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createMockSessionClient(resumeState?: RemoteSessionBridgeState): RemoteSessionBridge {
  let state: RemoteSessionBridgeState = { kind: "idle" };
  const listeners = new Set<(state: RemoteSessionBridgeState) => void>();
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect: vi.fn((approval) => {
      state = {
        kind: "ready",
        hostId: approval.hostId,
        displayName: "This Mac",
      };
      for (const listener of listeners) listener(state);
    }),
    resume: vi.fn(() => {
      state = resumeState ?? { kind: "idle" };
      for (const listener of listeners) listener(state);
    }),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
    forgetDeviceKey: vi.fn(async () => undefined),
    stageDeviceKeyRotation: vi.fn(async () => {
      throw new Error("Device key rotation is not part of this test double.");
    }),
    connection: () => undefined,
  };
}

describe("RemotePairingView", () => {
  it("attempts a stored-device resume on a fresh remote page", async () => {
    const sessionClient = createMockSessionClient();

    render(
      <RemotePairingView
        baseUrl={serverBaseUrl}
        client={createMockClient()}
        sessionClient={sessionClient}
      />,
    );

    expect(sessionClient.resume).toHaveBeenCalledWith(serverBaseUrl);
  });

  it("keeps the resume subscription alive across StrictMode effect replay", async () => {
    let resolveResume: (() => void) | undefined;
    let state: RemoteSessionBridgeState = { kind: "idle" };
    const listeners = new Set<(state: RemoteSessionBridgeState) => void>();
    const sessionClient: RemoteSessionBridge = {
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      connect: vi.fn(),
      resume: vi.fn(() => {
        void new Promise<void>((resolve) => {
          resolveResume = resolve;
        }).then(() => {
          state = { kind: "ready", hostId, displayName: "This Mac" };
          for (const listener of listeners) listener(state);
        });
      }),
      reconnect: vi.fn(),
      disconnect: vi.fn(),
      forgetDeviceKey: vi.fn(async () => undefined),
      stageDeviceKeyRotation: vi.fn(async () => {
        throw new Error("Device key rotation is not part of this test double.");
      }),
      connection: () => undefined,
    };

    render(
      <StrictMode>
        <RemotePairingView
          baseUrl={serverBaseUrl}
          client={createMockClient()}
          sessionClient={sessionClient}
        />
      </StrictMode>,
    );

    expect(sessionClient.resume).toHaveBeenCalledTimes(1);
    resolveResume?.();
    expect(
      await screen.findByRole("heading", { name: "Octant remote session" }),
    ).toBeInTheDocument();
  });

  it("retries a stored-device resume after a temporary outage", async () => {
    let resumeCount = 0;
    let state: RemoteSessionBridgeState = { kind: "idle" };
    const listeners = new Set<(state: RemoteSessionBridgeState) => void>();
    const sessionClient: RemoteSessionBridge = {
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      connect: vi.fn(),
      resume: vi.fn(() => {
        resumeCount += 1;
        state =
          resumeCount === 1
            ? { kind: "unavailable", reason: "The host is temporarily offline." }
            : { kind: "ready", hostId, displayName: "This Mac" };
        for (const listener of listeners) listener(state);
      }),
      reconnect: vi.fn(),
      disconnect: vi.fn(),
      forgetDeviceKey: vi.fn(async () => undefined),
      stageDeviceKeyRotation: vi.fn(async () => {
        throw new Error("Device key rotation is not part of this test double.");
      }),
      connection: () => undefined,
    };

    render(
      <RemotePairingView
        baseUrl={serverBaseUrl}
        client={createMockClient()}
        sessionClient={sessionClient}
      />,
    );

    expect(await screen.findByText("The host is temporarily offline.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(sessionClient.resume).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByRole("heading", { name: "Octant remote session" }),
    ).toBeInTheDocument();
  });

  it.each([
    ["expired", "Device credential expired"],
    ["revoked", "Device revoked"],
    ["lost-key", "Device key unavailable"],
    ["host-changed", "Host identity changed"],
  ] as const)("renders an explicit %s re-pair state", async (reasonCode, title) => {
    const sessionClient = createMockSessionClient({
      kind: "unauthorized",
      reason: `reason: ${reasonCode}`,
      reasonCode,
    });

    render(
      <RemotePairingView
        baseUrl={serverBaseUrl}
        client={createMockClient()}
        sessionClient={sessionClient}
      />,
    );

    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start over" })).toBeInTheDocument();
  });

  it("renders an incompatible resume as a terminal recovery state", async () => {
    const sessionClient = createMockSessionClient({
      kind: "incompatible",
      reason: "The host requires a newer protocol.",
    });

    render(
      <RemotePairingView
        baseUrl={serverBaseUrl}
        client={createMockClient()}
        sessionClient={sessionClient}
      />,
    );

    expect(await screen.findByText("Host incompatible")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start over" })).toBeInTheDocument();
  });

  it("renders a generic rejection as an explicit recovery state with a re-pair action", async () => {
    // Production revoked/expired registrations reject with a generic
    // unauthorized response (no lifecycle reason on the wire). The view must
    // surface that as an explicit recovery state, not fall back to pairing.
    const sessionClient = createMockSessionClient({
      kind: "unauthorized",
      reason: "Remote authentication was rejected.",
    });

    render(
      <RemotePairingView
        baseUrl={serverBaseUrl}
        client={createMockClient()}
        sessionClient={sessionClient}
      />,
    );

    expect(await screen.findByText("Remote access requires re-pairing")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(
      screen.getByRole("heading", { name: "Pair this browser with Octant" }),
    ).toBeInTheDocument();
  });

  it("clears the URL fragment and shows the host identity for confirmation", async () => {
    const client = createMockClient();
    const replaceFragment = vi.fn();

    window.location.hash = `#ticketId=${ticketId}&ticketProof=${ticketProof}`;

    render(
      <RemotePairingView
        baseUrl={serverBaseUrl}
        client={client}
        sessionClient={createMockSessionClient()}
        replaceFragment={replaceFragment}
      />,
    );

    await waitFor(() => {
      expect(client.requestHostHello).toHaveBeenCalledWith();
    });
    expect(replaceFragment).toHaveBeenCalledWith(
      expect.stringContaining(`#ticketId=${ticketId}&ticketProof=${ticketProof}`),
    );

    expect(await screen.findByRole("heading", { name: "Confirm this host" })).toBeInTheDocument();
    expect(screen.getByText("This Mac")).toBeInTheDocument();
  });

  it("shows the comparison code and waits for host approval", async () => {
    const user = userEvent.setup();
    const client = createMockClient();
    const sessionClient = createMockSessionClient();

    render(
      <RemotePairingView
        baseUrl={serverBaseUrl}
        client={client}
        sessionClient={sessionClient}
        ticket={{ ticketId, ticketProof }}
      />,
    );

    await screen.findByRole("heading", { name: "Confirm this host" });
    await user.click(screen.getByRole("button", { name: "Pair this browser" }));

    await waitFor(() => {
      expect(client.claimPairing).toHaveBeenCalledWith(
        expect.objectContaining({
          ticket: { ticketId, ticketProof },
          deviceLabel: "Remote browser",
          hostHello,
        }),
      );
    });

    expect(await screen.findByText("123456")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Waiting for host approval" })).toBeInTheDocument();
  });

  it("transitions to a paired, session-pending state when the host approves", async () => {
    const user = userEvent.setup();
    const approved: RemotePairingStatus = {
      kind: "approved",
      approval: {
        ticketId,
        hostId: decodeStableHostId(hostId),
        deviceId: "22222222-2222-4222-8222-222222222222",
        credentialGeneration: 1,
        deviceKeyId: "key-1",
        origin: serverBaseUrl,
      },
    };
    const client = createMockClient({
      pollPairingStatus: vi.fn(async () => approved),
    });
    const sessionClient = createMockSessionClient();

    render(
      <RemotePairingView
        baseUrl={serverBaseUrl}
        client={client}
        sessionClient={sessionClient}
        ticket={{ ticketId, ticketProof }}
      />,
    );

    await screen.findByRole("heading", { name: "Confirm this host" });
    await user.click(screen.getByRole("button", { name: "Pair this browser" }));

    expect(
      await screen.findByRole("heading", { name: "Octant remote session" }),
    ).toBeInTheDocument();
    expect(sessionClient.connect).toHaveBeenCalled();
  });

  it("transitions to a denied state when the host denies", async () => {
    const user = userEvent.setup();
    const client = createMockClient({
      pollPairingStatus: vi.fn(async () => ({
        kind: "failed" as const,
        category: "denied" as const,
        message: "The host denied this pairing request.",
      })),
    });

    render(
      <RemotePairingView
        baseUrl={serverBaseUrl}
        client={client}
        sessionClient={createMockSessionClient()}
        ticket={{ ticketId, ticketProof }}
      />,
    );

    await screen.findByRole("heading", { name: "Confirm this host" });
    await user.click(screen.getByRole("button", { name: "Pair this browser" }));

    expect(await screen.findByRole("alert", {}, { timeout: 5_000 })).toHaveTextContent(
      /Pairing denied/i,
    );
  });

  it("accepts a typed pairing link and starts the flow", async () => {
    const user = userEvent.setup();
    const client = createMockClient();

    render(
      <RemotePairingView
        baseUrl={serverBaseUrl}
        client={client}
        sessionClient={createMockSessionClient()}
      />,
    );

    const input = screen.getByLabelText("Pairing link or code");
    await user.type(
      input,
      `https://mac.example.test/#ticketId=${ticketId}&ticketProof=${ticketProof}`,
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(client.requestHostHello).toHaveBeenCalled();
    });
  });

  it("does not persist pairing ticket or device key in localStorage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    const client = createMockClient();

    render(
      <RemotePairingView
        baseUrl={serverBaseUrl}
        client={client}
        sessionClient={createMockSessionClient()}
        ticket={{ ticketId, ticketProof }}
      />,
    );

    await screen.findByRole("heading", { name: "Confirm this host" });
    await user.click(screen.getByRole("button", { name: "Pair this browser" }));
    await screen.findByText("123456");

    const sensitiveCalls = setItem.mock.calls.filter(
      ([key, value]) =>
        typeof key === "string" &&
        (key.toLowerCase().includes("ticket") ||
          key.toLowerCase().includes("proof") ||
          key.toLowerCase().includes("devicekey") ||
          (typeof value === "string" && value.includes(ticketProof))),
    );

    expect(sensitiveCalls).toHaveLength(0);
    setItem.mockRestore();
  });
});
