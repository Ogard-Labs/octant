import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  PrivateListenerPublicStatus,
  RemoteAccessAdministrationBridge,
  RemoteDeviceInventoryEntry,
  RemotePendingPairingRequest,
} from "../shell/hostBridge";
import { RemoteAccessSettingsSection } from "./RemoteAccessSettingsSection";

const ticketId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const off: PrivateListenerPublicStatus = {
  enabled: false,
  state: "disabled",
  hostname: null,
  port: null,
  origin: null,
  exposureClass: null,
  certificateFingerprint: null,
  certificateReady: false,
};
const listening: PrivateListenerPublicStatus = {
  enabled: true,
  state: "ready",
  hostname: "mac.tailnet.ts.net",
  port: 13774,
  origin: "https://mac.tailnet.ts.net:13774",
  exposureClass: "tailscale",
  certificateFingerprint: "f".repeat(64),
  certificateReady: true,
};
const pending: RemotePendingPairingRequest = {
  kind: "pending",
  ticketId,
  hostId: "33333333-3333-4333-8333-333333333333",
  deviceLabel: "Safari on iPad",
  deviceKeyFingerprint: "a".repeat(64),
  origin: "https://mac.tailnet.ts.net:13774",
  sourceClass: "tailscale",
  comparisonCode: "482913",
  claimedAt: "2026-08-01T10:00:00.000Z",
  expiresAt: "2026-08-01T10:05:00.000Z",
};
const device: RemoteDeviceInventoryEntry = {
  hostId: pending.hostId,
  deviceId,
  deviceKeyFingerprint: "b".repeat(64),
  deviceLabel: "Living room laptop",
  origin: pending.origin,
  protocolFloor: 1,
  credentialGeneration: 1,
  createdAt: "2026-08-01T10:00:00.000Z",
  expiresAt: "2026-10-30T10:00:00.000Z",
  lastSeenAt: "2026-08-01T10:00:00.000Z",
  state: "active",
};

function bridge(
  status: PrivateListenerPublicStatus,
  overrides: Partial<RemoteAccessAdministrationBridge> = {},
): RemoteAccessAdministrationBridge & { readonly calls: () => ReadonlyArray<string> } {
  const calls: string[] = [];
  const record =
    <T,>(name: string, value: T) =>
    async () => {
      calls.push(name);
      return value;
    };
  return {
    calls: () => calls,
    getPrivateListenerStatus: record("status", status),
    enablePrivateListener: vi.fn(async () => {
      calls.push("enable");
      return listening;
    }),
    restartPrivateListener: vi.fn(async () => {
      calls.push("restart");
      return listening;
    }),
    disablePrivateListener: record("disable", off),
    mintRemotePairingTicket: vi.fn(async (sourceClass) => {
      calls.push("mint");
      return {
        ticketId,
        ticketProof: "proof-".padEnd(43, "x"),
        expiresAt: Date.parse("2026-08-01T10:05:00.000Z"),
        sourceClass,
      };
    }),
    listRemotePairingRequests: record("pending", [pending]),
    approveRemotePairingRequest: vi.fn(async () => {
      calls.push("approve");
      return { decision: "approved" as const, device };
    }),
    denyRemotePairingRequest: vi.fn(async () => {
      calls.push("deny");
      return { decision: "denied" as const };
    }),
    getRemoteDeviceInventory: record("inventory", [device]),
    renameRemoteDevice: vi.fn(async (_id, deviceLabel) => {
      calls.push("rename");
      return { ...device, deviceLabel };
    }),
    revokeRemoteDevice: vi.fn(async () => {
      calls.push("revoke");
      return { commandId: ticketId, result: "applied" as const, occurredAt: pending.claimedAt };
    }),
    revokeAllRemoteDevices: vi.fn(async () => {
      calls.push("revoke-all");
      return { commandId: ticketId, result: "applied" as const, occurredAt: pending.claimedAt };
    }),
    ...overrides,
  };
}

