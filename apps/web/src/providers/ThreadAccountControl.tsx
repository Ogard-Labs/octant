import type {
  ProviderInstanceId,
  ProviderModelId,
  ThreadUsageLimitHandoff,
} from "@octant/contracts";
import { providerAccountMoveTargets, type PickerGroup } from "@octant/domain";
import { ChevronDown } from "../ui/icons";
import { useState } from "react";
import { MoveToAccountDialog } from "../chat/MoveToAccountDialog";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import { OctantMenu } from "../ui/base/OctantMenu";
import { octantButtonClassName } from "../ui/base/OctantButton";

const WAIT = "wait";

export interface ThreadAccountControlProps {
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly usageLimitHandoff: ThreadUsageLimitHandoff | undefined;
  /** Why neither choice is available now (a model pool is on); the menu shows it. */
  readonly unavailableReason?: string;
  /** Present where the thread offers Move to account here rather than elsewhere. */
  readonly onMove?: (providerInstanceId: ProviderInstanceId) => Promise<string | undefined>;
  /** Sets the opt-in to that account, or off; resolves to the host's refusal. */
  readonly onUsageLimitHandoffChange: (
    providerInstanceId: ProviderInstanceId | undefined,
  ) => Promise<string | undefined>;
  readonly disabled?: boolean;
}

/**
 * Which account the thread runs on: move it to another account of its
 * provider now, or name the one account it hands off to when this account
 * hits its usage limit. Both are the person's choices and the host decides
 * again; the line under the menu says what the opt-in last did, so a stop
 * that could not hand off is never silent.
 */
export function ThreadAccountControl(props: ThreadAccountControlProps) {
  const [moveOpen, setMoveOpen] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const targets = providerAccountMoveTargets(props.groups, {
    providerInstanceId: props.providerInstanceId,
    modelId: props.modelId,
  });
  const nameOf = (id: ProviderInstanceId | undefined) =>
    props.groups.find((group) => String(group.instance.id) === String(id))?.instance.displayName ??
    "another account";
  const chosen = props.usageLimitHandoff?.providerInstanceId;
  if (targets.length === 0 && chosen === undefined) return null;
  // A chosen account no longer offered stays listed so the person can see and clear it.
  const handoffTargets = [
    ...targets.map((group) => ({ id: group.instance.id, name: group.instance.displayName })),
    ...(chosen === undefined ||
    targets.some((group) => String(group.instance.id) === String(chosen))
      ? []
      : [{ id: chosen, name: nameOf(chosen) }]),
  ];
  const last = props.usageLimitHandoff?.last;
  const lastLine =
    last === undefined
      ? undefined
      : last.kind === "handed-off"
        ? `${nameOf(last.fromProviderInstanceId)} hit its usage limit; handed off to ${nameOf(last.toProviderInstanceId)}.`
        : `${nameOf(last.fromProviderInstanceId)} hit its usage limit; did not hand off to ${nameOf(last.toProviderInstanceId)}. ${last.detail ?? ""}`.trim();

  async function changeHandoff(value: string) {
    const target = handoffTargets.find((candidate) => String(candidate.id) === value)?.id;
    if (value !== WAIT && target === undefined) return;
    setRefusal(undefined);
    try {
      setRefusal(await props.onUsageLimitHandoffChange(value === WAIT ? undefined : target));
    } catch (error) {
      setRefusal(refusalOf(error, "The choice could not be saved. Nothing changed."));
    }
  }

  return (
    <>
      <OctantMenu
        items={[
          {
            value: WAIT,
            label: "Wait for the reset",
            description: "When this account hits its usage limit",
          },
          ...handoffTargets.map((target) => ({
            value: String(target.id),
            label: `Hand off to ${target.name}`,
            description:
              props.unavailableReason ?? "When this account hits its usage limit, once per limit",
            ...(props.unavailableReason === undefined ? {} : { disabled: true }),
          })),
        ]}
        {...(props.onMove === undefined || targets.length === 0
          ? {}
          : {
              actions: [
                {
                  label: "Move to account…",
                  onSelect: () => setMoveOpen(true),
                  ...(props.unavailableReason === undefined ? {} : { disabled: true }),
                },
              ],
            })}
        onValueChange={(value) => void changeHandoff(value)}
        trigger={
          <>
            <span>On usage limit</span>
            <span className="thread-info__value">
              {chosen === undefined ? "Wait" : nameOf(chosen)}
            </span>
            <ChevronDown aria-hidden="true" size={12} />
          </>
        }
        triggerClassName={octantButtonClassName({ variant: "ghost", size: "sm" })}
        triggerDisabled={props.disabled === true}
        triggerLabel="This thread's account"
        value={chosen === undefined ? WAIT : String(chosen)}
      />
      {refusal === undefined ? null : <OctantAlert tone="warning">{refusal}</OctantAlert>}
      {lastLine === undefined ? null : (
        <p className="text-xs text-muted-foreground" role="status">
          {lastLine}
        </p>
      )}
      <OctantDialogPresence>
        {moveOpen && props.onMove !== undefined ? (
          <MoveToAccountDialog
            accounts={targets.map((group) => ({
              id: group.instance.id,
              name: group.instance.displayName,
            }))}
            onClose={() => setMoveOpen(false)}
            onMove={async (providerInstanceId) => {
              try {
                return await props.onMove?.(providerInstanceId);
              } catch (error) {
                return refusalOf(error, "The conversation could not be moved. Nothing changed.");
              }
            }}
          />
        ) : null}
      </OctantDialogPresence>
    </>
  );
}

/** The host's own refusal sentence when the client carried one. */
function refusalOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}
