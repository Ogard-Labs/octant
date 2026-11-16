import type { PermissionMode, ProviderExecutionPolicy } from "@octant/contracts/providers";
import {
  AUTO_UNSUPPORTED_REASON,
  fullAccessSandboxSupported,
  hostProviderTurnRefusal,
  threadAccessOf,
} from "@octant/domain/guardrail-policy";
import type { ProviderInstanceId } from "@octant/contracts/providers";
import { clampTurnAccessPosture, type PickerGroup } from "@octant/domain";
import type { AutoReview } from "./autoReview";
import {
  ListChecks,
  PencilLine,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestionMark,
  type IconComponent,
} from "../ui/icons";
import { useId } from "react";
import { ComposerOutsideContentMark } from "../composer/OutsideContentNotice";
import { useHostPlatform } from "../platform";
import { OctantButton } from "../ui/base/OctantButton";
import { useFullAccessWarning, type FullAccessWarningScope } from "./FullAccessWarning";
import {
  OctantMenuCheckboxItem,
  OctantMenuGroup,
  OctantMenuGroupLabel,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRadioGroup,
  OctantMenuRadioItem,
  OctantMenuRoot,
  OctantMenuSeparator,
  OctantMenuTrigger,
} from "../ui/base/OctantMenu";
import { useSideWithRoom } from "../ui/base/popupSide";

const PROVIDER_REVIEW_DETAIL = "The provider's own reviewer approves each action.";
const SHIELD_REVIEW_DETAIL = "Octant Shield approves each action and asks you when unsure.";

/** What Auto means for this thread, by who reviews it. */
export function autoDetail(review: AutoReview | undefined): string {
  if (review?.status === "none") return review.reason;
  return review?.status === "reviewer" && review.reviewer === "octant-shield"
    ? SHIELD_REVIEW_DETAIL
    : PROVIDER_REVIEW_DETAIL;
}

/**
 * Whether the thread's runtime can keep the sandbox at Full access, read from
 * the picker's provider list. A provider the list does not carry reads as no,
 * so the choice is disabled rather than offered and then refused by the host.
 */
export function threadKeepsFullAccessSandbox(
  groups: ReadonlyArray<PickerGroup>,
  providerInstanceId: ProviderInstanceId,
): boolean {
  const group = groups.find(
    (candidate) => String(candidate.instance.id) === String(providerInstanceId),
  );
  return group !== undefined && fullAccessSandboxSupported(group.instance.driverKind);
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

/** One icon per mode, so the row's icon-only control says the mode at a glance. */
const PERMISSION_MODE_ICON: Readonly<Record<PermissionMode, IconComponent>> = {
  auto: ShieldCheck,
  "ask-first": ShieldQuestionMark,
  "accept-edits": PencilLine,
  plan: ListChecks,
  "full-access": ShieldAlert,
};

/**
 * Whether a running turn keeps a narrower posture than the thread now holds.
 * A narrower pick applies to the running turn at once; a wider one waits for
 * the next turn, which is what the mode's tooltip then says.
 */
export function runningTurnKeepsNarrowerMode(input: {
  readonly turnRunning: boolean;
  readonly turnPolicy: ProviderExecutionPolicy | undefined;
  readonly threadPolicy: ProviderExecutionPolicy;
}): boolean {
  if (!input.turnRunning || input.turnPolicy === undefined) return false;
  return (
    clampTurnAccessPosture({ requested: input.turnPolicy, thread: input.threadPolicy }) !==
    input.threadPolicy
  );
}

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
   * The modes this picker offers, in picker order. A coordinator proposal
   * caps them at the level it requested; absent lists every mode.
   */
  readonly modes?: ReadonlyArray<PermissionMode>;
  /**
   * The thread's opt-in sandbox at Full access. With a handler, the picker
   * offers "Keep the sandbox" under Full access; without one it offers none.
   */
  readonly fullAccessSandbox?: boolean;
  readonly onFullAccessSandboxChange?: (sandboxed: boolean) => void;
  /**
   * Whether this thread's runtime can keep the sandbox at Full access. When it
   * cannot, the choice stays listed but disabled, with the reason.
   */
  readonly fullAccessSandboxSupported?: boolean;
  /**
   * Whether a running turn still holds a narrower mode than the one shown. A
   * wider mode takes effect from the next turn, so the tooltip says so rather
   * than leave a running turn's asks reading as a broken Full access.
   */
  readonly appliesFromNextMessage?: boolean;
  /**
   * Whether Strict is on for this thread: its own choice, else its Project's
   * and Settings' default. With a handler, the picker offers Strict at every
   * mode; without one it offers none. The host decides what Strict does.
   */
  readonly strict?: boolean;
  readonly onStrictChange?: (strict: boolean) => void;
}

