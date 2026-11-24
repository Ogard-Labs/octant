import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import type {
  ProjectId,
  ProjectLinearTarget,
  ProjectSummary,
  SettingsSettingId,
} from "@octant/contracts";
import { LinearConnectionSettings } from "./LinearConnectionSettings";

export interface LinearSettingsSectionModuleProps {
  readonly integrationClient?: IntegrationClient | undefined;
  readonly projects?: ReadonlyArray<ProjectSummary> | undefined;
  readonly onProjectLinearTargetChange?:
    | ((projectId: ProjectId, target: ProjectLinearTarget | null) => Promise<boolean>)
    | undefined;
  readonly focusedSetting?: SettingsSettingId | undefined;
}

/**
 * Adapter that exposes Linear connection settings as a plugin-loadable
 * settings-section module. The concrete client stays inside the host module
 * registry rather than leaking into the generic plugin seam.
 */
export default function LinearSettingsSectionModule(props: LinearSettingsSectionModuleProps) {
  if (props.integrationClient === undefined) {
    return (
      <section aria-label="Linear" id="settings-linear">
        <p>
          Linear is set up on the computer that owns it. Open Settings there to set it up or inspect
          the workspace.
        </p>
      </section>
    );
  }
  return (
    <LinearConnectionSettings
      client={props.integrationClient}
      {...(props.projects === undefined ? {} : { projects: props.projects })}
      {...(props.onProjectLinearTargetChange === undefined
        ? {}
        : { onProjectLinearTargetChange: props.onProjectLinearTargetChange })}
      {...(props.focusedSetting === undefined ? {} : { focusedSetting: props.focusedSetting })}
    />
  );
}
