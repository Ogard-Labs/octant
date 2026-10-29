import { useRef, useState } from "react";
import { SettingRow, SettingsFactList, SettingsState } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantSwitch } from "../ui/base/OctantSwitch";

/** An owner as this host lists it: names and fingerprints, never keys. */
export interface OwnerRow {
  readonly memberId: string;
  readonly name: string;
  readonly identityKeyFingerprint: string;
  readonly unlockKeyFingerprint: string;
}

/** A roster member that lists an unlock key and is not on this host's owner list yet. */
export interface OwnerCandidateRow {
  readonly memberId: string;
  readonly name: string;
  readonly identityKeyFingerprint: string;
  readonly unlockKeyFingerprint: string;
}

/** An owner whose roster entry now lists a different unlock key than the one this host confirmed. */
export interface OwnerKeyMismatchRow {
  readonly memberId: string;
  readonly name: string;
  readonly heldUnlockKeyFingerprint: string;
  readonly rosterUnlockKeyFingerprint: string;
}

/** A member this host holds status-only under Confirm new members. */
export interface HeldMemberRow {
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

/**
 * This host's own owner list. Adding an owner is the person's act at this
 * window: the signed roster lists the device's unlock key, and the person
 * compares the device's name and both fingerprints with the ones on the device,
 * then confirms. The roster alone adds nobody, and a key that changed after the
 * person confirmed is only shown, never applied.
 */
export function OwnerDevices(props: {
  readonly owners: ReadonlyArray<OwnerRow>;
  readonly candidates: ReadonlyArray<OwnerCandidateRow>;
  readonly mismatches: ReadonlyArray<OwnerKeyMismatchRow>;
  readonly busy: boolean;
  readonly onAdd: (candidate: OwnerCandidateRow) => Promise<void>;
  readonly onRemove: (owner: OwnerRow) => Promise<void>;
}) {
  const [reviewing, setReviewing] = useState<OwnerCandidateRow>();
  const [removing, setRemoving] = useState<OwnerRow>();
  const reviewOpener = useRef<HTMLButtonElement>(null);
  const removeOpener = useRef<HTMLButtonElement>(null);

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
      {props.mismatches.length === 0 ? null : (
        <ul aria-label="Owners whose unlock key changed" className="setgroup">
          {props.mismatches.map((mismatch) => (
            <li className="setrow" key={mismatch.memberId}>
              <span className="setrow-label">{mismatch.name}'s unlock key changed</span>
              <p className="setrow-hint">
                The roster now lists unlock key {fingerprint(mismatch.rosterUnlockKeyFingerprint)}.
                This computer keeps the key you confirmed,{" "}
                {fingerprint(mismatch.heldUnlockKeyFingerprint)}. If the change is yours, remove{" "}
                {mismatch.name} as an owner and confirm it again.
              </p>
            </li>
          ))}
        </ul>
      )}
      {props.candidates.length === 0 ? null : (
        <>
          <p className="settings-section-line">
            The hub's roster lists these devices with an unlock key. Check that the name and both
            fingerprints match what the device shows, then add it.
          </p>
          <ul aria-label="Devices that could be owners" className="setgroup">
            {props.candidates.map((candidate) => (
              <li className="setrow" key={candidate.memberId}>
                <span className="setrow-label">{candidate.name}</span>
                <p className="setrow-hint">
                  Device key {fingerprint(candidate.identityKeyFingerprint)} · unlock key{" "}
                  {fingerprint(candidate.unlockKeyFingerprint)}
                </p>
                <div className="setrow-control">
                  <OctantButton
                    aria-label={`Add ${candidate.name} as an owner`}
                    disabled={props.busy}
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
      {reviewing === undefined ? null : (
        <OctantConfirmDialog
          cancelLabel="Not now"
          confirmLabel={`Add ${reviewing.name}`}
          details={
            <SettingsFactList
              facts={[
                { label: "Device", value: reviewing.name },
                { label: "Device key", value: fingerprint(reviewing.identityKeyFingerprint) },
                { label: "Unlock key", value: fingerprint(reviewing.unlockKeyFingerprint) },
              ]}
            />
          }
          onCancel={() => setReviewing(undefined)}
          onConfirm={() => {
            const candidate = reviewing;
            setReviewing(undefined);
            void props.onAdd(candidate);
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
  /** The members this host holds under Confirm new members; Confirm shows for these and no others. */
  readonly awaiting: ReadonlyArray<HeldMemberRow>;
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
