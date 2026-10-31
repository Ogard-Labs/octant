import type { PermissionMode } from "@octant/contracts/providers";
import { AUTO_UNSUPPORTED_REASON } from "@octant/domain/guardrail-policy";
import type { AutoReview } from "./autoReview";
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

const PROVIDER_REVIEW_DETAIL = "The provider's own reviewer approves each action.";
const SHIELD_REVIEW_DETAIL = "Octant Shield approves each action and asks you when unsure.";

/** What Auto means for this thread, by who reviews it. */
export function autoDetail(review: AutoReview | undefined): string {
  if (review?.status === "none") return review.reason;
  return review?.status === "reviewer" && review.reviewer === "octant-shield"
    ? SHIELD_REVIEW_DETAIL
    : PROVIDER_REVIEW_DETAIL;
}

/** The modes in picker order, in the words the native apps use. */
export const PERMISSION_MODE_OPTIONS: ReadonlyArray<{
  readonly id: PermissionMode;
  readonly label: string;
  readonly detail: string;
}> = [
  { id: "auto", label: "Auto", detail: PROVIDER_REVIEW_DETAIL },
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
  /**
   * Who answers this thread's prompts at Auto, or why nobody can: the
   * provider's own reviewer or Octant Shield. Absent reads as the provider's
   * own when Auto is supported.
   */
  readonly autoReview?: AutoReview | undefined;
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
  const autoSupported =
    props.autoReview === undefined ? props.autoSupported : props.autoReview.status === "reviewer";
  const unsupportedReason =
    props.autoReview?.status === "none" ? props.autoReview.reason : AUTO_UNSUPPORTED_REASON;
  const autoFallsBack = props.value === "auto" && !autoSupported;
  const warning = useFullAccessWarning(props.warningScope ?? "machine");
  const triggerLabel = autoFallsBack ? "Ask first" : PERMISSION_MODE_LABEL[props.value];
  const detailOf = (id: PermissionMode) =>
    id === "auto"
      ? autoDetail(props.autoReview)
      : PERMISSION_MODE_OPTIONS.find((option) => option.id === id)?.detail;
  const triggerDetail = autoFallsBack ? unsupportedReason : detailOf(props.value);
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
                  const unsupported = option.id === "auto" && !autoSupported;
                  const note = unsupported ? unsupportedReason : detailOf(option.id);
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
                          {option.id === "auto" && autoSupported
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
