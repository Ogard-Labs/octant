import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import { LinearConnectionSettings } from "./LinearConnectionSettings";

export interface LinearSettingsSectionModuleProps {
  readonly integrationClient?: IntegrationClient | undefined;
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
          The Linear connection is managed on the owning host. Open Settings on that host to set it
          up or inspect the workspace.
        </p>
      </section>
    );
  }
  return <LinearConnectionSettings client={props.integrationClient} />;
}
