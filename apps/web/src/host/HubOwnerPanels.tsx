import { unlockKeyFingerprint } from "@octant/client-runtime";
import { useEffect, useId, useRef, useState } from "react";
import { SettingRow, SettingsFactList, SettingsState } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantField, OctantFieldLabel } from "../ui/base/OctantField";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantTextarea } from "../ui/base/OctantTextarea";

/** An owner as this host lists it: names and fingerprints, never keys. */
export interface OwnerRow {
  readonly memberId: string;
  readonly name: string;
  readonly identityKeyFingerprint: string;
  readonly unlockKeyFingerprint: string;
}

/** A roster member that could be added to this host's owner list. */
export interface OwnerCandidateRow {
  readonly memberId: string;
  readonly name: string;
  readonly identityKeyFingerprint: string;
}

export interface NewMemberAlertRow {
  readonly alertId: string;
  readonly memberId: string;
  readonly name: string;
  readonly role: string;
  readonly identityKeyFingerprint: string;
}

const fingerprint = (value: string) => <code className="oct-meta--mono">{value}</code>;

/** The unlock key text's fingerprint, or undefined while the text is not a key code. */
function useUnlockKeyFingerprint(text: string): string | undefined {
  const [value, setValue] = useState<string>();
  useEffect(() => {
    let current = true;
    const trimmed = text.trim();
    if (!/^[A-Za-z0-9_-]{16,512}$/.test(trimmed)) {
      setValue(undefined);
      return;
    }
    unlockKeyFingerprint(trimmed).then(
      (digest) => {
        if (current) setValue(digest);
      },
      () => {
        if (current) setValue(undefined);
      },
    );
    return () => {
      current = false;
    };
  }, [text]);
  return value;
}

/**
 * This host's own owner list. Adding an owner is the person's act at this
 * window: they compare the device's name and the fingerprints this window shows
 * with the ones on the device, then confirm. No owner is added from the hub's
 * roster mark alone.
 */
