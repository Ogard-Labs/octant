// Temporary rendered-QA scenes for the device access level controls. Not committed.
import type { PairedDeviceAdministrationClient } from "@octant/client-runtime/paired-device-administration-client";
import type { RemoteSessionBridge } from "@octant/client-runtime";
import type { ReactNode } from "react";
import { RemoteAccessSettingsSection } from "../host/RemoteAccessSettingsSection";
import { RemoteDeviceSelfPanel } from "../remote/RemoteDeviceSelfPanel";
import { RemotePairedDevices } from "../remote/RemotePairedDevices";
import type {
  PrivateListenerPublicStatus,
  RemoteAccessAdministrationBridge,
  RemoteDeviceInventoryEntry,
  RemotePendingPairingRequest,
} from "../shell/hostBridge";

const listening: PrivateListenerPublicStatus = {
  enabled: true,
  state: "ready",
  hostname: "mac.tailnet.ts.net",
  port: 13774,
  origin: "https://mac.tailnet.ts.net:13774",
  exposureClass: "tailscale",
  certificateFingerprint: "f".repeat(64),
  certificateReady: true,
  certificateSource: "pasted",
  tlsPin: null,
};
const pending: RemotePendingPairingRequest = {
  kind: "pending",
  ticketId: "11111111-1111-4111-8111-111111111111",
  hostId: "33333333-3333-4333-8333-333333333333",
  deviceLabel: "Safari on iPad",
  deviceKeyFingerprint: "a".repeat(64),
  origin: "https://mac.tailnet.ts.net:13774",
  sourceClass: "tailscale",
  comparisonCode: "482913",
  claimedAt: "2026-08-18T08:58:00.000Z",
  expiresAt: "2026-08-18T09:03:00.000Z",
};
const devices: ReadonlyArray<RemoteDeviceInventoryEntry> = [
  {
    hostId: pending.hostId,
    deviceId: "22222222-2222-4222-8222-222222222222",
    deviceKeyFingerprint: "b".repeat(64),
    deviceLabel: "Living room laptop",
    origin: pending.origin,
    protocolFloor: 1,
    credentialGeneration: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    expiresAt: "2026-10-30T10:00:00.000Z",
    lastSeenAt: "2026-08-18T08:00:00.000Z",
    state: "active",
    accessLevel: "approve-and-steer",
  },
  {
    hostId: pending.hostId,
    deviceId: "44444444-4444-4444-8444-444444444444",
    deviceKeyFingerprint: "c".repeat(64),
    deviceLabel: "Ada's phone",
    origin: pending.origin,
    protocolFloor: 1,
    credentialGeneration: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    expiresAt: "2026-10-30T10:00:00.000Z",
    lastSeenAt: "2026-08-18T07:00:00.000Z",
    state: "active",
    accessLevel: "full",
  },
];
const receipt = {
  commandId: pending.ticketId,
  result: "applied" as const,
  occurredAt: pending.claimedAt,
};

function bridge(paused: boolean): RemoteAccessAdministrationBridge {
  return {
    getPrivateListenerStatus: async () => listening,
    enablePrivateListener: async () => listening,
    restartPrivateListener: async () => listening,
    disablePrivateListener: async () => listening,
    mintRemotePairingTicket: async (sourceClass) => ({
      ticketId: pending.ticketId,
      ticketProof: "proof",
      expiresAt: 0,
      sourceClass,
    }),
    listRemotePairingRequests: async () => [pending],
    approveRemotePairingRequest: async () => ({ decision: "approved", device: devices[0]! }),
    denyRemotePairingRequest: async () => ({ decision: "denied" }),
    getRemoteDeviceInventory: async () => devices,
    renameRemoteDevice: async () => devices[0]!,
    revokeRemoteDevice: async () => receipt,
    revokeAllRemoteDevices: async () => receipt,
    setRemoteDeviceAccessLevel: async () => undefined,
    getRemoteAccessPaused: async () => paused,
    setRemoteAccessPaused: async (next) => next,
  };
}

const ok = async () => ({ status: "ok" as const });
const pairedClient: PairedDeviceAdministrationClient = {
  listDevices: async () => ({ status: "ok", value: devices }),
  listPairingRequests: async () => ({ status: "ok", value: [pending] }),
  renameDevice: ok,
  revokeDevice: ok,
  revokeAllDevices: ok,
  signOutOtherDevices: ok,
  setDeviceAccessLevel: ok,
  pauseRemoteAccess: ok,
  reconcileExpiredDevices: ok,
  approvePairingRequest: ok,
  denyPairingRequest: ok,
  createPairingTicket: async () => ({
    status: "ok",
    value: { ticketId: pending.ticketId, ticketProof: "p", expiresAt: 0, sourceClass: "tailscale" },
  }),
};

function sessionBridge(accessLevel: "full" | "read-only"): RemoteSessionBridge {
  const state = { kind: "ready", hostId: pending.hostId, displayName: "Mac" };
  const metadata = {
    deviceId: "22222222-2222-4222-8222-222222222222",
    deviceLabel: "This browser",
    origin: pending.origin,
    credentialGeneration: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    expiresAt: "2026-10-30T10:00:00.000Z",
    lastSeenAt: "2026-08-18T08:00:00.000Z",
    state: "active",
    sessionIdleExpiresAt: "2026-08-18T09:15:00.000Z",
    actsAsHostPerson: accessLevel === "full",
    accessLevel,
  };
  return {
    getState: () => state,
    subscribe: () => () => undefined,
    connection: () => ({
      session: () => ({ sessionId: "s" }),
      authenticatedFetch: async () => Response.json(metadata),
    }),
  } as never;
}

export const ACCESS_LEVEL_RENDERERS: ReadonlyArray<{
  readonly id: string;
  readonly render: () => ReactNode;
}> = [
  {
    id: "qa-remote-access",
    render: () => (
      <div className="visual-check__pane visual-check__pane--padded">
        <RemoteAccessSettingsSection bridge={bridge(false)} />
      </div>
    ),
  },
  {
    id: "qa-remote-access-paused",
    render: () => (
      <div className="visual-check__pane visual-check__pane--padded">
        <RemoteAccessSettingsSection bridge={bridge(true)} />
      </div>
    ),
  },
  {
    id: "qa-paired-devices",
    render: () => (
      <div className="visual-check__pane visual-check__pane--padded">
        <RemotePairedDevices client={pairedClient} origin={pending.origin} />
      </div>
    ),
  },
  {
    id: "qa-device-self-read-only",
    render: () => (
      <div className="visual-check__pane visual-check__pane--padded">
        <RemoteDeviceSelfPanel
          bridge={sessionBridge("read-only")}
          onRevoked={() => undefined}
          onSignedOut={() => undefined}
        />
      </div>
    ),
  },
  {
    id: "qa-device-self-full",
    render: () => (
      <div className="visual-check__pane visual-check__pane--padded">
        <RemoteDeviceSelfPanel
          bridge={sessionBridge("full")}
          onRevoked={() => undefined}
          onSignedOut={() => undefined}
        />
      </div>
    ),
  },
];
