import { classifyRemoteListenerAddress } from "@octant/domain";
import { useCallback, useEffect, useId, useState } from "react";
import { SettingRow, SettingsFactList, SettingsPanel, SettingsState } from "../settings/primitives";
import type {
  PrivateListenerEnableRequest,
  PrivateListenerPublicStatus,
  RemoteAccessAdministrationBridge,
  RemoteDeviceInventoryEntry,
  RemoteMintedPairingTicket,
  RemotePairingTicketSourceClass,
  RemotePendingPairingRequest,
} from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";

/**
 * Listener, pairing, and paired-device administration for the packaged host.
 * Every action goes preload → main → server over the loopback desktop bridge;
 * the server refuses the same routes for a remote principal, so this section
 * is only mounted when the bridge exposes them. Certificate and key material
 * pass through once to enable or retarget the listener and are never shown
 * back, logged, or kept in state after the request.
 */
export interface RemoteAccessSettingsSectionProps {
  readonly bridge: RemoteAccessAdministrationBridge;
  /** Reads the clock so a test can freeze ticket expiry. */
  readonly now?: () => number;
}

type ListenerState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly status: PrivateListenerPublicStatus };

type ListenerDraft = {
  readonly hostname: string;
  readonly port: string;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
};

const EMPTY_DRAFT: ListenerDraft = {
  hostname: "",
  port: "13774",
  certificatePem: "",
  privateKeyPem: "",
};

const SOURCE_CLASS_LABELS: Readonly<Record<RemotePairingTicketSourceClass, string>> = {
  loopback: "This machine only",
  "lan-private": "Private LAN",
  tailscale: "Tailscale",
};

const LISTENER_FAILURE_COPY: Readonly<Record<string, string>> = {
  "local-confirmation-required": "Enabling needs confirmation on this host.",
  "invalid-bind": "Octant refuses to bind that address. Use a private LAN or Tailscale address.",
  "invalid-origin": "The origin must be HTTPS and match the address and port.",
  "invalid-tls": "The certificate or private key could not be read.",
  "occupied-port": "Another process is already using that port.",
  "interface-unavailable": "That network interface is not available right now.",
  "bind-failed": "Octant could not bind the listener.",
  "shutdown-failed": "Octant could not stop the listener cleanly.",
  unavailable: "The remote listener service is unavailable.",
};

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function pairingLink(origin: string, ticket: RemoteMintedPairingTicket): string {
  return `${origin}/#ticketId=${encodeURIComponent(ticket.ticketId)}&ticketProof=${encodeURIComponent(ticket.ticketProof)}`;
}

