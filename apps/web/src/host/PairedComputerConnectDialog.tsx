import { useCallback, useId, useState } from "react";
import type { RemotePairingClient } from "@octant/client-runtime";
import { failureMessage } from "../lib/failureMessage";
import { SettingsFactList, SettingsState } from "../settings/primitives";
import type { PairedComputersBridge } from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantField, OctantFieldLabel } from "../ui/base/OctantField";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { PairedComputerClaim, type PairedComputerPairing } from "./PairedComputerClaim";
import type { HostFederationStack } from "./useHostFederationLifecycle";

export interface PairedComputerConnectDialogProps {
  readonly open: boolean;
  readonly hostName: string;
  readonly origin: string;
  readonly expectedPin?: string | undefined;
  readonly bridge: PairedComputersBridge;
  readonly federation: HostFederationStack;
  /** Replaces the transport-backed pairing client; only tests do. */
  readonly pairingClient?: RemotePairingClient | undefined;
  readonly onConnected: () => void;
  readonly onClose: () => void;
}

/**
 * Ordinary direct pairing opened from a Watching thread's "Connect to reply"
 * bar. Verifies the pasted pairing code matches this computer's origin and
 * expected pin before starting the comparison-code approval flow; on approval
 * the direct record replaces the hub-introduced one and the session reopens.
 * On denial, cancellation, or mismatch the thread stays Watching.
 */
export function PairedComputerConnectDialog(props: PairedComputerConnectDialogProps) {
  const {
    open,
    hostName,
    origin,
    expectedPin,
    bridge,
    federation,
    pairingClient,
    onConnected,
    onClose,
  } = props;
  const codeId = useId();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [claiming, setClaiming] = useState<PairedComputerPairing>();

  const resetAndClose = useCallback(() => {
    setCode("");
    setErrorMessage(undefined);
    setClaiming(undefined);
    onClose();
  }, [onClose]);

  const startConnect = async () => {
    setBusy(true);
    setErrorMessage(undefined);
    try {
      const outcome = await bridge.pairWithPairingCode(code);
      if (outcome.status === "refused") {
        setErrorMessage(outcome.message);
        return;
      }
      if (
        outcome.computer.origin !== origin ||
        (expectedPin !== undefined && outcome.pin !== expectedPin)
      ) {
        await bridge
          .settlePairedComputer(outcome.computer.origin, "abandoned")
          .catch(() => undefined);
        setErrorMessage(
          `That pairing code does not match ${hostName}'s address or certificate pin. Staying in Watching mode.`,
        );
        return;
      }
      setCode("");
      setClaiming({ computer: outcome.computer, ticket: outcome.ticket, pin: outcome.pin });
    } catch (error) {
      setErrorMessage(failureMessage(error, "Octant couldn't read that pairing code."));
    } finally {
      setBusy(false);
    }
  };

  const finishClaim = useCallback(
    (outcome: "paired" | "left") => {
      const finished = claiming;
      setClaiming(undefined);
      if (outcome === "paired") {
        setCode("");
        setErrorMessage(undefined);
        onConnected();
        return;
      }
      if (finished !== undefined) {
        void bridge
          .settlePairedComputer(finished.computer.origin, "abandoned")
          .catch(() => undefined);
      }
      resetAndClose();
    },
    [bridge, claiming, onConnected, resetAndClose],
  );

  return (
    <OctantDialog label={`Connect to ${hostName}`} onClose={resetAndClose} open={open}>
      <div className="settings-panel__stack">
        <h2>Connect to {hostName}</h2>
        <SettingsFactList
          facts={[
            { label: "Computer", value: hostName },
            { label: "Origin", value: <span className="oct-meta--mono">{origin}</span> },
            ...(expectedPin === undefined
              ? []
              : [
                  {
                    label: "Certificate pin",
                    value: <span className="oct-meta--mono">{expectedPin}</span>,
                  },
                ]),
          ]}
        />
        {claiming === undefined ? (
          <>
            <p className="settings-section-line">
              Paste the pairing code created on {hostName} (in Settings → Remote access or with{" "}
              <code>octant pair</code>). Both computers still confirm the comparison code.
            </p>
            <OctantField>
              <OctantFieldLabel htmlFor={codeId}>Pairing code</OctantFieldLabel>
              <OctantTextarea
                autoComplete="off"
                id={codeId}
                onChange={(event) => setCode(event.target.value)}
                placeholder="octant-pair-1.…"
                rows={3}
                spellCheck={false}
                value={code}
              />
            </OctantField>
            {errorMessage === undefined ? null : (
              <SettingsState kind="error">{errorMessage}</SettingsState>
            )}
            <div className="host-settings__controls">
              <OctantButton
                disabled={busy || code.trim().length === 0}
                onClick={() => void startConnect()}
                size="sm"
                type="button"
                variant="default"
              >
                Connect
              </OctantButton>
              <OctantButton onClick={resetAndClose} size="sm" type="button" variant="secondary">
                Stay watching
              </OctantButton>
            </div>
          </>
        ) : (
          <PairedComputerClaim
            bridge={bridge}
            federation={federation}
            {...(pairingClient === undefined ? {} : { client: pairingClient })}
            onFinished={finishClaim}
            pairing={claiming}
          />
        )}
      </div>
    </OctantDialog>
  );
}
