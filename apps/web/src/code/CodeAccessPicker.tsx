import type { ProviderExecutionPolicy } from "@octant/contracts";
import { accessPosturesAtOrBelow } from "@octant/domain/code-policy";
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
   * The thread's grant. The next turn may sit at or below this, never above
   * it. Plan is locked: a read-only thread cannot be overridden from here.
   */
  readonly ceiling: ProviderExecutionPolicy;
  /** The posture the next turn will ask to run under. */
  readonly value: ProviderExecutionPolicy;
  readonly onSelect: (executionPolicy: ProviderExecutionPolicy) => void;
}

/**
 * The posture the next turn will run under, defaulting to the thread's.
 *
 * This control sends an intent with the message. The host clamps it to the
 * thread's grant, so a composer choice can only narrow. Plan stays read-only
 * even if something asks otherwise.
 */
export function CodeAccessPicker(props: CodeAccessPickerProps) {
  const fieldId = useId();
  const offered = accessPosturesAtOrBelow(props.ceiling);
  const options: ReadonlyArray<OctantSelectOption> = offered.map((id) => ({
    id,
    label: CODE_ACCESS_POSTURE_LABEL[id],
  }));
  const locked = props.ceiling === "plan" || props.disabled === true;
  return (
    <label className="code-thread-workspace__access" htmlFor={fieldId}>
      <span className="visually-hidden">Next turn access</span>
      <OctantSelectField
        disabled={locked}
        id={fieldId}
        onValueChange={(value) => {
          const next = value as ProviderExecutionPolicy;
          if (next !== props.value) props.onSelect(next);
        }}
        options={options}
        value={props.value}
      />
    </label>
  );
}
