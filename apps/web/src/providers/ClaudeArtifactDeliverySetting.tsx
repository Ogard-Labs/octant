import type { ClaudeProviderInstance, ProviderObservedState } from "@octant/contracts";
import { useRef, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { SettingRow } from "../settings/primitives";

export interface ClaudeArtifactDeliverySettingProps {
  readonly instance: ClaudeProviderInstance;
  readonly observed?: Pick<ProviderObservedState, "capabilities">;
  readonly disabled: boolean;
  readonly onChange: (enabled: boolean) => Promise<boolean>;
}

/** What enabling the setting changes, said the same way under the switch and in the dialog. */
export const CLAUDE_ARTIFACTS_TELEMETRY_WARNING =
  "Enabling Claude artifacts also turns on Claude Code’s usage telemetry to Anthropic for this account’s Work and Code threads that use them. Error reports and conversation uploads stay off.";

/**
 * The person's setting that makes Claude's own Artifact tool available to
 * this account's Work and Code threads. Off unless they enable it, and only
 * from a window on this host (the server refuses others). Canvas stays the
 * default: each thread then chooses artifacts for itself. Enabling it is a
 * privacy decision, because a thread that uses artifacts runs with Claude
 * Code's usage telemetry on, so the warning stays under the switch and
 * enabling asks again in a dialog that repeats it.
 */
export function ClaudeArtifactDeliverySetting(props: ClaudeArtifactDeliverySettingProps) {
  const [confirming, setConfirming] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const checked = props.instance.configuration.artifactDelivery === true;
  const unsupportedReason = artifactsUnsupportedReason(props.instance, props.observed);
  const settingId = `provider-${props.instance.id}-claude-artifacts`;
  const warningId = `${settingId}-telemetry`;
  return (
    <div className="claude-artifacts-setting">
      <SettingRow
        description={
          <>
            Lets this account’s Work and Code threads publish documents, reports, and pages to your
            claude.ai account instead of making a Canvas. Canvas stays the default; each thread
            chooses artifacts for itself. A published page leaves this computer, Claude asks before
            every publish, and Plan never publishes.
            {/* A switch that cannot be turned on says why in words, not only on hover. */}
            {unsupportedReason === undefined ? null : <> {unsupportedReason}</>}
          </>
        }
        label="Enable Claude artifacts"
        scope="host"
        settingId={`provider-${props.instance.id}-claude-artifacts`}
      >
        <OctantSwitch
          checked={checked}
          describedBy={`${settingId}-description ${warningId}`}
          disabled={props.disabled || (unsupportedReason !== undefined && !checked)}
          {...(unsupportedReason === undefined ? {} : { disabledReason: unsupportedReason })}
          label={`Enable Claude artifacts for ${props.instance.displayName}`}
          onCheckedChange={(next) => {
            if (!next) {
              void props.onChange(false);
              return;
            }
            opener.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setConfirming(true);
          }}
        />
      </SettingRow>
      {/* A standing notice, not news: it is read with the switch, so it does
          not interrupt as an alert each time Settings opens. */}
      <OctantAlert id={warningId} role="status" tone="warning">
        {CLAUDE_ARTIFACTS_TELEMETRY_WARNING}
      </OctantAlert>
      {confirming ? (
        <OctantConfirmDialog
          confirmLabel="Enable Claude artifacts"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void props.onChange(true);
          }}
          restoreFocus={opener}
          title={`Enable Claude artifacts for ${props.instance.displayName}?`}
        >
          {CLAUDE_ARTIFACTS_TELEMETRY_WARNING}
        </OctantConfirmDialog>
      ) : null}
    </div>
  );
}

function artifactsUnsupportedReason(
  instance: ClaudeProviderInstance,
  observed: Pick<ProviderObservedState, "capabilities"> | undefined,
): string | undefined {
  if (instance.configuration.authentication !== "subscription") {
    return "Claude artifacts need a claude.ai sign-in. An API-key account has no claude.ai account to publish to.";
  }
  if (observed?.capabilities.nativeArtifacts?.unsupportedReason === "host-traffic-disabled") {
    return "This computer’s own telemetry opt-out (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, DISABLE_TELEMETRY or DO_NOT_TRACK) keeps Claude Code’s telemetry and Claude artifacts off.";
  }
  return undefined;
}
