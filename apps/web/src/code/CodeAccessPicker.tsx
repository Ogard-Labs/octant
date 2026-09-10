import type { ProviderExecutionPolicy } from "@octant/contracts";
import {
  ACCESS_POSTURE_RANK,
  ACCESS_POSTURES_NARROWEST_FIRST,
  accessPosturesAbove,
  accessPosturesAtOrBelow,
} from "@octant/domain/code-policy";
import { ChevronDown } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import {
  OctantMenuRoot,
  OctantMenuTrigger,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuPopup,
  OctantMenuRadioGroup,
  OctantMenuRadioItem,
  OctantMenuCheckboxItem,
  OctantMenuGroup,
  OctantMenuSeparator,
} from "../ui/base/OctantMenu";

export const CODE_ACCESS_POSTURE_LABEL: Record<ProviderExecutionPolicy, string> = {
  plan: "Plan · read-only",
  "approval-gated": "Ask for approvals",
  "auto-accept-edits": "Auto-accept edits",
  "full-access": "Full access",
};

const ACCESS_TRIGGER_LABEL: Readonly<Record<ProviderExecutionPolicy, string>> = {
  plan: "Plan",
  "approval-gated": "Ask",
  "auto-accept-edits": "Auto edits",
  "full-access": "Full access",
};

export interface CodeAccessPickerProps {
  readonly autoApprove?: {
    readonly checked: boolean;
    readonly onChange: (checked: boolean) => void;
  };
  readonly profileName?: string;
  readonly disabled?: boolean;
  /**
   * The thread's grant. The next turn may sit at or below this. Postures
   * above it raise the thread rather than running as a one-shot.
   */
  readonly ceiling: ProviderExecutionPolicy;
  /**
   * Whether this host can raise the native Full access confirmation. Without
   * it the raise is offered as unavailable rather than as a choice the host
   * would refuse after the fact.
   */
  readonly nativeConfirmationAvailable: boolean;
  /** The posture the next turn will ask to run under. */
  readonly value: ProviderExecutionPolicy;
  /** Narrow this message only. The host still clamps it to the thread. */
  readonly onSelect: (executionPolicy: ProviderExecutionPolicy) => void;
  /** Raise the durable thread grant so later turns can sit at this posture. */
  readonly onRaiseThread: (executionPolicy: ProviderExecutionPolicy) => void;
}

/**
 * The posture the next turn will run under, defaulting to the thread's.
 *
 * One-shot choices can only narrow. Choosing more than the thread grants is
 * a thread-grant raise, not a turn overlay — otherwise an approval-gated
 * thread could never reach Auto-accept edits or Full access again.
 */
export function CodeAccessPicker(props: CodeAccessPickerProps) {
  const offered = accessPosturesAtOrBelow(props.ceiling);
  const raises = accessPosturesAbove(props.ceiling);
  const options: ReadonlyArray<{
    readonly id: ProviderExecutionPolicy;
    readonly label: string;
    readonly disabled?: boolean;
    readonly disabledReason?: string;
  }> = [
    ...offered.map((id) => ({
      id,
      label: CODE_ACCESS_POSTURE_LABEL[id],
    })),
    ...raises.map((id) => ({
      id,
      label: `Raise thread · ${CODE_ACCESS_POSTURE_LABEL[id]}`,
      ...(id === "full-access" && !props.nativeConfirmationAvailable
        ? { disabled: true, disabledReason: "Full access requires native confirmation." }
        : {}),
    })),
  ];
  const reviewAvailable =
    props.autoApprove !== undefined &&
    (props.value === "approval-gated" || props.value === "auto-accept-edits");
  return (
    <OctantMenuRoot>
      <OctantMenuTrigger
        aria-label="Next turn access"
        aria-description={CODE_ACCESS_POSTURE_LABEL[props.value]}
        title={CODE_ACCESS_POSTURE_LABEL[props.value]}
        disabled={props.disabled === true}
        render={<OctantButton size="sm" variant="ghost" />}
      >
        <span>
          {reviewAvailable && props.autoApprove?.checked
            ? "Approve for me"
            : ACCESS_TRIGGER_LABEL[props.value]}
        </span>
        <ChevronDown aria-hidden="true" />
      </OctantMenuTrigger>
      <OctantMenuPortal>
        <OctantMenuPositioner side="top">
          <OctantMenuPopup>
            <OctantMenuRadioGroup
              value={props.value}
              onValueChange={(value) => {
                if (props.disabled || typeof value !== "string") return;
                const next = parseAccessPosture(value);
                if (next === undefined) return;
                if (ACCESS_POSTURE_RANK[next] > ACCESS_POSTURE_RANK[props.ceiling]) {
                  props.onRaiseThread(next);
                  return;
                }
                if (next !== props.value) props.onSelect(next);
              }}
            >
              {options.map((option) => (
                <OctantMenuRadioItem
                  closeOnClick
                  disabled={props.disabled === true || option.disabled === true}
                  key={option.id}
                  title={option.disabledReason}
                  value={option.id}
                >
                  {option.label}
                </OctantMenuRadioItem>
              ))}
            </OctantMenuRadioGroup>
            {reviewAvailable ? (
              <OctantMenuGroup>
                <OctantMenuSeparator />
                <OctantMenuCheckboxItem
                  checked={props.autoApprove?.checked === true}
                  disabled={props.disabled === true}
                  onCheckedChange={(checked) => props.autoApprove?.onChange(checked)}
                >
                  Approve for me
                </OctantMenuCheckboxItem>
              </OctantMenuGroup>
            ) : null}
            {props.profileName === undefined ? null : (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                Started under {props.profileName}
              </p>
            )}
          </OctantMenuPopup>
        </OctantMenuPositioner>
      </OctantMenuPortal>
    </OctantMenuRoot>
  );
}

function parseAccessPosture(value: string): ProviderExecutionPolicy | undefined {
  for (const posture of ACCESS_POSTURES_NARROWEST_FIRST) {
    if (posture === value) return posture;
  }
  return undefined;
}
