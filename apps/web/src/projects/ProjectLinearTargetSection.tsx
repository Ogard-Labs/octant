import { useEffect, useMemo, useState } from "react";
import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import type { ProjectLinearTarget, ProjectSummary } from "@octant/contracts";
import type { IntegrationAccountEntry } from "@octant/contracts/integration";
import type { LinearIssueFilterOptions } from "@octant/contracts/linear-issues";
import { formatProjectLinearTarget } from "@octant/domain";
import {
  linearAccountDisplayLabel,
  readyLinearAccounts,
} from "../linear/linearIssuesReadAvailable";
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
 * Per-Project Linear account, team, and optional Linear project selector inside
 * Project Overview. Reads accounts, teams, and projects through the connected
 * Linear integration and delegates persistence to the host Project command.
 */
export function ProjectLinearTargetSection(props: ProjectLinearTargetSectionProps) {
  const { project, linearClient, disabled, onChoose } = props;
  const current = project.linearTarget;
  const [accounts, setAccounts] = useState<ReadonlyArray<IntegrationAccountEntry>>();
  const [selectedAccountRef, setSelectedAccountRef] = useState<string | undefined>(
    current?.accountRef,
  );
  const [filters, setFilters] = useState<LinearIssueFilterOptions>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    const readAccounts = linearClient.accountsSnapshot;
    if (typeof readAccounts !== "function") {
      setAccounts(undefined);
      return;
    }
    void readAccounts.call(linearClient).then(
      (snapshot) => {
        if (!active) return;
        const ready = readyLinearAccounts(snapshot.accounts);
        setAccounts(ready);
        setSelectedAccountRef((previous) => {
          if (previous !== undefined && ready.some((entry) => entry.accountRef === previous)) {
            return previous;
          }
          if (current?.accountRef !== undefined) return current.accountRef;
          const legacy = ready.find((entry) => entry.isLegacy === true);
          return legacy?.accountRef ?? ready[0]?.accountRef;
        });
      },
      () => {
        if (active) setAccounts(undefined);
      },
    );
    return () => {
      active = false;
    };
  }, [linearClient, current?.accountRef]);

  const readyAccounts = useMemo(() => accounts ?? [], [accounts]);
  const isMultiAccount = readyAccounts.length > 1;
  const accountConnected =
    accounts === undefined ||
    (selectedAccountRef !== undefined &&
      readyAccounts.some((entry) => entry.accountRef === selectedAccountRef));
  const legacyRef = readyAccounts.find((entry) => entry.isLegacy === true)?.accountRef;
  const resolvedCurrentAccountRef =
    current?.accountRef ??
    (current !== undefined ? (legacyRef ?? readyAccounts[0]?.accountRef) : undefined);

  useEffect(() => {
    let active = true;
    if (!accountConnected) {
      setFilters(undefined);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(undefined);
    const load =
      selectedAccountRef === undefined
        ? linearClient.listIssueFilters()
        : linearClient.listIssueFilters(selectedAccountRef);
    void load.then(
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
  }, [linearClient, selectedAccountRef, accountConnected]);

  const teams = filters?.teams ?? [];
  const projects = filters?.projects ?? [];

  const showAccountPicker = isMultiAccount || current?.accountRef !== undefined;
  const accountOptions = [
    ...readyAccounts.map((entry) => ({
      id: entry.accountRef,
      label: linearAccountDisplayLabel(entry),
    })),
    ...(selectedAccountRef !== undefined && !accountConnected
      ? [{ id: selectedAccountRef, label: "Disconnected account (unavailable)" }]
      : []),
  ];

  const onCurrentAccount =
    current !== undefined &&
    (accounts === undefined || resolvedCurrentAccountRef === selectedAccountRef);

  const teamOptions = [
    { id: UNBOUND, label: "Not bound" },
    ...teams.map((team) => ({ id: team.id, label: team.label })),
    ...(onCurrentAccount &&
    current !== undefined &&
    !teams.some((team) => team.id === current.teamId)
      ? [{ id: current.teamId, label: `${current.teamName} (${current.teamKey})` }]
      : []),
  ];

  const projectOptions = [
    { id: ANY_PROJECT, label: "Any Linear project" },
    ...projects.map((item) => ({ id: item.id, label: item.label })),
    ...(onCurrentAccount &&
    current?.projectId !== undefined &&
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

  const selectedEntry =
    selectedAccountRef === undefined
      ? undefined
      : readyAccounts.find((entry) => entry.accountRef === selectedAccountRef);
  const shouldEmitAccountRef =
    selectedAccountRef !== undefined &&
    (isMultiAccount || current?.accountRef !== undefined || selectedEntry?.isLegacy !== true);

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
      ...(shouldEmitAccountRef ? { accountRef: selectedAccountRef } : {}),
      teamId: found.id,
      teamKey,
      teamName,
      ...(onCurrentAccount &&
      found.id === current?.teamId &&
      current.projectId !== undefined &&
      current.projectName !== undefined
        ? { projectId: current.projectId, projectName: current.projectName }
        : {}),
    });
  }

  function handleProjectChange(projectId: string) {
    if (current === undefined) return;
    if (projectId === ANY_PROJECT) {
      void save({
        ...(shouldEmitAccountRef ? { accountRef: selectedAccountRef } : {}),
        teamId: current.teamId,
        teamKey: current.teamKey,
        teamName: current.teamName,
      });
      return;
    }
    const found = projects.find((item) => item.id === projectId);
    if (found === undefined) return;
    void save({
      ...(shouldEmitAccountRef ? { accountRef: selectedAccountRef } : {}),
      teamId: current.teamId,
      teamKey: current.teamKey,
      teamName: current.teamName,
      projectId: found.id,
      projectName: found.label,
    });
  }

  const boundAccountLabel =
    resolvedCurrentAccountRef === undefined
      ? undefined
      : readyAccounts.find((entry) => entry.accountRef === resolvedCurrentAccountRef);

  return (
    <div className="linear-settings__advanced">
      <p className="linear-settings__note">
        {current === undefined
          ? "Not bound to a Linear team. Choose a team to scope Create from…, the Linear browser, and octant_linear reads to this Project."
          : boundAccountLabel !== undefined && isMultiAccount
            ? `Bound to ${linearAccountDisplayLabel(boundAccountLabel)} · ${formatProjectLinearTarget(current)}.`
            : accounts !== undefined && !accountConnected
              ? `Bound to ${formatProjectLinearTarget(current)} (account unavailable — reconnect in Settings to restore).`
              : `Bound to ${formatProjectLinearTarget(current)}.`}
      </p>
      {loading ? (
        <p className="linear-settings__note">Loading Linear teams…</p>
      ) : (
        <div className="linear-settings__controls">
          {showAccountPicker && accountOptions.length > 0 ? (
            <OctantSelectField
              aria-label="Linear account"
              disabled={disabled === true || saving || onChoose === undefined}
              onValueChange={setSelectedAccountRef}
              options={accountOptions}
              placeholder="Choose account"
              value={selectedAccountRef ?? ""}
            />
          ) : null}
          <OctantSelectField
            aria-label="Linear team"
            disabled={disabled === true || saving || onChoose === undefined}
            onValueChange={handleTeamChange}
            options={teamOptions}
            placeholder="Not bound"
            value={onCurrentAccount && current !== undefined ? current.teamId : UNBOUND}
          />
          {onCurrentAccount && current !== undefined && projects.length > 0 ? (
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
