import type {
  PairedDeviceAdministrationAnswer,
  PairedDeviceAdministrationClient,
} from "@octant/client-runtime/paired-device-administration-client";
import type {
  RemoteDeviceInventoryEntry,
  RemoteMintedPairingTicket,
  RemotePairingTicketSourceClass,
  RemotePendingPairingRequest,
} from "@octant/contracts/desktop-bridge";
import { useCallback, useEffect, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";

// The network a new device may claim its ticket over. "This machine only" is
// left out: a device pairing from the host itself is paired at the host.
const SOURCE_OPTIONS: ReadonlyArray<{
  readonly id: RemotePairingTicketSourceClass;
  readonly label: string;
}> = [
  { id: "lan-private", label: "Private LAN" },
  { id: "tailscale", label: "Tailscale" },
];

export interface RemotePairedDevicesProps {
  readonly client: PairedDeviceAdministrationClient;
  /** The host's address as this browser reached it; a pairing link starts with it. */
  readonly origin: string;
}

/**
 * The host's paired devices and waiting pairing requests, administered from a
 * browser the host's own person paired (maintainer decision, 2026-11-12). The
 * host Settings section that does this at a window also sets up the listener,
 * which the host keeps to its own computer, so this lists and changes devices
 * only. The host decides every request; a refusal, such as a device approving
 * its own pairing, is shown as the host worded it.
 */
export function RemotePairedDevices(props: RemotePairedDevicesProps) {
  const { client } = props;
  const [devices, setDevices] = useState<ReadonlyArray<RemoteDeviceInventoryEntry>>([]);
  const [requests, setRequests] = useState<ReadonlyArray<RemotePendingPairingRequest>>([]);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ readonly deviceId: string; readonly label: string }>();
  const [confirmingRevokeAll, setConfirmingRevokeAll] = useState(false);
  const [source, setSource] = useState<RemotePairingTicketSourceClass>("lan-private");
  const [ticket, setTicket] = useState<RemoteMintedPairingTicket>();

  const refresh = useCallback(async () => {
    const [listed, pending] = await Promise.all([
      client.listDevices(),
      client.listPairingRequests(),
    ]);
    if (listed.status === "ok") setDevices(listed.value);
    if (pending.status === "ok") setRequests(pending.value);
    const refused = [listed, pending].find((answer) => answer.status === "refused");
    if (refused?.status === "refused") setMessage(refused.message);
  }, [client]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const change = async (act: () => Promise<PairedDeviceAdministrationAnswer>) => {
    setBusy(true);
    setMessage(undefined);
    const answer = await act();
    if (answer.status === "refused") setMessage(answer.message);
    await refresh();
    setBusy(false);
  };
  const pair = async () => {
    setBusy(true);
    setMessage(undefined);
    const answer = await client.createPairingTicket(source);
    if (answer.status === "ok") setTicket(answer.value);
    else setMessage(answer.message);
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-2">
      {message === undefined ? null : <OctantAlert tone="warning">{message}</OctantAlert>}
      {requests.length === 0 ? null : (
        <ul aria-label="Pairing requests" className="flex flex-col gap-1">
          {requests.map((request) => (
            <li className="flex flex-wrap items-center gap-1" key={request.ticketId}>
              <span>{request.deviceLabel}</span>
              <span className="oct-meta--mono">{request.comparisonCode}</span>
              <OctantButton
                aria-label={`Approve ${request.deviceLabel}`}
                disabled={busy}
                onClick={() => void change(() => client.approvePairingRequest(request.ticketId))}
                size="sm"
                type="button"
              >
                Approve
              </OctantButton>
              <OctantButton
                aria-label={`Deny ${request.deviceLabel}`}
                disabled={busy}
                onClick={() => void change(() => client.denyPairingRequest(request.ticketId))}
                size="sm"
                type="button"
                variant="ghost"
              >
                Deny
              </OctantButton>
            </li>
          ))}
        </ul>
      )}
      <ul aria-label="Paired devices" className="flex flex-col gap-1">
        {devices.map((device) => (
          <li className="flex flex-wrap items-center gap-1" key={device.deviceId}>
            {renaming?.deviceId === device.deviceId ? (
              <>
                <OctantInput
                  aria-label={`Name for ${device.deviceLabel}`}
                  onChange={(event) =>
                    setRenaming({ deviceId: device.deviceId, label: event.target.value })
                  }
                  value={renaming.label}
                />
                <OctantButton
                  disabled={busy || renaming.label.trim() === ""}
                  onClick={() => {
                    const label = renaming.label.trim();
                    setRenaming(undefined);
                    void change(() => client.renameDevice(device.deviceId, label));
                  }}
                  size="sm"
                  type="button"
                >
                  Save
                </OctantButton>
              </>
            ) : (
              <>
                <span>{device.deviceLabel}</span>
                <span className="text-xs text-muted-foreground">{device.state}</span>
                <OctantButton
                  disabled={busy}
                  onClick={() =>
                    setRenaming({ deviceId: device.deviceId, label: device.deviceLabel })
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Rename
                </OctantButton>
              </>
            )}
            {device.state === "active" ? (
              <OctantButton
                disabled={busy}
                onClick={() => void change(() => client.revokeDevice(device.deviceId))}
                size="sm"
                type="button"
                variant="ghost"
              >
                Revoke
              </OctantButton>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-1">
        <OctantSelectField
          aria-label="Network the new device pairs over"
          disabled={busy}
          onValueChange={(next) => {
            const option = SOURCE_OPTIONS.find((candidate) => candidate.id === next);
            if (option !== undefined) setSource(option.id);
          }}
          options={SOURCE_OPTIONS}
          value={source}
        />
        <OctantButton
          disabled={busy}
          onClick={() => void pair()}
          size="sm"
          type="button"
          variant="secondary"
        >
          Pair another device
        </OctantButton>
        <OctantButton
          disabled={busy || devices.length === 0}
          onClick={() => {
            if (!confirmingRevokeAll) {
              setConfirmingRevokeAll(true);
              return;
            }
            setConfirmingRevokeAll(false);
            void change(() => client.revokeAllDevices());
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          {confirmingRevokeAll ? "Revoke all, this browser included" : "Revoke all devices"}
        </OctantButton>
      </div>
      {ticket === undefined ? null : (
        <OctantInput
          aria-label="Pairing link"
          readOnly
          value={`${props.origin}/#ticketId=${encodeURIComponent(ticket.ticketId)}&ticketProof=${encodeURIComponent(ticket.ticketProof)}`}
        />
      )}
    </div>
  );
}
