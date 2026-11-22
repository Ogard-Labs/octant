import type { AccessActivityClient } from "@octant/client-runtime/access-activity-client";
import type {
  AccessActivityEntry,
  AccessActivityList as AccessActivityListValue,
  AccessChangeActor,
} from "@octant/contracts/access-activity";
import { DEVICE_ACCESS_LEVEL_LABELS } from "@octant/contracts/remote-access";
import { useCallback, useEffect, useState } from "react";
import { relativeTimeLabel } from "../lib/relativeTime";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { SettingsState } from "../settings/primitives";

/** A fallback for a surface without the change feed; the feed refreshes it at once. */
const REFRESH_MS = 60_000;

export interface AccessActivityListProps {
  readonly client: AccessActivityClient;
  /** Advances when the host journals a device added, removed or re-levelled. */
  readonly changeRevision?: number;
}

/**
 * Devices added, removed and re-levelled on this computer, newest first, each
 * with who did it (maintainer decision, 2026-11-22). A list a person reads,
 * not acts on: revoking and levels stay with Paired devices.
 */
export function AccessActivityList(props: AccessActivityListProps) {
  const { client, changeRevision } = props;
  const [list, setList] = useState<AccessActivityListValue>();
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    const read = await client.readActivity();
    // A failed read keeps what is shown rather than emptying the list.
    if (read === undefined) setFailed(true);
    else {
      setList(read);
      setFailed(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh, changeRevision]);
  useEffect(() => scheduleVisibleInterval(() => void refresh(), REFRESH_MS), [refresh]);

  if (list === undefined) {
    return failed ? (
      <SettingsState kind="error">Access activity could not be read.</SettingsState>
    ) : (
      <SettingsState kind="loading">Reading access activity…</SettingsState>
    );
  }
  if (list.entries.length === 0) {
    return <SettingsState kind="empty">No devices added, removed or re-levelled yet</SettingsState>;
  }
  return (
    <ul aria-label="Access activity" className="setgroup">
      {list.entries.map((entry) => (
        <li className="setrow" key={entry.entryId}>
          <span className="setrow-label">{describeEntry(entry)}</span>
          <p className="setrow-hint">
            {actorPhrase(entry.actor)} ·{" "}
            <time dateTime={entry.at}>{relativeTimeLabel(entry.at)}</time>
          </p>
        </li>
      ))}
    </ul>
  );
}

function describeEntry(entry: AccessActivityEntry): string {
  switch (entry.kind) {
    case "added":
      return `${entry.deviceLabel} added at ${DEVICE_ACCESS_LEVEL_LABELS[entry.accessLevel]}`;
    case "relevelled":
      return `${entry.deviceLabel} changed from ${DEVICE_ACCESS_LEVEL_LABELS[entry.previousLevel]} to ${DEVICE_ACCESS_LEVEL_LABELS[entry.accessLevel]}`;
    case "removed":
      return `${entry.deviceLabel} ${REMOVAL_WORDS[entry.reason]}`;
  }
}

const REMOVAL_WORDS: Readonly<
  Record<Extract<AccessActivityEntry, { kind: "removed" }>["reason"], string>
> = {
  revoked: "removed",
  "signed-out": "signed out with every other device",
  "self-revoked": "removed itself",
  expired: "pairing expired",
  "host-key-recovered": "removed when this computer's key was recovered",
};

/** Who made a change, in the words a row's meta line uses. */
export function actorPhrase(actor: AccessChangeActor): string {
  switch (actor.kind) {
    case "local-person":
      return "By you on this computer";
    case "host":
      return "By this computer";
    case "owner-device":
      return "By an owner device";
    case "device":
      return `By ${actor.label}`;
    case "agent":
      return `By the agent ${actor.name}`;
  }
}
