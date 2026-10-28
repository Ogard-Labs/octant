import {
  buildPairingCode,
  classifyRemoteListenerAddress,
  PAIRING_CODE_REFUSAL_COPY,
  refusePairingCodeListener,
  remoteListenerOrigin,
} from "@octant/domain";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { failureMessage } from "../lib/failureMessage";
import {
  SettingRow,
  SettingsFactList,
  SettingsPanel,
  SettingsSection,
  SettingsState,
} from "../settings/primitives";
import type {
  HubAdministrationBridge,
  PrivateListenerEnableRequest,
  PrivateListenerPublicStatus,
  RemoteAccessAdministrationBridge,
  RemoteDeviceInventoryEntry,
  RemoteMintedPairingTicket,
  RemotePairingTicketSourceClass,
  PairedComputersBridge,
  RemotePendingPairingRequest,
} from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantField, OctantFieldLabel } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { OctantAlert } from "../ui/base/OctantAlert";
import { HubSettingsSection } from "./HubSettingsSection";
import { PairedComputersSettingsSection } from "./PairedComputersSettingsSection";
import { PairingCodeQr } from "./PairingCodeQr";

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
  /** Pairing this desktop app with another computer; absent outside the desktop app. */
  readonly pairedComputers?: PairedComputersBridge | undefined;
  /** The hub role and hub membership; absent unless this is a local window. */
  readonly hub?: HubAdministrationBridge | undefined;
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
  "tls-key-exposed":
    "The listener's certificate key can be read by other users on this computer, so Octant won't use it.",
  "occupied-port": "Another process is already using that port.",
  "interface-unavailable": "That network interface is not available right now.",
  "bind-failed": "Octant could not bind the listener.",
  "shutdown-failed": "Octant could not stop the listener cleanly.",
  unavailable: "The remote listener service is unavailable.",
};

function pairingLink(origin: string, ticket: RemoteMintedPairingTicket): string {
  return `${origin}/#ticketId=${encodeURIComponent(ticket.ticketId)}&ticketProof=${encodeURIComponent(ticket.ticketProof)}`;
}

