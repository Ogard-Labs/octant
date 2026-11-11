import type { CoordinatorStartingChoice, ProjectId } from "@octant/contracts";
import { useState } from "react";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { COORDINATOR_STARTING_OPTIONS } from "./CodeSettingsView";
import type { CodeController } from "./useCodeController";

type ProjectStartingChoice = CoordinatorStartingChoice | "use-settings";

/**
 * A Code Project's own Starting workers choice, beside its planner
 * (docs/design/coordinator-threads.md#the-start-setting). Use Settings removes
 * the Project's entry, so the Settings choice applies again; any other value
 * wins over Settings. The whole override map is sent because the host replaces
 * the stored one with what it receives.
 */
export function CodeProjectCoordinatorStarting(props: {
  readonly controller: Pick<CodeController, "bootstrap" | "status" | "updateSettings">;
  readonly projectId: ProjectId;
}) {
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState(false);
  const settings = props.controller.bootstrap?.settings;
  if (settings === undefined) return null;
  const overrides = settings.coordinatorStartingByProject ?? {};
  const stored = overrides[props.projectId];
  const value: ProjectStartingChoice = stored ?? "use-settings";
  const settingsLabel =
    COORDINATOR_STARTING_OPTIONS.find(
      (option) => option.id === (settings.coordinatorStarting ?? "start-without-asking"),
    )?.label ?? "Start without asking";

  async function choose(next: ProjectStartingChoice) {
    if (settings === undefined || next === value) return;
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
        coordinatorStartingByProject:
          next === "use-settings" ? others : { ...others, [props.projectId]: next },
      });
    } catch {
      saved = false;
    }
    setSaving(false);
    setRefused(!saved);
  }

  return (
    <section aria-label="Starting workers" className="code-project-planner">
      <header className="code-project-overview__section-header">
        <h2>Starting workers</h2>
      </header>
      <p className="oct-row-detail">
        Whether this Project's coordinators start each worker themselves or propose it for you to
        approve.
      </p>
      <div className="code-project-planner__controls">
        <OctantSelectField
          aria-label="Starting workers in this Project"
          disabled={saving || props.controller.status !== "ready"}
          onValueChange={(next) => {
            if (next === "use-settings") {
              void choose(next);
              return;
            }
            const option = COORDINATOR_STARTING_OPTIONS.find((candidate) => candidate.id === next);
            if (option !== undefined) void choose(option.id);
          }}
          options={[
            { id: "use-settings", label: `Use Settings (${settingsLabel})` },
            ...COORDINATOR_STARTING_OPTIONS,
          ]}
          value={value}
        />
      </div>
      {refused ? (
        <p className="oct-row-detail" role="status">
          This choice could not be saved.
        </p>
      ) : null}
    </section>
  );
}
