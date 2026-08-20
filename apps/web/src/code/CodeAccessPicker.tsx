import type { ProviderExecutionPolicy } from "@octant/contracts";
import {
  ACCESS_POSTURE_RANK,
  ACCESS_POSTURES_NARROWEST_FIRST,
  accessPosturesAbove,
  accessPosturesAtOrBelow,
} from "@octant/domain/code-policy";
import { useId } from "react";
import { OctantSelectField, type OctantSelectOption } from "../ui/base/OctantSelect";

export const CODE_ACCESS_POSTURE_LABEL: Record<ProviderExecutionPolicy, string> = {
  plan: "Plan · read-only",
  "approval-gated": "Ask for approvals",
  "auto-accept-edits": "Auto-accept edits",
  "full-access": "Full access",
};

export interface CodeAccessPickerProps {
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
  const fieldId = useId();
  const offered = accessPosturesAtOrBelow(props.ceiling);
  const raises = accessPosturesAbove(props.ceiling);
  const options: ReadonlyArray<OctantSelectOption> = [
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
  return (
    <label className="code-thread-workspace__access" htmlFor={fieldId}>
      <span className="visually-hidden">Next turn access</span>
      <OctantSelectField
        disabled={props.disabled === true}
        id={fieldId}
        onValueChange={(value) => {
          const next = parseAccessPosture(value);
          if (next === undefined) return;
          if (ACCESS_POSTURE_RANK[next] > ACCESS_POSTURE_RANK[props.ceiling]) {
            props.onRaiseThread(next);
            return;
          }
          if (next !== props.value) props.onSelect(next);
        }}
        options={options}
        value={props.value}
      />
    </label>
  );
}

function parseAccessPosture(value: string): ProviderExecutionPolicy | undefined {
  for (const posture of ACCESS_POSTURES_NARROWEST_FIRST) {
    if (posture === value) return posture;
  }
  return undefined;
}
