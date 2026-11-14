import type { ModelPickerSelection, PickerGroup } from "@octant/domain";
import { X } from "lucide-react";
import { useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { isConstrained, roomOf } from "./providerRoom";
import { resetPhrase } from "./railUsageReading";
import { useProviderRooms } from "./useProviderRooms";

/** Enough to choose from without crowding the composer. */
const MAX_ALTERNATIVES = 3;

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

/** The first model of a group the person could pick, preferring the one already chosen. */
function selectionIn(
  group: PickerGroup,
  preferredModelId: string | undefined,
): ModelPickerSelection | undefined {
  const models = group.sections.flatMap((section) => section.models);
  const usable = models.filter((entry) => entry.unavailableReason === undefined);
  const pick = usable.find((entry) => String(entry.model.id) === preferredModelId) ?? usable[0];
  return pick === undefined
    ? undefined
    : { providerInstanceId: group.instance.id, modelId: pick.model.id };
}

/**
 * Warns above a new thread's composer when the chosen account has reached, or
 * nearly reached, the plan limit the host last observed, with the reset time
 * and a button for each other signed-in account that has room. Choosing one is
 * the person's act: nothing switches on its own, and the warning never blocks
 * sending, because the provider's own limit stays the authority on whether a
 * turn runs. Nothing renders without an observed limit. Close to the limit is
 * amber, at the limit red, and the person can put either away.
 */
export function ComposerUsageWarning(props: {
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly selectedProviderInstanceId: string | undefined;
  readonly selectedModelId?: string | undefined;
  readonly onSelect: (selection: ModelPickerSelection) => void | Promise<void>;
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
  const name = current?.instance.displayName ?? "This account";
  const reset = resetPhrase(room.resetsAt, Date.now());
  const alternatives = props.groups
    .filter(
      (group) =>
        String(group.instance.id) !== selectedProviderInstanceId &&
        group.readiness === "ready" &&
        roomOf(rooms, String(group.instance.id)).standing === "room",
    )
    .flatMap((group) => {
      const selection = selectionIn(group, props.selectedModelId);
      return selection === undefined ? [] : [{ group, selection }];
    })
    .slice(0, MAX_ALTERNATIVES);
  const limited = room.standing === "limited";
  return (
    <div className="composer-usage-warning-row">
      <OctantAlert
        action={
          <>
            {alternatives.map(({ group, selection }) => (
              <OctantButton
                key={String(group.instance.id)}
                onClick={() => void props.onSelect(selection)}
                size="sm"
                type="button"
                variant="secondary"
              >
                {`Use ${group.instance.displayName}`}
              </OctantButton>
            ))}
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
          </>
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
