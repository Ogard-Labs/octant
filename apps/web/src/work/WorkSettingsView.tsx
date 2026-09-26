import type { ProviderRegistrySnapshot, WorkAccess } from "@octant/contracts";
import { buildModelPickerGroups } from "@octant/domain";
import { useMemo } from "react";
import { ComposerModelPicker } from "../providers/ComposerModelPicker";
import { SettingRow, SettingsSection } from "../settings/primitives";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import type { WorkSettingsController } from "./useWorkSettings";

const ACCESS_NOTES: Readonly<Record<WorkAccess, string>> = {
  "ask-first": "The agent asks before it changes any file in the Project folder.",
  "auto-accept-edits":
    "The agent edits files inside the Project folder without asking. Anything outside the folder is still refused, and every other action works as before. Providers without an auto-accept path keep asking.",
};

/**
 * Settings › Work: what a new Work thread starts with. A thread keeps what it
 * started with, so changing these never changes one that already exists.
 */
export function WorkSettingsView(props: {
  readonly controller: WorkSettingsController;
  readonly providerSnapshot?: ProviderRegistrySnapshot | undefined;
  readonly focusedSetting?: string | undefined;
}) {
  const settings = props.controller.settings;
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
        hiddenModels: props.providerSnapshot?.defaults.hiddenModels,
        mode: "work",
        currentSelection:
          settings?.defaultProviderInstanceId === undefined || settings.defaultModelId === undefined
            ? undefined
            : {
                providerInstanceId: settings.defaultProviderInstanceId,
                modelId: settings.defaultModelId,
              },
      }),
    [props.providerSnapshot, settings?.defaultProviderInstanceId, settings?.defaultModelId],
  );

  if (settings === undefined) {
    return (
      <p className="settings-view__empty" role="status">
        {props.controller.message ?? "Loading Work settings…"}
      </p>
    );
  }

  return (
    <SettingsSection
      description="What a new Work thread starts with. Threads that already exist keep what they started with."
      title="New threads"
    >
      <div className="settings-feedback-slot" aria-live="polite">
        {props.controller.message === undefined ? null : (
          <p className="settings-view__error" role="alert">
            {props.controller.message}
          </p>
        )}
      </div>
      <div className="setgroup">
        <SettingRow
          description="The provider and model a new Work thread starts on."
          focused={props.focusedSetting === "work-default-model"}
          label="Default model"
          scope="host"
          settingId="work-default-model"
        >
          <ComposerModelPicker
            ariaLabel="Default Work provider and model"
            disabled={props.controller.busy}
            groups={groups}
            menuSide="bottom"
            onSelect={(selection) =>
              void props.controller.update({
                defaultModel: {
                  providerInstanceId: selection.providerInstanceId,
                  modelId: selection.modelId,
                },
              })
            }
            rememberChoice={false}
            selectedModelId={settings.defaultModelId}
            selectedProviderInstanceId={settings.defaultProviderInstanceId}
            unselectedLabel="First available"
          />
        </SettingRow>
        <SettingRow
          description={ACCESS_NOTES[settings.defaultAccess]}
          focused={props.focusedSetting === "work-default-access"}
          label="Access"
          scope="host"
          settingId="work-default-access"
        >
          <OctantToggleGroup<WorkAccess>
            aria-label="Default Work access"
            disabled={props.controller.busy}
            onValueChange={(value) => {
              const next = value[0];
              if (next !== undefined && next !== settings.defaultAccess) {
                void props.controller.update({ defaultAccess: next });
              }
            }}
            value={[settings.defaultAccess]}
          >
            <OctantToggleGroupItem value="ask-first">Ask first</OctantToggleGroupItem>
            <OctantToggleGroupItem value="auto-accept-edits">
              Auto-accept edits
            </OctantToggleGroupItem>
          </OctantToggleGroup>
        </SettingRow>
      </div>
    </SettingsSection>
  );
}
