import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { RemotePairingClient } from "@octant/client-runtime";
import { failureMessage } from "../lib/failureMessage";
import { SettingRow, SettingsSection, SettingsState } from "../settings/primitives";
import type { PairedComputer, PairedComputersBridge } from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantField, OctantFieldLabel } from "../ui/base/OctantField";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { PairedComputerClaim, type PairedComputerPairing } from "./PairedComputerClaim";
import { useHostFederationStack } from "./useHostFederationLifecycle";

/**
 * Pairing this desktop app with another computer from the app pairing code
 * that computer shows. The pasted text goes to the main process as it is;
 * main reads it, checks that computer's key against the code's pin, and
 * hands back the ticket. This window claims it with its own device key, the
 * person compares the codes and approves on the other computer, and the
 * computer joins the Environments filter like any other host.
 */
export function PairedComputersSettingsSection({
  bridge,
  pairingClient,
}: {
  readonly bridge: PairedComputersBridge;
  /** Replaces the transport-backed pairing client; only tests do. */
  readonly pairingClient?: RemotePairingClient;
}) {
  const federation = useHostFederationStack();
  const codeId = useId();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    readonly kind: "success" | "error";
    readonly text: string;
  }>();
  const [forgetting, setForgetting] = useState<PairedComputer>();
  const [claiming, setClaiming] = useState<PairedComputerPairing>();
  // The lifecycle changes in place; reading it through the store keeps each
  // row's connection note current without a poll.
  const connected = useSyncExternalStore(
    (listener) => federation?.lifecycle.subscribe(listener) ?? (() => {}),
    () => federation?.lifecycle.list(),
    () => federation?.lifecycle.list(),
  );
  const forgetOpener = useRef<HTMLElement | null>(null);
  const [computers, setComputers] = useState<ReadonlyArray<PairedComputer>>([]);

  const refresh = useCallback(async () => {
    try {
      setComputers(await bridge.listPairedComputers());
    } catch (error) {
      setMessage({
        kind: "error",
        text: failureMessage(error, "Octant couldn't list paired computers."),
      });
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pair = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const outcome = await bridge.pairWithPairingCode(code);
      if (outcome.status === "refused") {
        setMessage({ kind: "error", text: outcome.message });
        return;
      }
      setCode("");
      setClaiming({ computer: outcome.computer, ticket: outcome.ticket, pin: outcome.pin });
      await refresh();
    } catch (error) {
      setMessage({
        kind: "error",
        text: failureMessage(error, "Octant couldn't read that pairing code."),
      });
    } finally {
      setBusy(false);
    }
  };

  const finishClaim = useCallback(
    (outcome: "paired" | "left") => {
      const finished = claiming;
      setClaiming(undefined);
      if (finished === undefined) return;
      if (outcome === "paired") {
        setMessage({ kind: "success", text: `Paired ${finished.computer.displayName}.` });
        void refresh();
        return;
      }
      // Leaving before the host approved keeps nothing: the pin goes, so that
      // computer cannot be reached from this app until it is paired again.
      void bridge.forgetPairedComputer(finished.computer.origin).finally(() => void refresh());
    },
    [bridge, claiming, refresh],
  );

  const forget = async (computer: PairedComputer) => {
    setForgetting(undefined);
    setMessage(undefined);
    try {
      // The record and device key this window holds go first, and that removal
      // asks main to drop the pin; a computer with a pin but no record here
      // (an interrupted pairing) is forgotten directly.
      const registered = (await federation?.registry.list())?.find(
        (host) => host.kind === "remote" && host.origin === computer.origin,
      );
      let warning: string | undefined;
      if (federation !== undefined && registered !== undefined) {
        warning = (await federation.lifecycle.removeLocal(registered.hostId)).warning;
      }
      const stillPinned = (await bridge.listPairedComputers()).some(
        (entry) => entry.origin === computer.origin,
      );
      if (stillPinned) {
        const outcome = await bridge.forgetPairedComputer(computer.origin);
        if (outcome.status === "refused") {
          setMessage({ kind: "error", text: outcome.message });
          return;
        }
        warning ??= outcome.warning;
      }
      setMessage(
        warning === undefined
          ? { kind: "success", text: `Forgot ${computer.displayName}.` }
          : { kind: "error", text: warning },
      );
    } catch (error) {
      setMessage({
        kind: "error",
        text: failureMessage(error, "Octant couldn't forget that computer."),
      });
    } finally {
      await refresh();
    }
  };

  const connectionNote = (computer: PairedComputer): string => {
    const host = connected?.find((entry) => entry.origin === computer.origin);
    if (host === undefined) return "Not connected in this window. Forget it and pair again.";
    return host.state === "ready" ? "Connected" : "Not connected right now";
  };

  return (
    <SettingsSection title="Other computers">
      <div className="setgroup">
        <SettingRow
          description="On the other computer, create a pairing code in Settings → Remote access or with octant pair, then paste the whole code here. Octant checks that computer's own certificate key against the code before it sends anything."
          label="Pair with another computer"
          scope="app"
          settingId="paired-computers-code"
        >
          <div className="settings-panel__stack">
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
            <div className="host-settings__controls">
              <OctantButton
                disabled={
                  busy ||
                  claiming !== undefined ||
                  federation === undefined ||
                  code.trim().length === 0
                }
                onClick={() => void pair()}
                size="sm"
                type="button"
                variant="secondary"
              >
                Pair
              </OctantButton>
            </div>
          </div>
        </SettingRow>
        {claiming === undefined || federation === undefined ? null : (
          <SettingRow
            description="Compare the code below with the one that computer shows, then approve there."
            label={`Pairing ${claiming.computer.displayName}`}
            scope="app"
            settingId="paired-computers-claim"
          >
            <PairedComputerClaim
              bridge={bridge}
              federation={federation}
              {...(pairingClient === undefined ? {} : { client: pairingClient })}
              onFinished={finishClaim}
              pairing={claiming}
            />
          </SettingRow>
        )}
        {computers.map((computer) => (
          <SettingRow
            description={`${computer.origin} · ${connectionNote(computer)}`}
            key={computer.origin}
            label={computer.displayName}
            scope="app"
            settingId={`paired-computer-${computer.origin}`}
          >
            <div className="host-settings__controls">
              <OctantButton
                aria-haspopup="dialog"
                aria-label={`Forget ${computer.displayName}`}
                onClick={(event) => {
                  forgetOpener.current = event.currentTarget;
                  setForgetting(computer);
                }}
                size="sm"
                type="button"
                variant="secondary"
              >
                Forget…
              </OctantButton>
            </div>
          </SettingRow>
        ))}
      </div>
      {forgetting === undefined ? null : (
        <OctantConfirmDialog
          cancelLabel="Keep it"
          confirmLabel="Forget computer"
          destructive
          onCancel={() => setForgetting(undefined)}
          onConfirm={() => void forget(forgetting)}
          restoreFocus={forgetOpener}
          title={`Forget ${forgetting.displayName}?`}
        >
          Octant removes this app's saved key for it, closes the pages of its servers opened here,
          and stops reaching it. To pair again, make a new pairing code on that computer. That
          computer keeps listing this device until you revoke it there.
        </OctantConfirmDialog>
      )}
      {message === undefined ? null : (
        <SettingsState kind={message.kind}>{message.text}</SettingsState>
      )}
    </SettingsSection>
  );
}
