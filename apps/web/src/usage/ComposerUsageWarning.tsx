import type { PickerGroup } from "@octant/domain";
import { X } from "lucide-react";
import { useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { isConstrained, roomOf } from "./providerRoom";
import { resetPhrase } from "./railUsageReading";
import { useProviderRooms } from "./useProviderRooms";

/**
 * Warnings the person put away in this window, by account and standing, each
 * until the reset time it showed. A dismissed warning stays away across threads
 * until that time passes or it gets worse (close to the limit becomes at the
 * limit), since either is news the person has not seen yet. The reset time is
 * an expiry, not part of the key: a provider that reports its reset as a
 * countdown gives a slightly different time on every reading.
 */
const dismissedUntil = new Map<string, number | undefined>();

function isDismissed(key: string, now: number): boolean {
  if (!dismissedUntil.has(key)) return false;
  const until = dismissedUntil.get(key);
  return until === undefined || now < until;
}

/**
 * The account's name as a person says it in a sentence. Accounts saved before
 * the default names dropped "CLI" still carry the suffix, so it is trimmed.
 */
function spokenName(displayName: string): string {
  return displayName.replace(/ CLI$/, "");
}

/**
 * Warns above a new thread's composer when the chosen account has reached, or
 * nearly reached, the plan limit the host last observed, with the reset time.
 * It only tells: it offers no other account, so which one runs is never a
 * click away from the warning, and it never blocks sending, because the
 * provider's own limit stays the authority on whether a turn runs. Nothing
 * renders without an observed limit. Close to the limit is amber, at the limit
 * red, and the person can put either away.
 */
export function ComposerUsageWarning(props: {
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly selectedProviderInstanceId: string | undefined;
}) {
  const rooms = useProviderRooms();
  const [, setDismissals] = useState(0);
  const { selectedProviderInstanceId } = props;
  if (selectedProviderInstanceId === undefined) return null;
  const room = roomOf(rooms, selectedProviderInstanceId);
  if (!isConstrained(room)) return null;
  const dismissalKey = `${selectedProviderInstanceId}|${room.standing}`;
  if (isDismissed(dismissalKey, Date.now())) return null;
  const current = props.groups.find(
    (group) => String(group.instance.id) === selectedProviderInstanceId,
  );
  const name = current === undefined ? "This account" : spokenName(current.instance.displayName);
  const reset = resetPhrase(room.resetsAt, Date.now());
  const limited = room.standing === "limited";
  return (
    <div className="composer-usage-warning-row">
      <OctantAlert
        action={
          <OctantButton
            aria-label="Dismiss"
            onClick={() => {
              const until = room.resetsAt === undefined ? Number.NaN : Date.parse(room.resetsAt);
              dismissedUntil.set(dismissalKey, Number.isNaN(until) ? undefined : until);
              setDismissals((count) => count + 1);
            }}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" size={12} />
          </OctantButton>
        }
        className="composer-usage-warning"
        tone={limited ? "danger" : "warning"}
      >
        <p>
          {limited
            ? `${name} has reached its usage limit.`
            : `${name} is close to its usage limit.`}
          {reset === undefined ? null : <span className="callout__second">{` ${reset}.`}</span>}
        </p>
      </OctantAlert>
    </div>
  );
}
