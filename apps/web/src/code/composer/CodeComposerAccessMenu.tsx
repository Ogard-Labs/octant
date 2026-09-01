import type { PermissionPersistence, ProviderExecutionPolicy } from "@octant/contracts/providers";
import { ChevronDown, Lock } from "lucide-react";
import { useState } from "react";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantPopover } from "../../ui/base/OctantPopover";
import { OctantSwitch } from "../../ui/base/OctantSwitch";

export const CODE_COMPOSER_ACCESS_OPTIONS: ReadonlyArray<{
  readonly id: ProviderExecutionPolicy;
  readonly label: string;
  readonly detail: string;
}> = [
  {
    id: "plan",
    label: "Plan",
    detail: "Read-only. No commands or file changes.",
  },
  {
    id: "approval-gated",
    label: "Approval",
    detail: "Ask before commands and file changes.",
  },
  {
    id: "auto-accept-edits",
    label: "Auto-accept edits",
    detail: "Apply edits. Ask before other actions.",
  },
  {
    id: "full-access",
    label: "Full access",
    detail: "Allow commands and edits without prompts.",
  },
];

export interface CodeComposerAccessMenuProps {
  readonly disabled?: boolean;
  readonly onChange: (executionPolicy: ProviderExecutionPolicy) => void;
  readonly value: ProviderExecutionPolicy;
  /**
   * How long the chosen posture is remembered. Shown with the posture because
   * "remember Full access for this Project" is a decision about the posture,
   * not about where the thread delivers.
   */
  readonly persistence?: PermissionPersistence;
  readonly onPersistenceChange?: (persistence: PermissionPersistence) => void;
}

/** New-thread access posture. The in-thread picker still owns raise-grant. */
export function CodeComposerAccessMenu(props: CodeComposerAccessMenuProps) {
  const [open, setOpen] = useState(false);
  const selected =
    CODE_COMPOSER_ACCESS_OPTIONS.find((option) => option.id === props.value) ??
    CODE_COMPOSER_ACCESS_OPTIONS[1];

  return (
    <OctantPopover
      className="code-composer-choice__menu"
      onOpenChange={setOpen}
      open={open}
      title="Access policy"
      trigger={
        <>
          <Lock aria-hidden="true" size={12} strokeWidth={1.8} />
          <span>{selected?.label}</span>
          <ChevronDown aria-hidden="true" size={12} />
        </>
      }
      triggerClassName="code-composer-choice__trigger"
      triggerLabel="Access policy"
      {...(props.disabled === undefined ? {} : { triggerDisabled: props.disabled })}
    >
      <div aria-label="Access policy" className="code-composer-choice__list" role="listbox">
        {CODE_COMPOSER_ACCESS_OPTIONS.map((option) => (
          <OctantButton
            aria-selected={option.id === props.value}
            className="code-composer-choice__option"
            key={option.id}
            onClick={() => {
              props.onChange(option.id);
              setOpen(false);
            }}
            role="option"
            type="button"
            variant="ghost"
          >
            <span className="code-composer-choice__option-copy">
              <span className="code-composer-choice__option-label">{option.label}</span>
              <span className="code-composer-choice__option-detail">{option.detail}</span>
            </span>
          </OctantButton>
        ))}
      </div>
      {props.persistence === undefined || props.onPersistenceChange === undefined ? null : (
        <div className="code-composer-choice__footer">
          <span>Remember for this Project</span>
          <OctantSwitch
            checked={props.persistence === "project-default"}
            {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
            label="Remember access for this Project"
            onCheckedChange={(checked) =>
              props.onPersistenceChange?.(checked ? "project-default" : "current-session")
            }
          />
        </div>
      )}
    </OctantPopover>
  );
}
