import type { ProviderRegistrySnapshot, WorkAccess } from "@octant/contracts";
import { buildModelPickerGroups } from "@octant/domain";
import { useMemo } from "react";
import { ComposerModelPicker } from "../providers/ComposerModelPicker";
import { SettingRow, SettingsSection } from "../settings/primitives";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import type { WorkSettingsController } from "./useWorkSettings";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { FULL_ACCESS_WARNING, useFullAccessWarning } from "../code/FullAccessWarning";

const ACCESS_NOTES: Readonly<Record<WorkAccess, string>> = {
  auto: "The provider's own reviewer approves each command and file change. Providers without a reviewer ask first.",
  "ask-first": "The agent asks before it runs a command or changes a file in the Project folder.",
  "auto-accept-edits":
    "The agent edits files inside the Project folder without asking, and asks before commands. Anything outside the folder is still refused.",
  "full-access": FULL_ACCESS_WARNING,
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
  const warning = useFullAccessWarning("machine");
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
          <OctantAlert className="settings-view__error" tone="danger">
            {props.controller.message}
          </OctantAlert>
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
                warning.guard(
                  next === "full-access" ? "full-access" : undefined,
                  () => void props.controller.update({ defaultAccess: next }),
                );
              }
            }}
            value={[settings.defaultAccess]}
          >
            <OctantToggleGroupItem value="auto">Auto</OctantToggleGroupItem>
            <OctantToggleGroupItem value="ask-first">Ask first</OctantToggleGroupItem>
            <OctantToggleGroupItem value="auto-accept-edits">Accept edits</OctantToggleGroupItem>
            <OctantToggleGroupItem value="full-access">Full access</OctantToggleGroupItem>
          </OctantToggleGroup>
          {warning.dialog}
        </SettingRow>
        <SettingRow
          description="New Work threads at Full access run without prompts but keep writes in the Project folder and secret files closed. Works with Codex and Octant Harness models; a task can turn it off from its mode picker."
          focused={props.focusedSetting === "work-full-access-sandbox"}
          label="Keep the sandbox at Full access"
          scope="host"
          settingId="work-full-access-sandbox"
        >
          <OctantSwitch
            checked={settings.defaultFullAccessSandbox === true}
            disabled={props.controller.busy}
            label="Keep the sandbox at Full access"
            onCheckedChange={(checked) =>
              void props.controller.update({ defaultFullAccessSandbox: checked })
            }
          />
        </SettingRow>
        <SettingRow
          description="When Octant stops in the middle of a turn, from a crash, a quit, or a restart of this computer, the thread picks the turn up by itself when Octant opens again. This applies to every Work thread, not only new ones. A thread can turn this off from its menu."
          focused={props.focusedSetting === "work-restart-continuation"}
          label="Continue after restart"
          scope="mode"
          settingId="work-restart-continuation"
        >
          <OctantSwitch
            checked={settings.restartContinuation !== false}
            disabled={props.controller.busy}
            label="Continue after restart"
            onCheckedChange={(checked) =>
              void props.controller.update({ restartContinuation: checked })
            }
          />
        </SettingRow>
      </div>
    </SettingsSection>
  );
}
