import type { PermissionPersistence, ProviderExecutionPolicy } from "@octant/contracts/providers";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { OctantButton } from "../../ui/base/OctantButton";
import {
  OctantMenuCheckboxItem,
  OctantMenuGroup,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRadioGroup,
  OctantMenuRadioItem,
  OctantMenuRoot,
  OctantMenuSeparator,
  OctantMenuTrigger,
} from "../../ui/base/OctantMenu";

export const CODE_COMPOSER_ACCESS_OPTIONS: ReadonlyArray<{
  readonly id: ProviderExecutionPolicy;
  readonly label: string;
  readonly detail: string;
}> = [
  {
    id: "plan",
    label: "Plan · read-only",
    detail: "Read-only. No commands or file changes.",
  },
  {
    id: "approval-gated",
    label: "Ask for approvals",
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
  /**
   * The postures this thread may start in, when fewer than all. A thread on
   * an SSH target is offered only those the host would create it holding.
   */
  readonly offered?: ReadonlyArray<ProviderExecutionPolicy>;
}

/** New-thread access posture. The in-thread picker still owns raise-grant. */
export function CodeComposerAccessMenu(props: CodeComposerAccessMenuProps) {
  const offered = props.offered;
  const options =
    offered === undefined
      ? CODE_COMPOSER_ACCESS_OPTIONS
      : CODE_COMPOSER_ACCESS_OPTIONS.filter((option) => offered.includes(option.id));
  const selected =
    options.find((option) => option.id === props.value) ??
    options.find((option) => option.id === "approval-gated") ??
    options[0];
  // Remembering a posture for the Project is offered only where Full access
  // can be remembered at all.
  const rememberAvailable =
    props.persistence !== undefined &&
    props.onPersistenceChange !== undefined &&
    (offered === undefined || offered.includes("full-access"));

  return (
    <OctantMenuRoot>
      <OctantMenuTrigger
        aria-label="Access policy"
        aria-description={selected?.detail}
        className="code-composer-choice__trigger"
        disabled={props.disabled === true}
        render={<OctantButton size="sm" variant="ghost" />}
      >
        <ShieldCheck aria-hidden="true" />
        <span>{selected?.label}</span>
        <ChevronDown aria-hidden="true" />
      </OctantMenuTrigger>
      <OctantMenuPortal>
        <OctantMenuPositioner align="end" side="top">
          <OctantMenuPopup aria-label="Access policy">
            <OctantMenuRadioGroup
              value={selected?.id ?? props.value}
              onValueChange={(value) => {
                if (props.disabled || typeof value !== "string") return;
                const next = options.find((option) => option.id === value);
                if (next !== undefined) props.onChange(next.id);
              }}
            >
              {options.map((option) => (
                <OctantMenuRadioItem
                  closeOnClick
                  disabled={props.disabled === true}
                  key={option.id}
                  title={option.detail}
                  value={option.id}
                >
                  {option.label}
                </OctantMenuRadioItem>
              ))}
            </OctantMenuRadioGroup>
            {rememberAvailable ? (
              <OctantMenuGroup>
                <OctantMenuSeparator />
                <OctantMenuCheckboxItem
                  checked={props.persistence === "project-default"}
                  disabled={props.disabled === true}
                  onCheckedChange={(checked) =>
                    props.onPersistenceChange?.(checked ? "project-default" : "current-session")
                  }
                >
                  Remember for this Project
                </OctantMenuCheckboxItem>
              </OctantMenuGroup>
            ) : null}
          </OctantMenuPopup>
        </OctantMenuPositioner>
      </OctantMenuPortal>
    </OctantMenuRoot>
  );
}
