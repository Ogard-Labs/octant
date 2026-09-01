import type {
  NavigatorAssistantModelRef,
  NavigatorAssistantSettings,
  SettingsSettingId,
} from "@octant/contracts";
import type { ShellSettings } from "@octant/contracts/shell";
import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import {
  buildModelPickerGroups,
  imageInputCapabilityOf,
  navigatorAssistantImagePolicy,
} from "@octant/domain";
import { useMemo } from "react";
import { ModelPicker } from "../providers/ModelPicker";
import { OctantButton } from "../ui/base/OctantButton";
import { SettingRow } from "./primitives";
import { settingId } from "./registry";

export interface NavigatorAssistantSettingsViewProps {
  readonly settings: NavigatorAssistantSettings;
  readonly providerSnapshot?: ProviderRegistrySnapshot | undefined;
  readonly focusedSetting?: SettingsSettingId | undefined;
  readonly onSettingsChange: (patch: Partial<ShellSettings>) => void;
}

/**
 * Navigator settings section: the default model Navigator converses with and
 * the optional vision reviewer used only when the default model cannot read
 * images. Both persist through the journaled shell settings; clearing the
 * default model returns Navigator to its honest unconfigured state.
 */
export function NavigatorAssistantSettingsView(props: NavigatorAssistantSettingsViewProps) {
  const groups = useMemo(
    () =>
      buildModelPickerGroups({
        instances: props.providerSnapshot?.instances ?? [],
        observedByInstance: new Map(
          (props.providerSnapshot?.observedStates ?? []).map(
            (state) => [state.instanceId, state] as const,
          ),
        ),
        providerOrder: props.providerSnapshot?.defaults.providerOrder,
        mode: "chat",
      }),
    [props.providerSnapshot],
  );
  const noProviders = groups.length === 0;

  // What the configured pair actually does with an image, decided by the same
  // policy the server routes turns through, so the section cannot promise
  // behavior the runtime will not deliver.
  const imageHandling = useMemo(() => {
    const chosen = props.settings.defaultProvider;
    if (chosen === undefined) return undefined;
    const model = (props.providerSnapshot?.observedStates ?? [])
      .find((state) => state.instanceId === chosen.providerInstanceId)
      ?.models.find((candidate) => String(candidate.id) === String(chosen.modelId));
    return navigatorAssistantImagePolicy({
      imageInput: imageInputCapabilityOf(model),
      visionReviewerConfigured: props.settings.visionReviewer !== undefined,
    });
  }, [props.providerSnapshot, props.settings.defaultProvider, props.settings.visionReviewer]);

  const apply = (next: NavigatorAssistantSettings) => {
    props.onSettingsChange({ navigatorAssistant: next });
  };

  return (
    <section aria-label="Navigator" id="settings-navigator-assistant">
      {noProviders ? (
        <p className="provider-settings__hint" role="status">
          No ready providers are available. Connect one in Providers &amp; Models to configure
          Navigator.
        </p>
      ) : null}
      <div className="settings-card-section settings-card-section--open">
        <h2>Models</h2>
        <div className="setgroup">
          <SettingRow
            description="The model Navigator uses. Without one, Navigator stays unavailable rather than silently picking a model."
            focused={props.focusedSetting === settingId("default-model")}
            label="Default model"
            scope="app"
            settingId="default-model"
          >
            <ModelPicker
              ariaLabel="Navigator default model"
              groups={groups}
              onSelect={(selection) =>
                apply({
                  ...props.settings,
                  defaultProvider: selection as NavigatorAssistantModelRef,
                })
              }
              selectedModelId={props.settings.defaultProvider?.modelId}
              selectedProviderInstanceId={props.settings.defaultProvider?.providerInstanceId}
            />
            {props.settings.defaultProvider === undefined ? (
              <p className="settings-view__effective-note" role="status">
                Navigator is unavailable until a default model is chosen.
              </p>
            ) : (
              <OctantButton
                onClick={() => {
                  const { defaultProvider: _cleared, ...rest } = props.settings;
                  apply(rest);
                }}
                type="button"
                variant="ghost"
              >
                Clear default model
              </OctantButton>
            )}
          </SettingRow>
          <SettingRow
            description="Used only when the default model cannot read images: it describes the image as text for the default model, and never becomes the conversation model."
            focused={props.focusedSetting === settingId("vision-reviewer")}
            label="Vision reviewer"
            scope="app"
            settingId="vision-reviewer"
          >
            <ModelPicker
              ariaLabel="Navigator vision reviewer"
              groups={groups}
              onSelect={(selection) =>
                apply({
                  ...props.settings,
                  visionReviewer: selection as NavigatorAssistantModelRef,
                })
              }
              selectedModelId={props.settings.visionReviewer?.modelId}
              selectedProviderInstanceId={props.settings.visionReviewer?.providerInstanceId}
            />
            {imageHandling === undefined ? null : (
              <p className="settings-view__effective-note" role="status">
                {imageHandling.kind === "send-to-primary"
                  ? "The default model reads images directly, so no reviewer is used."
                  : imageHandling.kind === "review-then-send"
                    ? "Images are described by the vision reviewer, then answered by the default model."
                    : imageHandling.reason}
              </p>
            )}
            {props.settings.visionReviewer === undefined ? (
              <p className="settings-view__effective-note" role="status">
                No vision reviewer is configured. Images are refused when the default model cannot
                read them.
              </p>
            ) : (
              <OctantButton
                onClick={() => {
                  const { visionReviewer: _cleared, ...rest } = props.settings;
                  apply(rest);
                }}
                type="button"
                variant="ghost"
              >
                Clear vision reviewer
              </OctantButton>
            )}
          </SettingRow>
        </div>
      </div>
    </section>
  );
}
