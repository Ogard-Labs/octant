import type { PermissionMode } from "@octant/contracts/providers";
import { AUTO_UNSUPPORTED_REASON } from "@octant/domain/guardrail-policy";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { useId } from "react";
import { OctantButton } from "../ui/base/OctantButton";
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

/**
 * The modes in picker order, in the words the native apps use. Off is not
 * here: it is a Settings switch under Full access.
 */
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
    detail: "No prompts inside the folder. A sandbox still applies.",
  },
];

export const PERMISSION_MODE_LABEL: Readonly<Record<PermissionMode, string>> = {
  auto: "Auto",
  "ask-first": "Ask first",
  "accept-edits": "Accept edits",
  plan: "Plan",
  "full-access": "Full access",
};

/** Full access with the sandbox switched off in Settings. */
export const SANDBOX_OFF_LABEL = "Full access · no sandbox";
export const SANDBOX_OFF_DETAIL =
  "No prompts and no sandbox. The agent can reach your whole home folder.";

export interface PermissionModePickerProps {
  readonly value: PermissionMode;
  readonly onChange: (mode: PermissionMode) => void;
  /**
   * Whether the thread's provider has a reviewer of its own. Without one Auto
   * stays listed but disabled, with the reason, and a thread set to Auto runs
   * as Ask first and says so.
   */
  readonly autoSupported: boolean;
  /** The thread runs at Off: Full access with the sandbox switched off. */
  readonly sandboxOff?: boolean;
  readonly disabled?: boolean;
  readonly profileName?: string;
}

/**
 * One click from the composer to any mode. Each choice is the thread's
 * mode from then on; the host journals it and decides what it may do.
 */
export function PermissionModePicker(props: PermissionModePickerProps) {
  const idPrefix = useId();
  const autoFallsBack = props.value === "auto" && !props.autoSupported;
  const offAtFullAccess = props.value === "full-access" && props.sandboxOff === true;
  const triggerLabel = autoFallsBack
    ? "Ask first"
    : offAtFullAccess
      ? SANDBOX_OFF_LABEL
      : PERMISSION_MODE_LABEL[props.value];
  const triggerDetail = autoFallsBack
    ? AUTO_UNSUPPORTED_REASON
    : offAtFullAccess
      ? SANDBOX_OFF_DETAIL
      : PERMISSION_MODE_OPTIONS.find((option) => option.id === props.value)?.detail;
  return (
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
                const next = PERMISSION_MODE_OPTIONS.find((option) => option.id === value);
                if (next === undefined || next.id === props.value) return;
                props.onChange(next.id);
              }}
            >
              {PERMISSION_MODE_OPTIONS.map((option) => {
                const unsupported = option.id === "auto" && !props.autoSupported;
                const note = unsupported
                  ? AUTO_UNSUPPORTED_REASON
                  : option.id === "full-access" && props.sandboxOff === true
                    ? SANDBOX_OFF_DETAIL
                    : option.detail;
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
  );
}
