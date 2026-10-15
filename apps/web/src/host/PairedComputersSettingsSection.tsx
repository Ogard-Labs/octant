import { useCallback, useEffect, useId, useState } from "react";
import { failureMessage } from "../lib/failureMessage";
import { SettingRow, SettingsSection, SettingsState } from "../settings/primitives";
import type { PairedComputer, PairedComputersBridge } from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantField, OctantFieldLabel } from "../ui/base/OctantField";
import { OctantTextarea } from "../ui/base/OctantTextarea";

/**
 * Pairing this desktop app with another computer from the app pairing code
 * that computer shows. The pasted text goes to the main process as it is;
 * main reads it, checks that computer's key against the code's pin, and
 * opens that computer's own pairing page, where the person confirms and the
 * other computer approves.
 */
export function PairedComputersSettingsSection({
  bridge,
}: {
  readonly bridge: PairedComputersBridge;
}) {
  const codeId = useId();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    readonly kind: "success" | "error";
    readonly text: string;
  }>();
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
      setMessage({
        kind: "success",
        text: `Opened ${outcome.computer.displayName}. Confirm there, then approve on that computer when the comparison codes match.`,
      });
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

  const open = async (computer: PairedComputer) => {
    setMessage(undefined);
    try {
      const outcome = await bridge.openPairedComputer(computer.origin);
      if (outcome.status === "refused") setMessage({ kind: "error", text: outcome.message });
    } catch (error) {
      setMessage({
        kind: "error",
        text: failureMessage(error, "Octant couldn't open that computer."),
      });
    }
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
                disabled={busy || code.trim().length === 0}
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
        {computers.map((computer) => (
          <SettingRow
            description={computer.origin}
            key={computer.origin}
            label={computer.displayName}
            scope="app"
            settingId={`paired-computer-${computer.origin}`}
          >
            <div className="host-settings__controls">
              <OctantButton
                onClick={() => void open(computer)}
                size="sm"
                type="button"
                variant="secondary"
              >
                Open
              </OctantButton>
            </div>
          </SettingRow>
        ))}
      </div>
      {message === undefined ? null : (
        <SettingsState kind={message.kind}>{message.text}</SettingsState>
      )}
    </SettingsSection>
  );
}
