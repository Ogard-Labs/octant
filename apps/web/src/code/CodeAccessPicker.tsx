import type { ProviderExecutionPolicy } from "@octant/contracts";
import { useId } from "react";
import { OctantSelectField, type OctantSelectOption } from "../ui/base/OctantSelect";

export interface CodeAccessPickerProps {
  readonly disabled?: boolean;
  readonly executionPolicy: ProviderExecutionPolicy;
  /**
   * Whether this host can raise the native Full access confirmation. Without
   * it the option is offered as unavailable rather than as a choice the host
   * would refuse after the fact.
   */
  readonly nativeConfirmationAvailable: boolean;
  readonly onSelect: (executionPolicy: ProviderExecutionPolicy) => void;
}

/**
 * The thread's access posture, switchable from the composer.
 *
 * The posture is thread state the host owns, not a renderer preference: every
 * change goes through the authoritative command, and raising a thread to Full
 * access still needs the same native confirmation the host demands anywhere
 * else. This control only names what the user may ask for.
 */
export function CodeAccessPicker(props: CodeAccessPickerProps) {
  const fieldId = useId();
  const fullAccessBlocked =
    !props.nativeConfirmationAvailable && props.executionPolicy !== "full-access";
  const options: ReadonlyArray<OctantSelectOption> = [
    { id: "plan", label: "Plan · read-only" },
    { id: "approval-gated", label: "Ask for approvals" },
    { id: "auto-accept-edits", label: "Auto-accept edits" },
    {
      id: "full-access",
      label: "Full access",
      ...(fullAccessBlocked
        ? { disabled: true, disabledReason: "Full access requires native confirmation." }
        : {}),
    },
  ];
  return (
    <label className="code-thread-workspace__access" htmlFor={fieldId}>
      <span className="visually-hidden">Thread access</span>
      <OctantSelectField
        {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
        id={fieldId}
        onValueChange={(value) => {
          const next = value as ProviderExecutionPolicy;
          if (next !== props.executionPolicy) props.onSelect(next);
        }}
        options={options}
        value={props.executionPolicy}
      />
    </label>
  );
}
