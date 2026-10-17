import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createRemotePairingClient, type RemotePairingClient } from "@octant/client-runtime";
import { useRemotePairing, REMOTE_WEB_BUILD_VERSION } from "../remote/useRemotePairing";
import { SettingsFactList, SettingsState } from "../settings/primitives";
import type { PairedComputer, PairedComputersBridge } from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantField, OctantFieldLabel } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { createPairedComputerFetch } from "./pairedComputerFetch";
import type { HostFederationStack } from "./useHostFederationLifecycle";

export interface PairedComputerPairing {
  readonly computer: PairedComputer;
  readonly ticket: { readonly ticketId: string; readonly ticketProof: string };
  readonly pin: string;
}

const NO_REPLACEMENT = (): void => {};

/**
 * Claims the pairing ticket main handed back, with a device key made and kept
 * in this window. The claim travels through the desktop's main process, which
 * holds it to the pin the code carried; the person compares the code shown
 * here with the one on the other computer and approves there. Once approved,
 * the computer is in this window's registry and the federation lifecycle
 * connects it like any other host.
 */
export function PairedComputerClaim(props: {
  readonly bridge: Pick<PairedComputersBridge, "requestPairedComputer">;
  readonly federation: HostFederationStack;
  readonly pairing: PairedComputerPairing;
  /** Replaces the transport-backed client; only tests do. */
  readonly client?: RemotePairingClient;
  /** Said once the computer is connected, or when the person leaves without pairing it. */
  readonly onFinished: (outcome: "paired" | "left") => void;
}) {
  const { bridge, federation, pairing } = props;
  const labelId = useId();
  const [deviceLabel, setDeviceLabel] = useState("Octant desktop");
  const client = useMemo(
    () =>
      props.client ??
      createRemotePairingClient({
        baseUrl: pairing.computer.origin,
        fetch: createPairedComputerFetch(bridge),
        webBuildVersion: REMOTE_WEB_BUILD_VERSION,
        deviceKeyStore: federation.deviceKeyStore,
        listenerTrust: { kind: "pinned", pin: pairing.pin },
      }),
    [bridge, federation.deviceKeyStore, pairing.computer.origin, pairing.pin, props.client],
  );
  const [connecting, setConnecting] = useState<"idle" | "connecting" | "missing">("idle");
  const flow = useRemotePairing({
    baseUrl: pairing.computer.origin,
    ticket: pairing.ticket,
    client,
    hostRegistry: federation.registry,
    deviceKeyStore: federation.deviceKeyStore,
    replaceFragment: NO_REPLACEMENT,
    onApproved: () => setConnecting("connecting"),
  });
  const { onFinished } = props;
  const { lifecycle } = federation;
  useEffect(() => {
    if (connecting !== "connecting") return;
    let cancelled = false;
    void lifecycle.sync().then(() => {
      if (cancelled) return;
      const known = lifecycle.list().some((host) => host.origin === pairing.computer.origin);
      if (known) onFinished("paired");
      else setConnecting("missing");
    });
    return () => {
      cancelled = true;
    };
  }, [connecting, lifecycle, onFinished, pairing.computer.origin]);

  const name = pairing.computer.displayName;
  const { screen } = flow;
  // `entry` is where the flow lands after Cancel or Close; it is also the
  // screen before the ticket is read, which is not leaving.
  const started = useRef(false);
  useEffect(() => {
    if (screen.kind !== "entry") started.current = true;
    else if (started.current) onFinished("left");
  }, [screen.kind, onFinished]);

  if (connecting === "missing") {
    return (
      <SettingsState kind="error">
        {name} approved this computer, but Octant couldn't save it. Forget it and pair again.
      </SettingsState>
    );
  }
  switch (screen.kind) {
    case "requesting-hello":
    case "claiming":
    case "approved":
    case "resuming":
    case "resumed":
    case "entry":
      return <SettingsState kind="loading">Contacting {name}…</SettingsState>;
    case "confirm":
      return (
        <div className="settings-panel__stack">
          <SettingsFactList
            facts={[
              { label: "Computer", value: screen.hostHello.displayName },
              {
                label: "Key fingerprint",
                value: (
                  <span className="oct-meta--mono">{screen.hostHello.hostKeyFingerprint}</span>
                ),
              },
            ]}
          />
          <OctantField>
            <OctantFieldLabel htmlFor={labelId}>Name for this computer</OctantFieldLabel>
            <OctantInput
              id={labelId}
              onChange={(event) => setDeviceLabel(event.target.value)}
              value={deviceLabel}
            />
          </OctantField>
          <div className="host-settings__controls">
            <OctantButton
              onClick={() => flow.confirmPairing(deviceLabel.trim() || "Octant desktop")}
              size="sm"
              type="button"
              variant="default"
            >
              Ask {name} to approve
            </OctantButton>
            <OctantButton onClick={flow.reset} size="sm" type="button" variant="secondary">
              Cancel
            </OctantButton>
          </div>
        </div>
      );
    case "waiting":
      return (
        <div className="settings-panel__stack">
          <SettingsFactList
            facts={[
              {
                label: "Comparison code",
                value: <span className="oct-meta--mono">{screen.claim.comparisonCode}</span>,
              },
              {
                label: "Your key fingerprint",
                value: <span className="oct-meta--mono">{screen.claim.deviceKeyFingerprint}</span>,
              },
            ]}
          />
          <SettingsState kind="loading">
            Waiting for {name}. Approve there only if it shows the same comparison code.
          </SettingsState>
          <div className="host-settings__controls">
            <OctantButton onClick={flow.reset} size="sm" type="button" variant="secondary">
              Cancel
            </OctantButton>
          </div>
        </div>
      );
    case "failed":
      return (
        <div className="settings-panel__stack">
          <SettingsState kind="error">{screen.message}</SettingsState>
          <div className="host-settings__controls">
            {screen.category === "unavailable" || screen.category === "rate-limited" ? (
              <OctantButton onClick={flow.retry} size="sm" type="button" variant="secondary">
                Try again
              </OctantButton>
            ) : null}
            <OctantButton onClick={flow.reset} size="sm" type="button" variant="secondary">
              Close
            </OctantButton>
          </div>
        </div>
      );
  }
}