/**
 * The trade-off Strict makes, in the words the picker and Settings use: off,
 * the provider behaves as it does on its own; on, Octant adds its own limits
 * and some of the provider's workflows stop working.
 */
export const STRICT_DETAIL =
  "Adds Octant's own limits on top of the provider's: a fixed environment, provider telemetry off, secret files closed to every tool, and asks again after outside content. Some workflows that work in the provider's own app stop working.";
const STRICT_WINDOWS_DETAIL = "Strict needs a sandbox Windows doesn't have yet.";

/** What a level below Full access runs with on Windows, said wherever it is offered. */
export const WINDOWS_PROVIDER_APPROVALS_DETAIL =
  "On Windows the provider's own approvals decide; Octant's sandbox does not run here.";

const SANDBOX_DETAIL = "No prompts, but writes stay in the folder and secret files stay closed.";
const SANDBOX_UNSUPPORTED_DETAIL =
  "This provider can't keep the sandbox at Full access yet. Use Claude, Codex or an Octant Harness model.";

/**
 * One click from the composer to any mode. Each choice is the thread's
 * mode from then on; the host journals it and decides what it may do.
 */
export function PermissionModePicker(props: PermissionModePickerProps) {
  const idPrefix = useId();
  const popupSide = useSideWithRoom<HTMLButtonElement>("top");
  const autoSupported =
    props.autoReview === undefined ? props.autoSupported : props.autoReview.status === "reviewer";
  const unsupportedReason =
    props.autoReview?.status === "none" ? props.autoReview.reason : AUTO_UNSUPPORTED_REASON;
  const autoFallsBack = props.value === "auto" && !autoSupported;
  const warning = useFullAccessWarning(props.warningScope ?? "machine");
  // A host without Octant's sandbox (Windows today) runs the levels below Full
  // access with the provider's own approvals and claims no sandbox there; it
  // refuses only what needs Octant's sandbox (Strict below Full access, and
  // Keep the sandbox). The picker shows those unavailable with the host's
  // reason rather than offering a choice it refuses.
  const hostPlatform = useHostPlatform();
  const hostRefusalOf = (mode: PermissionMode) =>
    hostProviderTurnRefusal({
      platform: hostPlatform,
      access: threadAccessOf(mode),
      strict: props.strict === true,
    });
  const sandboxHostRefusal = hostProviderTurnRefusal({
    platform: hostPlatform,
    access: { executionPolicy: "full-access", fullAccessSandbox: true },
    strict: false,
  });
  const withoutOctantSandbox = (mode: PermissionMode, detail: string | undefined) =>
    hostPlatform === "win32" && mode !== "full-access"
      ? `${detail === undefined ? "" : `${detail} `}${WINDOWS_PROVIDER_APPROVALS_DETAIL}`
      : detail;
  const sandboxed = props.value === "full-access" && props.fullAccessSandbox === true;
  const strictUnavailable = hostPlatform === "win32" && props.strict !== true;
  const triggerLabel = autoFallsBack
    ? "Ask first"
    : sandboxed
      ? "Full access · Sandboxed"
      : PERMISSION_MODE_LABEL[props.value];
  const detailOf = (id: PermissionMode) =>
    id === "auto"
      ? autoDetail(props.autoReview)
      : PERMISSION_MODE_OPTIONS.find((option) => option.id === id)?.detail;
  const modeDetail = autoFallsBack
    ? unsupportedReason
    : sandboxed
      ? SANDBOX_DETAIL
      : withoutOctantSandbox(props.value, detailOf(props.value));
  const nextMessageNote =
    props.appliesFromNextMessage === true
      ? `${triggerLabel} applies from your next message.`
      : undefined;
  const triggerDetail =
    nextMessageNote === undefined
      ? modeDetail
      : modeDetail === undefined
        ? nextMessageNote
        : `${modeDetail} ${nextMessageNote}`;
  const sandboxSupported = props.fullAccessSandboxSupported !== false;
  const shownMode: PermissionMode = autoFallsBack ? "ask-first" : props.value;
  const ModeIcon = PERMISSION_MODE_ICON[shownMode];
  // Full access is the one mode that says its name beside the icon, in the
  // warning ink (danger without the sandbox): it is the state a person must
  // not misread as asking first.
  const showsWord = shownMode === "full-access";
  const options =
    props.modes === undefined
      ? PERMISSION_MODE_OPTIONS
      : PERMISSION_MODE_OPTIONS.filter((option) => props.modes?.includes(option.id) === true);
  return (
    <>
      <ComposerOutsideContentMark fullAccess={props.value === "full-access"} />
      {/* A composer popup is Octant's float, never the system's menu: each mode
          carries a line of detail that a system menu cannot show. */}
      <OctantMenuRoot onOpenChange={popupSide.settle}>
        {/* An icon per mode in the composer's row; its name and tooltip state the
            mode. Only Full access adds its words, in the warning ink. */}
        <OctantMenuTrigger
          ref={popupSide.trigger}
          aria-label={`Mode: ${triggerLabel}`}
          aria-description={triggerDetail}
          className="code-composer-choice__trigger"
          data-mode={shownMode}
          disabled={props.disabled === true}
          render={<OctantButton size={showsWord ? "sm" : "icon"} variant="ghost" />}
          title={
            triggerDetail === undefined
              ? `Mode: ${triggerLabel}`
              : `Mode: ${triggerLabel}. ${triggerDetail}`
          }
        >
          <ModeIcon aria-hidden="true" size={16} />
          {showsWord ? (
            <span
              className="code-composer-choice__word"
              data-sandboxed={sandboxed ? "true" : undefined}
            >
              {triggerLabel}
            </span>
          ) : null}
        </OctantMenuTrigger>
        <OctantMenuPortal>
          {/* Above the button at the foot of a thread, below it on a start
              screen, 4px clear of it and never over it: a menu that cannot fit
              shifts sideways rather than cover its trigger. */}
          <OctantMenuPositioner
            align="start"
            collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
            side={popupSide.side}
          >
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
                  const hostRefusal = hostRefusalOf(option.id);
                  const unsupported =
                    hostRefusal !== undefined || (option.id === "auto" && !autoSupported);
                  const note =
                    hostRefusal ??
                    (option.id === "auto" && !autoSupported
                      ? unsupportedReason
                      : withoutOctantSandbox(option.id, detailOf(option.id)));
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
                        <span className="oct-menu-detail" id={`${idPrefix}-${option.id}-note`}>
                          {note}
                        </span>
                      </span>
                    </OctantMenuRadioItem>
                  );
                })}
              </OctantMenuRadioGroup>
              {/* The switches are not modes: one rule between the radio choices
                  and them, so Strict does not read as another mode. */}
              {(props.value === "full-access" && props.onFullAccessSandboxChange !== undefined) ||
              props.onStrictChange !== undefined ? (
                <OctantMenuSeparator />
              ) : null}
              {props.value === "full-access" && props.onFullAccessSandboxChange !== undefined ? (
                <OctantMenuGroup>
                  <OctantMenuCheckboxItem
                    aria-describedby={`${idPrefix}-sandbox-note`}
                    checked={props.fullAccessSandbox === true}
                    // Turning the sandbox on is refused where the runtime can't
                    // keep it; turning an inherited one off is always allowed,
                    // because that is what a refused turn asks the person to do.
                    disabled={
                      props.disabled === true ||
                      ((!sandboxSupported || sandboxHostRefusal !== undefined) &&
                        props.fullAccessSandbox !== true)
                    }
                    onCheckedChange={(checked) => {
                      if (props.disabled === true) return;
                      props.onFullAccessSandboxChange?.(checked === true);
                    }}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span>Keep the sandbox</span>
                      <span className="oct-menu-detail" id={`${idPrefix}-sandbox-note`}>
                        {sandboxHostRefusal ??
                          (sandboxSupported ? SANDBOX_DETAIL : SANDBOX_UNSUPPORTED_DETAIL)}
                      </span>
                    </span>
                  </OctantMenuCheckboxItem>
                </OctantMenuGroup>
              ) : null}
              {props.onStrictChange === undefined ? null : (
                <OctantMenuGroup>
                  <OctantMenuCheckboxItem
                    aria-describedby={`${idPrefix}-strict-note`}
                    checked={props.strict === true}
                    // Turning Strict off is always allowed where it is on;
                    // turning it on needs Octant's sandbox.
                    disabled={props.disabled === true || strictUnavailable}
                    onCheckedChange={(checked) => {
                      if (props.disabled === true) return;
                      props.onStrictChange?.(checked === true);
                    }}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span>Strict</span>
                      <span className="oct-menu-detail" id={`${idPrefix}-strict-note`}>
                        {strictUnavailable ? STRICT_WINDOWS_DETAIL : STRICT_DETAIL}
                      </span>
                    </span>
                  </OctantMenuCheckboxItem>
                </OctantMenuGroup>
              )}
              {props.profileName === undefined ? null : (
                <>
                  <OctantMenuSeparator />
                  <OctantMenuGroup>
                    <OctantMenuGroupLabel>Started under {props.profileName}</OctantMenuGroupLabel>
                  </OctantMenuGroup>
                </>
              )}
            </OctantMenuPopup>
          </OctantMenuPositioner>
        </OctantMenuPortal>
      </OctantMenuRoot>
      {warning.dialog}
    </>
  );
}
