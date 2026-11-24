import { useEffect, useState } from "react";
import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import type { ProjectLinearTarget, ProjectSummary } from "@octant/contracts";
import type { LinearIssueFilterOptions } from "@octant/contracts/linear-issues";
import { formatProjectLinearTarget } from "@octant/domain";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantSelectField } from "../ui/base/OctantSelect";

const UNBOUND = "__none__";
const ANY_PROJECT = "__any__";

export interface ProjectLinearTargetSectionProps {
  readonly project: Exclude<ProjectSummary, { readonly type: "chat" }>;
  readonly linearClient: IntegrationClient;
  readonly disabled?: boolean;
  readonly onChoose?: (target: ProjectLinearTarget | null) => Promise<boolean>;
}

/**
 * Per-Project Linear team and optional Linear project selector inside Project
 * Overview. Reads teams and projects through the connected Linear integration
 * and delegates persistence to the host Project command.
 */
export function ProjectLinearTargetSection(props: ProjectLinearTargetSectionProps) {
  const { project, linearClient, disabled, onChoose } = props;
  const [filters, setFilters] = useState<LinearIssueFilterOptions>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    void linearClient.listIssueFilters().then(
      (options) => {
        if (!active) return;
        setFilters(options);
        setLoading(false);
      },
      (err: unknown) => {
        if (!active) return;
        setFilters(undefined);
        setError(err instanceof Error ? err.message : "Linear teams could not be loaded.");
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [linearClient]);

  const current = project.linearTarget;
  const teams = filters?.teams ?? [];
  const projects = filters?.projects ?? [];

  const teamOptions = [
    { id: UNBOUND, label: "Not bound" },
    ...teams.map((team) => ({ id: team.id, label: team.label })),
    ...(current !== undefined && !teams.some((team) => team.id === current.teamId)
      ? [{ id: current.teamId, label: `${current.teamName} (${current.teamKey})` }]
      : []),
  ];

  const projectOptions = [
    { id: ANY_PROJECT, label: "Any Linear project" },
    ...projects.map((item) => ({ id: item.id, label: item.label })),
    ...(current?.projectId !== undefined &&
    current.projectName !== undefined &&
    !projects.some((item) => item.id === current.projectId)
      ? [{ id: current.projectId, label: current.projectName }]
      : []),
  ];

  async function save(next: ProjectLinearTarget | null) {
    if (onChoose === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      const ok = await onChoose(next);
      if (!ok) setError("Could not update this Project's Linear binding.");
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Could not update this Project's Linear binding.",
      );
    } finally {
      setSaving(false);
    }
  }

  function handleTeamChange(teamId: string) {
    if (teamId === UNBOUND) {
      void save(null);
      return;
    }
    const found = teams.find((team) => team.id === teamId);
    if (found === undefined) return;
    const teamKey = found.key ?? extractTeamKey(found.label);
    const teamName = found.name ?? extractTeamName(found.label);
    if (teamKey === undefined) return;
    void save({
      teamId: found.id,
      teamKey,
      teamName,
      ...(current?.projectId !== undefined && current.projectName !== undefined
        ? { projectId: current.projectId, projectName: current.projectName }
        : {}),
    });
  }

  function handleProjectChange(projectId: string) {
    if (current === undefined) return;
    if (projectId === ANY_PROJECT) {
      void save({
        teamId: current.teamId,
        teamKey: current.teamKey,
        teamName: current.teamName,
      });
      return;
    }
    const found = projects.find((item) => item.id === projectId);
    if (found === undefined) return;
    void save({
      teamId: current.teamId,
      teamKey: current.teamKey,
      teamName: current.teamName,
      projectId: found.id,
      projectName: found.label,
    });
  }

  return (
    <div className="linear-settings__advanced">
      <p className="linear-settings__note">
        {current === undefined
          ? "Not bound to a Linear team. Choose a team to scope Create from…, the Linear browser, and octant_linear reads to this Project."
          : `Bound to ${formatProjectLinearTarget(current)}.`}
      </p>
      {loading ? (
        <p className="linear-settings__note">Loading Linear teams…</p>
      ) : (
        <div className="linear-settings__controls">
          <OctantSelectField
            aria-label="Linear team"
            disabled={disabled === true || saving || onChoose === undefined}
            onValueChange={handleTeamChange}
            options={teamOptions}
            placeholder="Not bound"
            value={current?.teamId ?? UNBOUND}
          />
          {current !== undefined && projects.length > 0 ? (
            <OctantSelectField
              aria-label="Linear project"
              disabled={disabled === true || saving || onChoose === undefined}
              onValueChange={handleProjectChange}
              options={projectOptions}
              placeholder="Any Linear project"
              value={current.projectId ?? ANY_PROJECT}
            />
          ) : null}
        </div>
      )}
      {error === undefined ? null : <OctantAlert tone="warning">{error}</OctantAlert>}
    </div>
  );
}

function extractTeamKey(label: string): string | undefined {
  const match = /\(([A-Z][A-Z0-9]{0,9})\)$/.exec(label.trim());
  return match?.[1];
}

function extractTeamName(label: string): string {
  return label.replace(/\s*\([A-Z][A-Z0-9]{0,9}\)$/, "").trim() || label;
}
