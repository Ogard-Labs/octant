import type { PermissionMode } from "@octant/contracts/providers";
import { AUTO_UNSUPPORTED_REASON } from "@octant/domain/guardrail-policy";
import { useId } from "react";
import { useFullAccessWarning } from "../code/FullAccessWarning";
import { PERMISSION_MODE_OPTIONS } from "../code/PermissionModePicker";
import { OctantRadioGroup, OctantRadioGroupItem } from "../ui/base/OctantRadioGroup";

export interface FirstRunModeStepProps {
  /** Whether the provider new tasks start with has a reviewer of its own. */
  readonly autoSupported: boolean;
  readonly value: PermissionMode;
  readonly onSelect: (mode: PermissionMode) => void;
}

/**
 * The one question first run asks about guardrails: which mode new threads
 * start in. Auto is pre-selected and marked Recommended where the provider
 * has a reviewer; elsewhere Ask first is, and Auto says why it is not
 * offered. Full access is a choice, never the default, and the first pick
 * of it warns.
 */
export function FirstRunModeStep(props: FirstRunModeStepProps) {
  const name = useId();
  const warning = useFullAccessWarning("machine");
  return (
    <div className="first-run__step">
      <p className="first-run__intro">
        New threads start in this mode. Any thread can switch in one click from its composer, and
        you can change the default in Settings › Code › Access or for one Project.
      </p>
      <OctantRadioGroup<PermissionMode>
        aria-label="Mode for new threads"
        className="first-run__modes"
        onValueChange={(mode) => warning.guard(mode, () => props.onSelect(mode))}
        value={props.value}
      >
        {PERMISSION_MODE_OPTIONS.map((option) => {
          const unsupported = option.id === "auto" && !props.autoSupported;
          const id = `${name}-${option.id}`;
          return (
            <OctantRadioGroupItem<PermissionMode>
              aria-describedby={`${id}-detail`}
              aria-labelledby={`${id}-label`}
              className="first-run__mode"
              disabled={unsupported}
              key={option.id}
              value={option.id}
            >
              <span className="first-run__mode-text">
                <span className="first-run__mode-label" id={`${id}-label`}>
                  {option.label}
                  {option.id === "auto" && !unsupported ? (
                    <span className="first-run__mode-badge">Recommended</span>
                  ) : null}
                </span>
                <span className="first-run__mode-detail" id={`${id}-detail`}>
                  {unsupported ? AUTO_UNSUPPORTED_REASON : option.detail}
                </span>
              </span>
            </OctantRadioGroupItem>
          );
        })}
      </OctantRadioGroup>
      {warning.dialog}
    </div>
  );
}
