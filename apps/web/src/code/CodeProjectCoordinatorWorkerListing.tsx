import type { CoordinatorWorkerListing, ProjectId } from "@octant/contracts";
import { useState } from "react";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { CoordinatorWorkerListingChecks } from "./CodeSettingsView";
import { workerListingFor } from "./coordinatorWorkerListing";
import type { CodeController } from "./useCodeController";

/**
 * A Code Project's own Show workers choice, beside Starting workers
 * (docs/design/workspace.md#coordinators). **Use Settings** removes the
 * Project's entry, so the Settings choice applies again; any explicit choice
 * wins over Settings. It is a view preference: it changes where workers are
 * listed, never what they may do. The whole override map is sent because the
 * host replaces the stored one with what it receives.
 */
export function CodeProjectCoordinatorWorkerListing(props: {
  readonly controller: Pick<CodeController, "bootstrap" | "status" | "updateSettings">;
  readonly projectId: ProjectId;
}) {
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState(false);
  const settings = props.controller.bootstrap?.settings;
  if (settings === undefined) return null;
  const overrides = settings.coordinatorWorkerListingByProject ?? {};
  const own = overrides[props.projectId];
  const useSettings = own === undefined;
  const shown = workerListingFor(settings, String(props.projectId));

  async function save(next: CoordinatorWorkerListing | "use-settings") {
    if (settings === undefined) return;
    const others = Object.fromEntries(
      Object.entries(overrides).filter(([projectId]) => projectId !== String(props.projectId)),
    );
    setSaving(true);
    setRefused(false);
    let saved = false;
    try {
      saved = await props.controller.updateSettings({
        defaultExecutionPolicy: settings.defaultExecutionPolicy,
        defaultPermissionPersistence: settings.defaultPermissionPersistence,
        // The host replaces the external editor with whatever a settings
        // update carries, so leaving it out would erase the person's editor.
        ...(settings.externalEditor === undefined
          ? {}
          : { externalEditor: settings.externalEditor }),
        coordinatorWorkerListingByProject:
          next === "use-settings" ? others : { ...others, [props.projectId]: next },
      });
    } catch {
      saved = false;
    }
    setSaving(false);
    setRefused(!saved);
  }

  const busy = saving || props.controller.status !== "ready";
  return (
    <section aria-label="Show workers" className="code-project-planner">
      <header className="code-project-overview__section-header">
        <h2>Show workers</h2>
      </header>
      <p className="oct-row-detail">
        Where this Project's coordinators' workers are listed besides the coordinator itself.
        Requests from workers always reach Needs you.
      </p>
      <div className="coordinator-worker-listing">
        <label className="coordinator-worker-listing__choice">
          <OctantCheckbox
            checked={useSettings}
            disabled={busy}
            onChange={(event) =>
              void save(event.currentTarget.checked ? "use-settings" : { ...shown })
            }
          />
          <span>Use Settings</span>
        </label>
      </div>
      <CoordinatorWorkerListingChecks
        disabled={busy || useSettings}
        label="Show workers in this Project"
        onChange={(next) => void save(next)}
        value={shown}
      />
      {refused ? (
        <p className="oct-row-detail" role="status">
          This choice could not be saved.
        </p>
      ) : null}
    </section>
  );
}
