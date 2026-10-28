import type { ClaudeProviderInstance, ProviderObservedState } from "@octant/contracts";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { SettingRow } from "../settings/primitives";

export interface ClaudeArtifactDeliverySettingProps {
  readonly instance: ClaudeProviderInstance;
  readonly observed?: Pick<ProviderObservedState, "capabilities">;
  readonly disabled: boolean;
  readonly onChange: (enabled: boolean) => Promise<boolean>;
}

/**
 * The person's switch for delivering Work and Code documents with Claude's
 * own Artifact tool instead of a Canvas. Off unless they turn it on: a
 * published page goes to their claude.ai account and leaves this computer, so
 * the copy says so before they flip it. The server records the switch and
 * refuses it from anywhere but this host's own window.
 */
export function ClaudeArtifactDeliverySetting(props: ClaudeArtifactDeliverySettingProps) {
  const settingId = `provider-${props.instance.id}-claude-artifacts`;
  const checked = props.instance.configuration.artifactDelivery === true;
  const unsupportedReason = artifactsUnsupportedReason(props.instance, props.observed);
  return (
    <SettingRow
      description={
        <>
          When on, Claude in Work and Code publishes documents, reports, and pages to your claude.ai
          account instead of making a Canvas. Each page is uploaded to claude.ai and leaves this
          computer; Octant shows a link to it. Claude asks before every publish, in Full access too,
          and Plan never publishes. Ask for a Canvas and you still get one. Your Claude plan decides
          whether the tool is offered; when it isn’t, documents stay Canvases.
          {/* A switch that cannot be turned on says why in words, not only on hover. */}
          {unsupportedReason === undefined ? null : <> {unsupportedReason}</>}
        </>
      }
      label="Deliver documents as Claude artifacts"
      scope="host"
      settingId={settingId}
    >
      <OctantSwitch
        checked={checked}
        describedBy={`${settingId}-description`}
        disabled={props.disabled || (unsupportedReason !== undefined && !checked)}
        {...(unsupportedReason === undefined ? {} : { disabledReason: unsupportedReason })}
        label={`Deliver documents from ${props.instance.displayName} as Claude artifacts`}
        onCheckedChange={(next) => void props.onChange(next)}
      />
    </SettingRow>
  );
}

function artifactsUnsupportedReason(
  instance: ClaudeProviderInstance,
  observed: Pick<ProviderObservedState, "capabilities"> | undefined,
): string | undefined {
  if (instance.configuration.authentication !== "subscription") {
    return "Claude artifacts need a claude.ai sign-in. An API-key account has no claude.ai account to publish to.";
  }
  const support = observed?.capabilities.nativeArtifacts;
  if (support !== undefined && support.work !== "supported" && support.code !== "supported") {
    return "The last connection check found no artifact tool for this account.";
  }
  return undefined;
}