export function RemoteAccessSettingsSection({ bridge, now }: RemoteAccessSettingsSectionProps) {
  const clock = now ?? (() => Date.now());
  const [listener, setListener] = useState<ListenerState>({ kind: "loading" });
  const [listenerMessage, setListenerMessage] = useState<string>();
  const [listenerBusy, setListenerBusy] = useState(false);
  const [draft, setDraft] = useState<ListenerDraft>(EMPTY_DRAFT);
  const [confirming, setConfirming] = useState<PrivateListenerEnableRequest>();
  const [pending, setPending] = useState<ReadonlyArray<RemotePendingPairingRequest>>([]);
  const [devices, setDevices] = useState<ReadonlyArray<RemoteDeviceInventoryEntry>>([]);
  const [inventoryMessage, setInventoryMessage] = useState<string>();
  const [ticket, setTicket] = useState<RemoteMintedPairingTicket>();
  const [ticketSource, setTicketSource] = useState<RemotePairingTicketSourceClass>("lan-private");
  const [pairingMessage, setPairingMessage] = useState<string>();
  const [renameDraft, setRenameDraft] = useState<{ deviceId: string; label: string }>();
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);
  const hostnameId = useId();
  const portId = useId();
  const certificateId = useId();
  const keyId = useId();
  const sourceId = useId();

  const refreshListener = useCallback(async () => {
    try {
      setListener({ kind: "ready", status: await bridge.getPrivateListenerStatus() });
    } catch (error) {
      setListener({
        kind: "error",
        message: failureMessage(error, "The remote listener status is unavailable."),
      });
    }
  }, [bridge]);

  const refreshInventory = useCallback(async () => {
    setInventoryMessage(undefined);
    try {
      const [requests, inventory] = await Promise.all([
        bridge.listRemotePairingRequests(),
        bridge.getRemoteDeviceInventory(),
      ]);
      setPending(requests);
      setDevices(inventory);
    } catch (error) {
      setInventoryMessage(failureMessage(error, "Paired devices could not be read."));
    }
  }, [bridge]);

  useEffect(() => {
    void refreshListener();
    void refreshInventory();
  }, [refreshListener, refreshInventory]);

  const status = listener.kind === "ready" ? listener.status : undefined;
  const draftPort = Number.parseInt(draft.port, 10);
  const draftOrigin =
    draft.hostname.trim() === "" || !Number.isSafeInteger(draftPort)
      ? undefined
      : `https://${draft.hostname.trim()}${draftPort === 443 ? "" : `:${draftPort}`}`;
  const draftExposure = classifyRemoteListenerAddress(draft.hostname);
  const draftComplete =
    draftOrigin !== undefined &&
    draftPort >= 1 &&
    draftPort <= 65_535 &&
    draft.certificatePem.trim() !== "" &&
    draft.privateKeyPem.trim() !== "" &&
    (draftExposure === "lan-private" || draftExposure === "tailscale");

  const stageEnable = () => {
    if (!draftComplete || draftOrigin === undefined) return;
    setListenerMessage(undefined);
    setConfirming({
      hostname: draft.hostname.trim(),
      port: draftPort,
      origin: draftOrigin,
      certificatePem: draft.certificatePem,
      privateKeyPem: draft.privateKeyPem,
      localConfirmation: true,
    });
  };

  const applyListener = async (request: PrivateListenerEnableRequest) => {
    setListenerBusy(true);
    setListenerMessage(undefined);
    try {
      const next =
        status?.enabled === true
          ? await bridge.restartPrivateListener(request)
          : await bridge.enablePrivateListener(request);
      setListener({ kind: "ready", status: next });
      if (next.state === "failed") {
        setListenerMessage(
          LISTENER_FAILURE_COPY[next.errorCode ?? ""] ?? "The remote listener could not start.",
        );
      } else {
        setDraft(EMPTY_DRAFT);
      }
    } catch (error) {
      setListenerMessage(failureMessage(error, "The remote listener could not be changed."));
    } finally {
      // Key material is single-use here: it went to the host once and is not
      // kept for a retry, which re-reads it from the form.
      setConfirming(undefined);
      setListenerBusy(false);
    }
  };

  const disableListener = async () => {
    setListenerBusy(true);
    setListenerMessage(undefined);
    try {
      setListener({ kind: "ready", status: await bridge.disablePrivateListener() });
      setTicket(undefined);
    } catch (error) {
      setListenerMessage(failureMessage(error, "The remote listener could not be disabled."));
    } finally {
      setListenerBusy(false);
    }
  };

  const mintTicket = async () => {
    setPairingMessage(undefined);
    try {
      setTicket(await bridge.mintRemotePairingTicket(ticketSource));
    } catch (error) {
      setPairingMessage(failureMessage(error, "Octant could not create a pairing link."));
    }
  };

  const decide = async (request: RemotePendingPairingRequest, decision: "approve" | "deny") => {
    setPairingMessage(undefined);
    try {
      if (decision === "approve") {
        await bridge.approveRemotePairingRequest(request.ticketId);
        setPairingMessage(`Approved ${request.deviceLabel}.`);
      } else {
        await bridge.denyRemotePairingRequest(request.ticketId, "user-denied");
        setPairingMessage(`Denied ${request.deviceLabel}.`);
      }
    } catch (error) {
      setPairingMessage(failureMessage(error, "The pairing decision was not applied."));
    }
    await refreshInventory();
  };

  const revoke = async (device: RemoteDeviceInventoryEntry) => {
    setInventoryMessage(undefined);
    try {
      await bridge.revokeRemoteDevice(device.deviceId);
    } catch (error) {
      setInventoryMessage(failureMessage(error, "The device was not revoked."));
    }
    await refreshInventory();
  };

  const revokeAll = async () => {
    setConfirmRevokeAll(false);
    setInventoryMessage(undefined);
    try {
      await bridge.revokeAllRemoteDevices();
    } catch (error) {
      setInventoryMessage(failureMessage(error, "The devices were not revoked."));
    }
    await refreshInventory();
  };

  const rename = async () => {
    if (renameDraft === undefined) return;
    setInventoryMessage(undefined);
    try {
      await bridge.renameRemoteDevice(renameDraft.deviceId, renameDraft.label);
      setRenameDraft(undefined);
    } catch (error) {
      setInventoryMessage(failureMessage(error, "The device was not renamed."));
    }
    await refreshInventory();
  };

  const ticketLive = ticket !== undefined && ticket.expiresAt > clock();
  const activeDevices = devices.filter((device) => device.state === "active");

  return (
    <section aria-label="Remote access" className="settings-section" id="settings-remote-access">
      <section
        aria-label="Remote listener"
        className="settings-card-section settings-card-section--open"
      >
        <h2>Remote listener</h2>
        {listener.kind === "loading" ? (
          <SettingsState kind="loading">Reading the remote listener…</SettingsState>
        ) : listener.kind === "error" ? (
          <SettingsState kind="error">{listener.message}</SettingsState>
        ) : (
          <SettingsFactList
            facts={[
              {
                label: "State",
                value:
                  listener.status.state === "ready"
                    ? "Listening"
                    : listener.status.state === "failed"
                      ? "Failed"
                      : "Off",
              },
              {
                label: "Address",
                value:
                  listener.status.hostname === null
                    ? "—"
                    : `${listener.status.hostname}:${listener.status.port ?? ""}`,
              },
              { label: "Origin", value: listener.status.origin ?? "—" },
              {
                label: "Reach",
                value:
                  listener.status.exposureClass === "tailscale"
                    ? "Tailscale"
                    : listener.status.exposureClass === "lan-private"
                      ? "Private LAN"
                      : "—",
              },
              {
                label: "Certificate",
                value:
                  listener.status.certificateFingerprint === null ? (
                    "—"
                  ) : (
                    <span className="oct-meta--mono">{listener.status.certificateFingerprint}</span>
                  ),
              },
            ]}
          />
        )}
        {status?.state === "failed" && listenerMessage === undefined ? (
          <SettingsState kind="error">
            {LISTENER_FAILURE_COPY[status.errorCode ?? ""] ?? "The remote listener failed."}
          </SettingsState>
        ) : null}
        <div className="setgroup">
          <SettingRow
            description="The address paired devices reach. Loopback and public addresses are refused; use a private LAN or Tailscale address with a certificate browsers trust."
            label={status?.enabled === true ? "Move the listener" : "Enable the listener"}
            scope="host"
            settingId="remote-listener"
          >
            <div className="settings-panel__stack">
              <OctantInput
                aria-label="Listener hostname"
                autoComplete="off"
                id={hostnameId}
                onChange={(event) => setDraft({ ...draft, hostname: event.target.value })}
                placeholder="mac.tailnet.ts.net or 192.168.1.20"
                value={draft.hostname}
              />
              <OctantInput
                aria-label="Listener port"
                id={portId}
                inputMode="numeric"
                onChange={(event) => setDraft({ ...draft, port: event.target.value })}
                value={draft.port}
              />
              <OctantTextarea
                aria-label="Certificate PEM"
                autoComplete="off"
                id={certificateId}
                onChange={(event) => setDraft({ ...draft, certificatePem: event.target.value })}
                placeholder="-----BEGIN CERTIFICATE-----"
                rows={3}
                spellCheck={false}
                value={draft.certificatePem}
              />
              <OctantTextarea
                aria-label="Private key PEM"
                autoComplete="off"
                id={keyId}
                onChange={(event) => setDraft({ ...draft, privateKeyPem: event.target.value })}
                placeholder="-----BEGIN PRIVATE KEY-----"
                rows={3}
                spellCheck={false}
                value={draft.privateKeyPem}
              />
              {draft.hostname.trim() !== "" &&
              draftExposure !== "lan-private" &&
              draftExposure !== "tailscale" ? (
                <p className="settings-section-line" role="alert">
                  {draftExposure === "loopback"
                    ? "A loopback address cannot be reached by another device."
                    : draftExposure === "public"
                      ? "Octant does not listen on public addresses."
                      : "Enter a private LAN or Tailscale address."}
                </p>
              ) : null}
              <div className="host-settings__controls">
                <OctantButton
                  disabled={listenerBusy || !draftComplete || confirming !== undefined}
                  onClick={stageEnable}
                  size="sm"
                  type="button"
                  variant="default"
                >
                  {status?.enabled === true ? "Move listener…" : "Enable listener…"}
                </OctantButton>
                <OctantButton
                  disabled={listenerBusy || status?.enabled !== true}
                  onClick={() => void disableListener()}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Disable listener
                </OctantButton>
              </div>
            </div>
          </SettingRow>
        </div>
        {confirming === undefined ? null : (
          <div
            aria-label="Confirm remote listener"
            className="settings-panel settings-panel--danger"
            role="group"
          >
            <p>
              Other devices on this network will be able to reach this host. Pairing still requires
              your approval here for every device.
            </p>
            <SettingsFactList
              facts={[
                { label: "Address", value: `${confirming.hostname}:${confirming.port}` },
                { label: "Origin", value: confirming.origin },
                {
                  label: "Reach",
                  value:
                    classifyRemoteListenerAddress(confirming.hostname) === "tailscale"
                      ? "Tailscale"
                      : "Private LAN",
                },
                { label: "Certificate", value: "Provided; fingerprint shown once it loads." },
              ]}
            />
            <div className="host-settings__controls">
              <OctantButton
                disabled={listenerBusy}
                onClick={() => void applyListener(confirming)}
                size="sm"
                type="button"
                variant="default"
              >
                {status?.enabled === true ? "Confirm move" : "Confirm enable"}
              </OctantButton>
              <OctantButton
                disabled={listenerBusy}
                onClick={() => setConfirming(undefined)}
                size="sm"
                type="button"
                variant="secondary"
              >
                Cancel
              </OctantButton>
            </div>
          </div>
        )}
        {listenerMessage === undefined ? null : (
          <SettingsState kind="error">{listenerMessage}</SettingsState>
        )}
      </section>

      <section
        aria-label="Pair a device"
        className="settings-card-section settings-card-section--open"
      >
        <h2>Pair a device</h2>
        <div className="setgroup">
          <SettingRow
            description="A pairing link is single-use and expires in five minutes. Open it on the other device, then approve the request that appears below."
            label="Pairing link"
            scope="host"
            settingId="remote-pairing"
          >
            <div className="settings-panel__stack">
              <OctantSelectField
                aria-label="Pairing network"
                id={sourceId}
                onValueChange={(value) => {
                  if (value === "loopback" || value === "lan-private" || value === "tailscale") {
                    setTicketSource(value);
                  }
                }}
                options={Object.entries(SOURCE_CLASS_LABELS).map(([id, label]) => ({
                  id,
                  label,
                }))}
                value={ticketSource}
              />
              <div className="host-settings__controls">
                <OctantButton
                  disabled={status?.state !== "ready"}
                  onClick={() => void mintTicket()}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Create pairing link
                </OctantButton>
              </div>
              {status?.state !== "ready" ? (
                <p className="settings-section-line">
                  Enable the remote listener before pairing a device.
                </p>
              ) : null}
            </div>
          </SettingRow>
        </div>
        {ticket !== undefined && status?.origin !== null && status?.origin !== undefined ? (
          ticketLive ? (
            <SettingsFactList
              facts={[
                {
                  label: "Link",
                  value: (
                    <code aria-label="Pairing link" className="oct-meta--mono">
                      {pairingLink(status.origin, ticket)}
                    </code>
                  ),
                },
                { label: "Network", value: SOURCE_CLASS_LABELS[ticket.sourceClass] },
                { label: "Expires", value: new Date(ticket.expiresAt).toLocaleTimeString() },
              ]}
            />
          ) : (
            <SettingsState kind="empty">That pairing link expired. Create a new one.</SettingsState>
          )
        ) : null}
        {pending.length === 0 ? null : (
          <ul aria-label="Pairing requests" className="settings-panel__stack">
            {pending.map((request) => (
              <li className="settings-panel" key={request.ticketId}>
                <SettingsFactList
                  facts={[
                    { label: "Device", value: request.deviceLabel },
                    { label: "From", value: request.origin },
                    {
                      label: "Comparison code",
                      value: <span className="oct-meta--mono">{request.comparisonCode}</span>,
                    },
                    {
                      label: "Key fingerprint",
                      value: <span className="oct-meta--mono">{request.deviceKeyFingerprint}</span>,
                    },
                  ]}
                />
                <p className="settings-section-line">
                  Approve only if the comparison code matches the one shown on the device.
                </p>
                <div className="host-settings__controls">
                  <OctantButton
                    onClick={() => void decide(request, "approve")}
                    size="sm"
                    type="button"
                    variant="default"
                  >
                    Approve {request.deviceLabel}
                  </OctantButton>
                  <OctantButton
                    onClick={() => void decide(request, "deny")}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Deny {request.deviceLabel}
                  </OctantButton>
                </div>
              </li>
            ))}
          </ul>
        )}
        {pairingMessage === undefined ? null : (
          <SettingsState kind={/^(Approved|Denied)/.test(pairingMessage) ? "success" : "error"}>
            {pairingMessage}
          </SettingsState>
        )}
      </section>

      <SettingsPanel
        title="Paired devices"
        description="Revoking a device ends its sessions and streams immediately; it must pair again to return."
      >
        <div className="settings-panel__stack">
          {activeDevices.length === 0 ? (
            <SettingsState kind="empty">No devices are paired with this host.</SettingsState>
          ) : (
            <ul aria-label="Paired devices" className="settings-panel__stack">
              {activeDevices.map((device) => (
                <li className="host-settings__controls" key={device.deviceId}>
                  {renameDraft?.deviceId === device.deviceId ? (
                    <>
                      <OctantInput
                        aria-label={`New label for ${device.deviceLabel}`}
                        maxLength={128}
                        onChange={(event) =>
                          setRenameDraft({ deviceId: device.deviceId, label: event.target.value })
                        }
                        value={renameDraft.label}
                      />
                      <OctantButton
                        disabled={renameDraft.label.trim() === ""}
                        onClick={() => void rename()}
                        size="sm"
                        type="button"
                        variant="default"
                      >
                        Save
                      </OctantButton>
                      <OctantButton
                        onClick={() => setRenameDraft(undefined)}
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        Cancel
                      </OctantButton>
                    </>
                  ) : (
                    <>
                      <span>{device.deviceLabel}</span>
                      <span className="oct-meta">
                        {device.origin} · last seen {new Date(device.lastSeenAt).toLocaleString()}
                      </span>
                      <OctantButton
                        onClick={() =>
                          setRenameDraft({ deviceId: device.deviceId, label: device.deviceLabel })
                        }
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        Rename {device.deviceLabel}
                      </OctantButton>
                      <OctantButton
                        onClick={() => void revoke(device)}
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        Revoke {device.deviceLabel}
                      </OctantButton>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {activeDevices.length === 0 ? null : confirmRevokeAll ? (
            <div className="host-settings__controls" role="group" aria-label="Confirm revoke all">
              <span>Revoke every paired device?</span>
              <OctantButton
                onClick={() => void revokeAll()}
                size="sm"
                type="button"
                variant="default"
              >
                Revoke all devices
              </OctantButton>
              <OctantButton
                onClick={() => setConfirmRevokeAll(false)}
                size="sm"
                type="button"
                variant="secondary"
              >
                Keep them
              </OctantButton>
            </div>
          ) : (
            <div className="host-settings__controls">
              <OctantButton
                onClick={() => setConfirmRevokeAll(true)}
                size="sm"
                type="button"
                variant="secondary"
              >
                Revoke all…
              </OctantButton>
            </div>
          )}
          {inventoryMessage === undefined ? null : (
            <SettingsState kind="error">{inventoryMessage}</SettingsState>
          )}
        </div>
      </SettingsPanel>
    </section>
  );
}