describe("RemoteAccessSettingsSection", () => {
  it("asks for confirmation naming address, origin, and reach before enabling, and cancel changes nothing", async () => {
    const user = userEvent.setup();
    const host = bridge(off);
    render(<RemoteAccessSettingsSection bridge={host} />);

    expect(await screen.findByText("Off")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Listener hostname"), "192.168.1.20");
    await user.type(screen.getByLabelText("Certificate PEM"), "-----BEGIN CERTIFICATE-----");
    await user.type(screen.getByLabelText("Private key PEM"), "-----BEGIN PRIVATE KEY-----");
    await user.click(screen.getByRole("button", { name: "Enable listener…" }));

    const confirm = screen.getByRole("group", { name: "Confirm remote listener" });
    expect(within(confirm).getByText("192.168.1.20:13774")).toBeInTheDocument();
    expect(within(confirm).getByText("https://192.168.1.20:13774")).toBeInTheDocument();
    expect(within(confirm).getByText("Private LAN")).toBeInTheDocument();
    expect(confirm.textContent).not.toContain("PRIVATE KEY");

    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("group", { name: "Confirm remote listener" }),
    ).not.toBeInTheDocument();
    expect(host.enablePrivateListener).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Enable listener…" }));
    await user.click(screen.getByRole("button", { name: "Confirm enable" }));
    await waitFor(() => expect(host.enablePrivateListener).toHaveBeenCalledTimes(1));
    expect(host.enablePrivateListener).toHaveBeenCalledWith({
      hostname: "192.168.1.20",
      port: 13774,
      origin: "https://192.168.1.20:13774",
      certificatePem: "-----BEGIN CERTIFICATE-----",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----",
      localConfirmation: true,
    });
    expect(await screen.findByText("Listening")).toBeInTheDocument();
    expect(screen.getByLabelText("Private key PEM")).toHaveValue("");
  });

  it("refuses a loopback or public address before it reaches the host", async () => {
    const user = userEvent.setup();
    render(<RemoteAccessSettingsSection bridge={bridge(off)} />);

    await screen.findByText("Off");
    await user.type(screen.getByLabelText("Listener hostname"), "127.0.0.1");
    await user.type(screen.getByLabelText("Certificate PEM"), "c");
    await user.type(screen.getByLabelText("Private key PEM"), "k");
    expect(screen.getByRole("alert")).toHaveTextContent(/loopback address/i);
    expect(screen.getByRole("button", { name: "Enable listener…" })).toBeDisabled();

    await user.clear(screen.getByLabelText("Listener hostname"));
    await user.type(screen.getByLabelText("Listener hostname"), "example.com");
    expect(screen.getByRole("alert")).toHaveTextContent(/public addresses/i);
    expect(screen.getByRole("button", { name: "Enable listener…" })).toBeDisabled();
  });

  it("mints a pairing link on the listening origin, approves a claim, and revokes a device", async () => {
    const user = userEvent.setup();
    const host = bridge(listening);
    render(
      <RemoteAccessSettingsSection
        bridge={host}
        now={() => Date.parse("2026-08-01T10:01:00.000Z")}
      />,
    );

    expect(await screen.findByText("Listening")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create pairing link" }));
    const link = await screen.findByLabelText("Pairing link");
    expect(link).toHaveTextContent(
      `https://mac.tailnet.ts.net:13774/#ticketId=${ticketId}&ticketProof=proof-`,
    );
    expect(host.mintRemotePairingTicket).toHaveBeenCalledWith("lan-private");

    const requests = screen.getByRole("list", { name: "Pairing requests" });
    expect(within(requests).getByText("482913")).toBeInTheDocument();
    await user.click(within(requests).getByRole("button", { name: "Approve Safari on iPad" }));
    await waitFor(() => expect(host.approveRemotePairingRequest).toHaveBeenCalledWith(ticketId));
    expect(await screen.findByText("Approved Safari on iPad.")).toBeInTheDocument();

    const devices = screen.getByRole("list", { name: "Paired devices" });
    await user.click(within(devices).getByRole("button", { name: "Revoke Living room laptop" }));
    await waitFor(() => expect(host.revokeRemoteDevice).toHaveBeenCalledWith(deviceId));
    expect(host.calls().filter((call) => call === "inventory").length).toBeGreaterThanOrEqual(3);
  });

  it("does not offer pairing while the listener is off", async () => {
    render(<RemoteAccessSettingsSection bridge={bridge(off)} />);
    expect(await screen.findByText("Off")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create pairing link" })).toBeDisabled();
    expect(screen.getByText(/Enable the remote listener before pairing/i)).toBeInTheDocument();
  });
});
