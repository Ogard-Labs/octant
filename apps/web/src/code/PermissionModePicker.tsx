import type { PermissionMode } from "@octant/contracts/providers";
import { AUTO_UNSUPPORTED_REASON } from "@octant/domain/guardrail-policy";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { useId } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { useFullAccessWarning, type FullAccessWarningScope } from "./FullAccessWarning";
import {
  OctantMenuGroup,
  OctantMenuGroupLabel,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRadioGroup,
  OctantMenuRadioItem,
  OctantMenuRoot,
  OctantMenuTrigger,
} from "../ui/base/OctantMenu";

/** The modes in picker order, in the words the native apps use. */
export const PERMISSION_MODE_OPTIONS: ReadonlyArray<{
  readonly id: PermissionMode;
  readonly label: string;
  readonly detail: string;
}> = [
  { id: "auto", label: "Auto", detail: "The provider's own reviewer approves each action." },
  { id: "ask-first", label: "Ask first", detail: "Asks before commands and file changes." },
  {
    id: "accept-edits",
    label: "Accept edits",
    detail: "Edits files in the folder. Asks before commands.",
  },
  { id: "plan", label: "Plan", detail: "Read-only. No commands or file changes." },
  {
    id: "full-access",
    label: "Full access",
    detail: "No sandbox and no prompts. Every action is still recorded.",
  },
];

export const PERMISSION_MODE_LABEL: Readonly<Record<PermissionMode, string>> = {
  auto: "Auto",
  "ask-first": "Ask first",
  "accept-edits": "Accept edits",
  plan: "Plan",
  "full-access": "Full access",
};

export interface PermissionModePickerProps {
  readonly value: PermissionMode;
  readonly onChange: (mode: PermissionMode) => void;
  /**
   * Whether the thread's provider has a reviewer of its own. Without one Auto
   * stays listed but disabled, with the reason, and a thread set to Auto runs
   * as Ask first and says so.
   */
  readonly autoSupported: boolean;
  /** Which first Full access pick the one-time warning is for. */
  readonly warningScope?: FullAccessWarningScope;
  readonly disabled?: boolean;
  readonly profileName?: string;
  /**
   * The modes this thread can take, in picker order. Work threads share
   * Code's levels but have no Plan overlay; absent lists every mode.
   */
  readonly modes?: ReadonlyArray<PermissionMode>;
}

/**
 * One click from the composer to any mode. Each choice is the thread's
 * mode from then on; the host journals it and decides what it may do.
 */
export function PermissionModePicker(props: PermissionModePickerProps) {
  const idPrefix = useId();
  const autoFallsBack = props.value === "auto" && !props.autoSupported;
  const warning = useFullAccessWarning(props.warningScope ?? "machine");
  const triggerLabel = autoFallsBack ? "Ask first" : PERMISSION_MODE_LABEL[props.value];
  const triggerDetail = autoFallsBack
    ? AUTO_UNSUPPORTED_REASON
    : PERMISSION_MODE_OPTIONS.find((option) => option.id === props.value)?.detail;
  const options =
    props.modes === undefined
      ? PERMISSION_MODE_OPTIONS
      : PERMISSION_MODE_OPTIONS.filter((option) => props.modes?.includes(option.id) === true);
  return (
    <>
      <OctantMenuRoot>
        <OctantMenuTrigger
          aria-label="Mode"
          aria-description={triggerDetail}
          className="code-composer-choice__trigger"
          disabled={props.disabled === true}
          render={<OctantButton size="sm" variant="ghost" />}
          title={triggerDetail}
        >
          <ShieldCheck aria-hidden="true" />
          <span>{triggerLabel}</span>
          <ChevronDown aria-hidden="true" />
        </OctantMenuTrigger>
        <OctantMenuPortal>
          <OctantMenuPositioner side="top">
            <OctantMenuPopup>
              <OctantMenuRadioGroup
                value={props.value}
                onValueChange={(value) => {
                  if (props.disabled === true || typeof value !== "string") return;
                  const next = options.find((option) => option.id === value);
                  if (next === undefined || next.id === props.value) return;
                  warning.guard(next.id, () => props.onChange(next.id));
                }}
              >
                {options.map((option) => {
                  const unsupported = option.id === "auto" && !props.autoSupported;
                  const note = unsupported ? AUTO_UNSUPPORTED_REASON : option.detail;
                  return (
                    <OctantMenuRadioItem
                      aria-describedby={`${idPrefix}-${option.id}-note`}
                      aria-labelledby={`${idPrefix}-${option.id}-label`}
                      closeOnClick
                      disabled={props.disabled === true || unsupported}
                      key={option.id}
                      value={option.id}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span id={`${idPrefix}-${option.id}-label`}>
                          {option.id === "auto" && props.autoSupported
                            ? "Auto · Recommended"
                            : option.label}
                        </span>
                        <span
                          className="text-xs text-muted-foreground"
                          id={`${idPrefix}-${option.id}-note`}
                        >
                          {note}
                        </span>
                      </span>
                    </OctantMenuRadioItem>
                  );
                })}
              </OctantMenuRadioGroup>
              {props.profileName === undefined ? null : (
                <OctantMenuGroup>
                  <OctantMenuGroupLabel>Started under {props.profileName}</OctantMenuGroupLabel>
                </OctantMenuGroup>
              )}
            </OctantMenuPopup>
          </OctantMenuPositioner>
        </OctantMenuPortal>
      </OctantMenuRoot>
      {warning.dialog}
    </>
  );
}