export function OwnerDevices(props: {
  readonly owners: ReadonlyArray<OwnerRow>;
  readonly candidates: ReadonlyArray<OwnerCandidateRow>;
  readonly busy: boolean;
  readonly onAdd: (candidate: OwnerCandidateRow, unlockPublicKey: string) => Promise<void>;
  readonly onRemove: (owner: OwnerRow) => Promise<void>;
}) {
  const [reviewing, setReviewing] = useState<OwnerCandidateRow>();
  const [removing, setRemoving] = useState<OwnerRow>();
  const [keyText, setKeyText] = useState("");
  const keyId = useId();
  const reviewOpener = useRef<HTMLButtonElement>(null);
  const removeOpener = useRef<HTMLButtonElement>(null);
  const keyFingerprint = useUnlockKeyFingerprint(keyText);

  return (
    <div className="settings-panel__stack">
      {props.owners.length === 0 ? (
        <SettingsState kind="empty">No device is an owner of this computer yet.</SettingsState>
      ) : (
        <ul aria-label="Owner devices" className="setgroup">
          {props.owners.map((owner) => (
            <li className="setrow" key={owner.memberId}>
              <span className="setrow-label">{owner.name}</span>
              <p className="setrow-hint">
                Device key {fingerprint(owner.identityKeyFingerprint)} · unlock key{" "}
                {fingerprint(owner.unlockKeyFingerprint)}
              </p>
              <div className="setrow-control">
                <OctantButton
                  aria-label={`Remove ${owner.name} as an owner`}
                  disabled={props.busy}
                  onClick={() => setRemoving(owner)}
                  ref={removing?.memberId === owner.memberId ? removeOpener : undefined}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Remove…
                </OctantButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      {props.candidates.length === 0 ? null : (
        <>
          <OctantField>
            <OctantFieldLabel htmlFor={keyId}>Unlock key from the device</OctantFieldLabel>
            <OctantTextarea
              autoComplete="off"
              id={keyId}
              onChange={(event) => setKeyText(event.target.value)}
              rows={2}
              spellCheck={false}
              value={keyText}
            />
          </OctantField>
          <p className="settings-section-line">
            The device shows its unlock key and the fingerprint of it. Paste the key here, choose
            the device, and check that both fingerprints match what the device shows.
          </p>
          <ul aria-label="Devices that could be owners" className="setgroup">
            {props.candidates.map((candidate) => (
              <li className="setrow" key={candidate.memberId}>
                <span className="setrow-label">{candidate.name}</span>
                <p className="setrow-hint">
                  Device key {fingerprint(candidate.identityKeyFingerprint)}
                </p>
                <div className="setrow-control">
                  <OctantButton
                    aria-label={`Add ${candidate.name} as an owner`}
                    disabled={props.busy || keyFingerprint === undefined}
                    onClick={() => setReviewing(candidate)}
                    ref={reviewing?.memberId === candidate.memberId ? reviewOpener : undefined}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Add…
                  </OctantButton>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {reviewing === undefined || keyFingerprint === undefined ? null : (
        <OctantConfirmDialog
          cancelLabel="Not now"
          confirmLabel={`Add ${reviewing.name}`}
          details={
            <SettingsFactList
              facts={[
                { label: "Device", value: reviewing.name },
                { label: "Device key", value: fingerprint(reviewing.identityKeyFingerprint) },
                { label: "Unlock key", value: fingerprint(keyFingerprint) },
              ]}
            />
          }
          onCancel={() => setReviewing(undefined)}
          onConfirm={() => {
            const candidate = reviewing;
            setReviewing(undefined);
            void props.onAdd(candidate, keyText.trim()).then(() => setKeyText(""));
          }}
          restoreFocus={reviewOpener}
          title={`Add ${reviewing.name} as an owner of this computer?`}
        >
          With a fresh unlock, an owner device can do here what you could do at this window. Add it
          only if both fingerprints match the ones on the device.
        </OctantConfirmDialog>
      )}
      {removing === undefined ? null : (
        <OctantConfirmDialog
          cancelLabel="Keep it"
          confirmLabel={`Remove ${removing.name}`}
          destructive
          onCancel={() => setRemoving(undefined)}
          onConfirm={() => {
            const owner = removing;
            setRemoving(undefined);
            void props.onRemove(owner);
          }}
          restoreFocus={removeOpener}
          title={`Remove ${removing.name} as an owner of this computer?`}
        >
          It stays a member of the hub but can no longer act here with an unlock.
        </OctantConfirmDialog>
      )}
    </div>
  );
}

/** Confirm new members, the members held for it, and the alerts newer rosters raised. */
export function NewMemberChecks(props: {
  readonly confirmNewMembers: boolean;
  readonly awaiting: ReadonlyArray<OwnerCandidateRow>;
  readonly alerts: ReadonlyArray<NewMemberAlertRow>;
  readonly busy: boolean;
  readonly onSetConfirmNewMembers: (enabled: boolean) => void;
  readonly onConfirm: (memberId: string, name: string) => void;
  readonly onDismiss: (alert: NewMemberAlertRow) => void;
  readonly onRemove: (alert: NewMemberAlertRow) => void;
}) {
  const awaitingIds = new Set(props.awaiting.map((member) => member.memberId));
  return (
    <div className="settings-panel__stack">
      <div className="setgroup">
        <SettingRow
          description="A member the hub adds later stays status-only here until you confirm it in this window or on an owner device. Off by default."
          label="Confirm new members"
          scope="host"
          settingId="hub-confirm-new-members"
        >
          <OctantSwitch
            checked={props.confirmNewMembers}
            disabled={props.busy}
            label="Confirm new members"
            onCheckedChange={props.onSetConfirmNewMembers}
          />
        </SettingRow>
      </div>
      {props.awaiting.length === 0 ? null : (
        <ul aria-label="Members waiting for confirmation" className="setgroup">
          {props.awaiting.map((member) => (
            <li className="setrow" key={member.memberId}>
              <span className="setrow-label">{member.name}</span>
              <p className="setrow-hint">
                Waiting for confirmation · device key {fingerprint(member.identityKeyFingerprint)}
              </p>
              <div className="setrow-control">
                <OctantButton
                  aria-label={`Confirm ${member.name}`}
                  disabled={props.busy}
                  onClick={() => props.onConfirm(member.memberId, member.name)}
                  size="sm"
                  type="button"
                  variant="default"
                >
                  Confirm
                </OctantButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      {props.alerts.length === 0 ? null : (
        <ul aria-label="New member alerts" className="setgroup">
          {props.alerts.map((alert) => (
            <li className="setrow" key={alert.alertId}>
              <span className="setrow-label">{alert.name} joined the hub</span>
              <p className="setrow-hint">
                {alert.role} · device key {fingerprint(alert.identityKeyFingerprint)}. If you did
                not add it, choose Remove, then check the hub.
              </p>
              <div className="setrow-control">
                <OctantButton
                  aria-label={`Remove ${alert.name} from this computer`}
                  disabled={props.busy}
                  onClick={() => props.onRemove(alert)}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Remove
                </OctantButton>
                {awaitingIds.has(alert.memberId) ? (
                  <OctantButton
                    aria-label={`Confirm ${alert.name} from the alert`}
                    disabled={props.busy}
                    onClick={() => props.onConfirm(alert.memberId, alert.name)}
                    size="sm"
                    type="button"
                    variant="default"
                  >
                    Confirm
                  </OctantButton>
                ) : null}
                <OctantButton
                  aria-label={`Dismiss the alert about ${alert.name}`}
                  disabled={props.busy}
                  onClick={() => props.onDismiss(alert)}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Dismiss
                </OctantButton>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
