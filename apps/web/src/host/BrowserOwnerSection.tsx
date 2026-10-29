import {
  ownerActionNotice,
  readOwnerAlerts,
  runOwnerAlertAction,
  type OwnerActionNotice,
  type OwnerAlertAction,
  type OwnerAlertReading,
  type OwnerAlertRow,
  type OwnerSpoke,
} from "@octant/client-runtime";
import { useCallback, useEffect, useState } from "react";
import { SettingsFactList, SettingsSection, SettingsState } from "../settings/primitives";
import type { HubAdministrationBridge } from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { browserOwnerOffered, type PasskeyCredentials } from "./ownerPasskey";

export interface BrowserOwnerSectionProps {
  /** Present only in a desktop window, which already has the host's authority and so gets no passkey unlock. */
  readonly hubAdministration: HubAdministrationBridge | undefined;
  /** One owner client per computer this browser joined as an owner of; each signs with its passkey. */
  readonly spokes: ReadonlyArray<OwnerSpoke>;
  readonly credentials: PasskeyCredentials | undefined;
}

const DONE: Readonly<Record<OwnerAlertAction, string>> = {
  confirm: "Confirmed.",
  remove: "Removed from that computer. Check the hub too.",
  dismiss: "Dismissed.",
};

/**
 * New-member alerts for a browser that joined the hub as an owner. Each action
 * asks for the passkey first. Confirm appears only for a member the computer
 * holds under Confirm new members, and asks for the passkey twice: once to
 * answer the confirmation, once to answer the action that carries it.
 */
export function BrowserOwnerSection(props: BrowserOwnerSectionProps) {
  const offered = browserOwnerOffered({
    hubAdministration: props.hubAdministration,
    joinedAsOwner: props.spokes.length > 0,
    credentials: props.credentials,
  });
  const [reading, setReading] = useState<OwnerAlertReading>();
  const [notice, setNotice] = useState<OwnerActionNotice>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setReading(await readOwnerAlerts(props.spokes));
  }, [props.spokes]);

  useEffect(() => {
    if (offered) void load();
  }, [offered, load]);

  if (!offered) return null;

  const act = async (row: OwnerAlertRow, action: OwnerAlertAction) => {
    const spoke = props.spokes.find((entry) => entry.memberId === row.spoke.memberId);
    if (spoke === undefined) return;
    setBusy(true);
    setNotice(undefined);
    setNotice(ownerActionNotice(await runOwnerAlertAction(spoke, row, action), DONE[action]));
    setBusy(false);
    await load();
  };

  return (
    <SettingsSection title="Owner alerts">
      {notice === undefined ? null : (
        <SettingsState kind={notice.tone === "done" ? "success" : "error"}>
          {notice.message}
        </SettingsState>
      )}
      {reading === undefined || reading.unanswered.length === 0 ? null : (
        <SettingsState kind="empty">
          Couldn't read alerts from {reading.unanswered.join(", ")}. This browser may not be an
          owner there yet, or that computer is out of reach.
        </SettingsState>
      )}
      {reading === undefined || reading.rows.length === 0 ? (
        <SettingsState kind="empty">No new members to look at.</SettingsState>
      ) : (
        <ul aria-label="New member alerts" className="setgroup">
          {reading.rows.map((row) => (
            <li className="setrow" key={`${row.spoke.memberId}:${String(row.member.memberId)}`}>
              <span className="setrow-label">
                {row.member.name} joined {row.spoke.name}
              </span>
              <SettingsFactList
                facts={[
                  {
                    label: "Device key",
                    value: (
                      <code className="oct-meta--mono">{row.member.identityKeyFingerprint}</code>
                    ),
                  },
                ]}
              />
              <div className="setrow-control">
                {row.spoke.openAt === undefined ? null : (
                  // A passkey belongs to one origin, so acting happens on that computer's own web app.
                  <a href={row.spoke.openAt} rel="noopener noreferrer" target="_blank">
                    Open {row.spoke.name} to act
                  </a>
                )}
                {(["remove", "confirm", "dismiss"] as const)
                  .filter(() => row.spoke.openAt === undefined)
                  .filter((action) => (action === "confirm" ? row.held : row.alert !== undefined))
                  .map((action) => (
                    <OctantButton
                      aria-label={`${action === "remove" ? "Remove" : action === "confirm" ? "Confirm" : "Dismiss"} ${row.member.name}`}
                      disabled={busy}
                      key={action}
                      onClick={() => void act(row, action)}
                      size="sm"
                      type="button"
                      variant={action === "confirm" ? "default" : "secondary"}
                    >
                      {action === "remove"
                        ? "Remove"
                        : action === "confirm"
                          ? "Confirm"
                          : "Dismiss"}
                    </OctantButton>
                  ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="settings-section-line">
        Every action asks for your passkey first. Unlock once per action.
      </p>
    </SettingsSection>
  );
}