export function RemoteAccessSettingsSection({
  bridge,
  pairedComputers,
  hub,
  now,
}: RemoteAccessSettingsSectionProps) {
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
  // The app pairing code for a self-made listener, with the listener it names.
  // It is held only while its ticket is live and that listener is unchanged.
  const [mintedCode, setMintedCode] = useState<MintedPairingCode>();
  const [pairingCodeExpired, setPairingCodeExpired] = useState(false);
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const [ticketSource, setTicketSource] = useState<RemotePairingTicketSourceClass>("lan-private");
  const [pairingMessage, setPairingMessage] = useState<string>();
  const [renameDraft, setRenameDraft] = useState<{ deviceId: string; label: string }>();
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);
  const listenerOpener = useRef<HTMLButtonElement>(null);
  const revokeAllOpener = useRef<HTMLButtonElement>(null);
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
  // With the listener off the host has no remote gateway to answer a device
  // inventory, so its refusal is the prerequisite this page already states
  // rather than a failure to report.
  const listenerNotEnabled = status !== undefined && status.enabled !== true;
  const draftPort = Number.parseInt(draft.port, 10);
  const draftOrigin =
    draft.hostname.trim() === "" || !Number.isSafeInteger(draftPort)
      ? undefined
      : remoteListenerOrigin(draft.hostname.trim(), draftPort);
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
      // A code names the listener's origin and key pin, so one minted before
      // the move would point the device at the old listener.
      setTicket(undefined);
      setMintedCode(undefined);
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
      setMintedCode(undefined);
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
      setMintedCode(undefined);
    } catch (error) {
      setPairingMessage(failureMessage(error, "Octant could not create a pairing link."));
    }
  };

  const mintPairingCode = async (listenerForCode: PairingCodeListener) => {
    setPairingMessage(undefined);
    setTicket(undefined);
    setMintedCode(undefined);
    setPairingCodeExpired(false);
    // A listener no code can name is refused before a ticket exists, so a
    // refusal never leaves a live, unshown ticket on the host.
    const refusal = refusePairingCodeListener(listenerForCode);
    if (refusal !== undefined) {
      setPairingMessage(PAIRING_CODE_REFUSAL_COPY[refusal]);
      return;
    }
    try {
      // The device claims the ticket over the listener itself, so the ticket
      // names the listener's own network rather than a network the person picks.
      const minted = await bridge.mintRemotePairingTicket(listenerForCode.exposureClass);
      const built = buildPairingCode({
        origin: listenerForCode.origin,
        ticketId: minted.ticketId,
        ticketProof: minted.ticketProof,
        pin: listenerForCode.pin,
      });
      if (built.status === "refused") {
        setPairingMessage(PAIRING_CODE_REFUSAL_COPY[built.reason]);
        return;
      }
      setMintedCode({
        code: built.code,
        expiresAt: minted.expiresAt,
        sourceClass: minted.sourceClass,
        origin: listenerForCode.origin,
        pin: listenerForCode.pin,
      });
    } catch (error) {
      setPairingMessage(failureMessage(error, "Octant could not create a pairing code."));
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
  // A browser decides whether to trust the listener before any Octant page
  // loads, and it cannot check a certificate the host made itself, so a
  // browser pairing link is never offered for one.
  const browserCannotVerify = status?.certificateSource === "self-made";
  const codeListener = pairingCodeListenerOf(status);

  // An expired code is dropped from state, not merely hidden, so nothing keeps
  // a dead ticket's proof around.
  useEffect(() => {
    if (mintedCode === undefined) return;
    const expire = () => {
      setMintedCode(undefined);
      setPairingCodeExpired(true);
    };
    const remaining = mintedCode.expiresAt - clockRef.current();
    if (remaining <= 0) {
      expire();
      return;
    }
    const timer = setTimeout(expire, remaining);
    return () => clearTimeout(timer);
  }, [mintedCode]);

  // `octant listener` can move or turn off the listener behind this page, so
  // while a code is shown the status is re-read on focus and every few seconds.
  useEffect(() => {
    if (mintedCode === undefined) return;
    const refresh = () => void refreshListener();
    window.addEventListener("focus", refresh);
    const timer = setInterval(refresh, PAIRING_CODE_STATUS_REFRESH_MS);
    return () => {
      window.removeEventListener("focus", refresh);
      clearInterval(timer);
    };
  }, [mintedCode, refreshListener]);

  // A code names one origin and key pin; once the listener differs it would
  // send a device to the wrong place or fail its pin check, so it is dropped.
  useEffect(() => {
    if (mintedCode === undefined || listener.kind !== "ready") return;
    if (
      codeListener === undefined ||
      codeListener.origin !== mintedCode.origin ||
      codeListener.pin !== mintedCode.pin
    ) {
      setMintedCode(undefined);
      setPairingMessage(
        "The listener changed, so that pairing code was dropped. Create a new one.",
      );
    }
  }, [mintedCode, listener.kind, codeListener?.origin, codeListener?.pin]);
  const activeDevices = devices.filter((device) => device.state === "active");

  return (
    <section
      aria-label="Remote access"
      className="settings-section settings-section-stack"
      id="settings-remote-access"
    >
      <SettingsSection title="Remote listener">
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
              <OctantField>
                <OctantFieldLabel htmlFor={hostnameId}>Hostname</OctantFieldLabel>
                <OctantInput
                  autoComplete="off"
                  id={hostnameId}
                  onChange={(event) => setDraft({ ...draft, hostname: event.target.value })}
                  placeholder="mac.tailnet.ts.net or 192.168.1.20"
                  value={draft.hostname}
                />
              </OctantField>
              <OctantField>
                <OctantFieldLabel htmlFor={portId}>Port</OctantFieldLabel>
                <OctantInput
                  id={portId}
                  inputMode="numeric"
                  onChange={(event) => setDraft({ ...draft, port: event.target.value })}
                  value={draft.port}
                />
              </OctantField>
              <OctantField>
                <OctantFieldLabel htmlFor={certificateId}>Certificate (PEM)</OctantFieldLabel>
                <OctantTextarea
                  autoComplete="off"
                  id={certificateId}
                  onChange={(event) => setDraft({ ...draft, certificatePem: event.target.value })}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  rows={3}
                  spellCheck={false}
                  value={draft.certificatePem}
                />
              </OctantField>
              <OctantField>
                <OctantFieldLabel htmlFor={keyId}>Private key (PEM)</OctantFieldLabel>
                <OctantTextarea
                  autoComplete="off"
                  id={keyId}
                  onChange={(event) => setDraft({ ...draft, privateKeyPem: event.target.value })}
                  placeholder="-----BEGIN PRIVATE KEY-----"
                  rows={3}
                  spellCheck={false}
                  value={draft.privateKeyPem}
                />
              </OctantField>
              {draft.hostname.trim() !== "" &&
              draftExposure !== "lan-private" &&
              draftExposure !== "tailscale" ? (
                <OctantAlert className="settings-section-line" tone="warning">
                  {draftExposure === "loopback"
                    ? "A loopback address cannot be reached by another device."
                    : draftExposure === "public"
                      ? "Octant does not listen on public addresses."
                      : "Enter a private LAN or Tailscale address."}
                </OctantAlert>
              ) : null}
              <div className="host-settings__controls">
                <OctantButton
                  aria-expanded={confirming !== undefined}
                  aria-haspopup="dialog"
                  disabled={listenerBusy || !draftComplete || confirming !== undefined}
                  onClick={stageEnable}
                  ref={listenerOpener}
                  size="sm"
                  type="button"
                  variant="default"
                >
                  {status?.enabled === true ? "Move listener…" : "Enable listener…"}
                </OctantButton>
                {status?.enabled === true ? (
                  <OctantButton
                    disabled={listenerBusy}
                    onClick={() => void disableListener()}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Disable listener
                  </OctantButton>
                ) : null}
              </div>
            </div>
          </SettingRow>
        </div>
        {confirming === undefined ? null : (
          <OctantConfirmDialog
            confirmLabel={status?.enabled === true ? "Confirm move" : "Confirm enable"}
            destructive={false}
            details={
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
            }
            onCancel={() => setConfirming(undefined)}
            onConfirm={() => void applyListener(confirming)}
            pending={listenerBusy}
            restoreFocus={listenerOpener}
            title={status?.enabled === true ? "Move remote listener?" : "Enable remote listener?"}
          >
            Other devices on this network will be able to reach this host. Pairing still requires
            your approval here for every device.
          </OctantConfirmDialog>
        )}
        {listenerMessage === undefined ? null : (
          <SettingsState kind="error">{listenerMessage}</SettingsState>
        )}
      </SettingsSection>

      <SettingsSection title="Pair a device">
        {browserCannotVerify ? (
          <div className="setgroup">
            <SettingRow
              description="A pairing code is single-use and expires in five minutes. It carries a fingerprint of this computer's own certificate key, so an Octant app can tell it is talking to this computer. Approve the request that appears below."
              label="Pairing code"
              scope="host"
              settingId="remote-pairing-code"
            >
              <div className="settings-panel__stack">
                {codeListener === undefined ? null : (
                  <div className="host-settings__controls">
                    <OctantButton
                      onClick={() => void mintPairingCode(codeListener)}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      Create pairing code
                    </OctantButton>
                  </div>
                )}
                {status?.state !== "ready" ? (
                  <p className="settings-section-line">
                    Enable the remote listener before pairing a device.
                  </p>
                ) : null}
                <p className="settings-section-line">
                  A browser can't check this computer's own certificate, so there is no pairing link
                  for it. To pair a browser, give the listener a Tailscale certificate or your own.
                </p>
              </div>
            </SettingRow>
          </div>
        ) : (
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
                  {status?.state === "ready" ? (
                    <OctantButton
                      onClick={() => void mintTicket()}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      Create pairing link
                    </OctantButton>
                  ) : null}
                </div>
                {status?.state !== "ready" ? (
                  <p className="settings-section-line">
                    Enable the remote listener before pairing a device.
                  </p>
                ) : null}
              </div>
            </SettingRow>
          </div>
        )}
        {mintedCode !== undefined && browserCannotVerify ? (
          <div className="settings-panel__stack">
            <PairingCodeQr code={mintedCode.code} />
            <SettingsFactList
              facts={[
                {
                  label: "Code",
                  value: (
                    <code aria-label="Pairing code" className="oct-meta--mono remote-pairing-code">
                      {mintedCode.code}
                    </code>
                  ),
                },
                { label: "Network", value: SOURCE_CLASS_LABELS[mintedCode.sourceClass] },
                { label: "Expires", value: new Date(mintedCode.expiresAt).toLocaleTimeString() },
              ]}
            />
            <p className="settings-section-line">
              Paste this code into Octant's desktop app under Settings, Remote access, Other
              computers, or scan the QR code with the phone app.
            </p>
          </div>
        ) : pairingCodeExpired && browserCannotVerify ? (
          <SettingsState kind="empty">That pairing code expired. Create a new one.</SettingsState>
        ) : null}
        {ticket !== undefined &&
        !browserCannotVerify &&
        status?.origin !== null &&
        status?.origin !== undefined ? (
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
              <li className="settings-card" key={request.ticketId}>
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
      </SettingsSection>

      {/* Revoking is this page's destructive group, so it sits last. */}
      <SettingsPanel
        title="Paired devices"
        description="Revoking a device ends its sessions and streams immediately; it must pair again to return."
        tone="danger"
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
          {activeDevices.length === 0 ? null : (
            <div className="host-settings__controls">
              <OctantButton
                aria-expanded={confirmRevokeAll}
                aria-haspopup="dialog"
                onClick={() => setConfirmRevokeAll(true)}
                ref={revokeAllOpener}
                size="sm"
                type="button"
                variant="secondary"
              >
                Revoke all…
              </OctantButton>
            </div>
          )}
          {activeDevices.length !== 0 && confirmRevokeAll ? (
            <OctantConfirmDialog
              cancelLabel="Keep them"
              confirmLabel="Revoke all devices"
              onCancel={() => setConfirmRevokeAll(false)}
              onConfirm={() => void revokeAll()}
              restoreFocus={revokeAllOpener}
              title="Revoke every paired device?"
            >
              Every paired device will lose access to this host. You will need to pair each device
              again.
            </OctantConfirmDialog>
          ) : null}
          {inventoryMessage === undefined || listenerNotEnabled ? null : (
            <SettingsState kind="error">{inventoryMessage}</SettingsState>
          )}
        </div>
      </SettingsPanel>
      {hub === undefined ? null : <HubSettingsSection hub={hub} pairing={bridge} />}
      {pairedComputers === undefined ? null : (
        <PairedComputersSettingsSection bridge={pairedComputers} />
      )}
    </section>
  );
}

/** How often a shown pairing code re-reads the listener it names. */
const PAIRING_CODE_STATUS_REFRESH_MS = 5_000;

interface MintedPairingCode {
  readonly code: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  readonly sourceClass: RemotePairingTicketSourceClass;
  readonly origin: string;
  readonly pin: string;
}

interface PairingCodeListener {
  readonly origin: string;
  readonly pin: string;
  readonly exposureClass: RemotePairingTicketSourceClass;
}

/** A listener a pairing code can name: up, serving its own certificate, with its pin known. */
function pairingCodeListenerOf(
  status: PrivateListenerPublicStatus | undefined,
): PairingCodeListener | undefined {
  if (
    status?.state !== "ready" ||
    status.certificateSource !== "self-made" ||
    status.origin === null ||
    status.tlsPin === null ||
    status.exposureClass === null
  ) {
    return undefined;
  }
  return { origin: status.origin, pin: status.tlsPin, exposureClass: status.exposureClass };
}
