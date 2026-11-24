import { useCallback, useEffect, useRef, useState } from "react";
import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import type {
  ProjectId,
  ProjectLinearTarget,
  ProjectSummary,
  SettingsSettingId,
} from "@octant/contracts";
import type {
  IntegrationAuthenticationSnapshot,
  IntegrationAuthenticationState,
} from "@octant/contracts/integration";
import type { LinearIssueFilterOptions } from "@octant/contracts/linear-issues";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import {
  SettingRow,
  SettingsFactList,
  SettingsSection,
  SettingsState,
  useRevealedFocus,
} from "./primitives";

const LINEAR_API_KEYS_URL = "https://linear.app/settings/account/security";
const UNBOUND = "__none__";
const ANY_PROJECT = "__any__";

export interface LinearConnectionSettingsProps {
  readonly client: IntegrationClient;
  /** Active host Projects eligible for Linear team/project mapping. */
  readonly projects?: ReadonlyArray<ProjectSummary>;
  /** Local-host-only Project mutation; absent on remote/read-only windows. */
  readonly onProjectLinearTargetChange?: (
    projectId: ProjectId,
    target: ProjectLinearTarget | null,
  ) => Promise<boolean>;
  readonly focusedSetting?: SettingsSettingId | undefined;
}

type SnapshotState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly snapshot: IntegrationAuthenticationSnapshot };

const STATE_LABELS: Readonly<Record<IntegrationAuthenticationState, string>> = {
  ready: "Connected",
  "scope-limited": "Connected (limited scopes)",
  unauthorized: "Not connected",
  "external-token": "Blocked: ambient token detected",
  "rate-limited": "Rate limited",
  unavailable: "Unavailable",
};

export function LinearConnectionSettings({
  client,
  projects,
  onProjectLinearTargetChange,
  focusedSetting,
}: LinearConnectionSettingsProps) {
  const [snapshotState, setSnapshotState] = useState<SnapshotState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandError, setCommandError] = useState<string>();
  const [disconnectArmed, setDisconnectArmed] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [personalKey, setPersonalKey] = useState("");
  const [personalBusy, setPersonalBusy] = useState(false);
  const [filters, setFilters] = useState<LinearIssueFilterOptions>();
  const [filtersLoading, setFiltersLoading] = useState(false);
  const [catalogueRevision, setCatalogueRevision] = useState(0);
  const [savingProjectId, setSavingProjectId] = useState<string>();
  const [mappingError, setMappingError] = useState<string>();
  const projectsGroupRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setCommandError(undefined);
    try {
      const snapshot = await client.authenticationSnapshot();
      setSnapshotState({ kind: "ready", snapshot });
      setCatalogueRevision((revision) => revision + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Linear status is unavailable.";
      setSnapshotState((current) =>
        current.kind === "ready" ? current : { kind: "error", message },
      );
      setCommandError(message);
    } finally {
      setRefreshing(false);
    }
  }, [client]);

  useEffect(() => {
    setSnapshotState({ kind: "loading" });
    void refresh();
  }, [refresh]);

  const connectedSnapshot =
    snapshotState.kind === "ready" &&
    (snapshotState.snapshot.state === "ready" || snapshotState.snapshot.state === "scope-limited");
  const catalogueKey = connectedSnapshot
    ? `${snapshotState.snapshot.account?.login ?? ""}|${snapshotState.snapshot.account?.displayName ?? ""}|${snapshotState.snapshot.account?.source ?? ""}|${String(catalogueRevision)}`
    : undefined;

  const bindableProjects = (projects ?? []).filter(
    (project): project is Exclude<ProjectSummary, { readonly type: "chat" }> =>
      project.type !== "chat" && project.lifecycle === "active",
  );

  useEffect(() => {
    if (catalogueKey === undefined || bindableProjects.length === 0) {
      setFilters(undefined);
      setFiltersLoading(false);
      return;
    }
    let active = true;
    setFilters(undefined);
    setFiltersLoading(true);
    void client.listIssueFilters().then(
      (options) => {
        if (!active) return;
        setFilters(options);
        setFiltersLoading(false);
      },
      () => {
        if (!active) return;
        setFilters(undefined);
        setFiltersLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [client, catalogueKey, bindableProjects.length]);

  const focusedId = focusedSetting === undefined ? undefined : String(focusedSetting);

  useRevealedFocus(
    projectsGroupRef,
    focusedId === "linear-projects" &&
      connectedSnapshot &&
      bindableProjects.length > 0 &&
      !filtersLoading,
  );

  const runCommand = async (kind: "setup" | "refresh" | "logout") => {
    setCommandBusy(true);
    setCommandError(undefined);
    try {
      const snapshot = await client.executeAuthenticationCommand({ kind });
      setSnapshotState({ kind: "ready", snapshot });
      setCatalogueRevision((revision) => revision + 1);
    } catch (error) {
      setCommandError(
        error instanceof Error ? error.message : "The Linear command could not be delivered.",
      );
    } finally {
      setCommandBusy(false);
      setDisconnectArmed(false);
    }
  };

  if (snapshotState.kind === "loading") {
    return (
      <section aria-label="Linear" className="linear-settings" id="settings-linear">
        <SettingsState kind="loading">Loading Linear status…</SettingsState>
      </section>
    );
  }

  if (snapshotState.kind === "error") {
    return (
      <section aria-label="Linear" className="linear-settings" id="settings-linear">
        <SettingsState kind="error">{snapshotState.message}</SettingsState>
        <OctantButton
          onClick={() => {
            setSnapshotState({ kind: "loading" });
            void refresh();
          }}
          type="button"
          variant="secondary"
        >
          Retry
        </OctantButton>
      </section>
    );
  }

  const { snapshot } = snapshotState;
  const account = snapshot.account;
  const connected = snapshot.state === "ready" || snapshot.state === "scope-limited";
  const personalKeyStored =
    snapshot.personalCredentialStored === true || account?.source === "personal-api-key";
  const linkedCount = bindableProjects.filter(
    (project) => project.linearTarget !== undefined,
  ).length;
  const reconnect =
    snapshot.state === "unauthorized" &&
    snapshot.remediation !== undefined &&
    snapshot.remediation.includes("Reconnect");
  const authorizationUri =
    snapshot.interaction?.kind === "authorization-redirect"
      ? snapshot.interaction.authorizationUri
      : undefined;

  const teams = filters?.teams ?? [];
  const linearProjects = filters?.projects ?? [];

  async function saveMapping(projectId: ProjectId, next: ProjectLinearTarget | null) {
    if (onProjectLinearTargetChange === undefined) return;
    setSavingProjectId(String(projectId));
    setMappingError(undefined);
    try {
      const ok = await onProjectLinearTargetChange(projectId, next);
      if (!ok) setMappingError("Could not save the Project's Linear binding.");
    } catch (error: unknown) {
      setMappingError(
        error instanceof Error ? error.message : "Could not save the Project's Linear binding.",
      );
    } finally {
      setSavingProjectId(undefined);
    }
  }

  return (
    <section
      aria-label="Linear"
      aria-busy={refreshing}
      className="linear-settings"
      id="settings-linear"
    >
      <SettingsSection description="Linear authentication on the selected host." title="Workspace">
        <SettingsFactList
          facts={[
            { label: "State", value: STATE_LABELS[snapshot.state] },
            ...(account?.displayName === undefined
              ? []
              : [{ label: "User", value: account.displayName }]),
            ...(account === undefined ? [] : [{ label: "Workspace", value: account.login }]),
            ...(account === undefined ? [] : [{ label: "Source", value: account.source }]),
            ...(connected && projects !== undefined
              ? [
                  {
                    label: "Linked projects",
                    value:
                      linkedCount === 1
                        ? "1 project linked"
                        : `${String(linkedCount)} projects linked`,
                  },
                ]
              : []),
          ]}
        />
        {snapshot.remediation === undefined ? null : (
          <p className="settings-section-line">{snapshot.remediation}</p>
        )}
        {authorizationUri === undefined ? null : (
          <p className="settings-section-line">
            Continue in Linear:{" "}
            <a href={authorizationUri} rel="noreferrer" target="_blank">
              Approve access
            </a>
            , then refresh the status.
          </p>
        )}
      </SettingsSection>

      <SettingsSection title="Connection">
        <div className="setgroup">
          <SettingRow
            description="Connect or reconnect, and refresh what Octant sees."
            focused={focusedId === "linear-connection"}
            label="Connection"
            labelledBySection
            scope="host"
            settingId="linear-connection"
          >
            <div className="linear-settings__controls">
              {snapshot.state === "unauthorized" ? (
                <OctantButton
                  disabled={commandBusy || refreshing}
                  onClick={() => void runCommand("setup")}
                  type="button"
                  variant="secondary"
                >
                  {reconnect ? "Reconnect" : "Connect"}
                </OctantButton>
              ) : null}
              <OctantButton
                disabled={commandBusy || refreshing}
                onClick={() => void refresh()}
                type="button"
                variant="secondary"
              >
                Refresh status
              </OctantButton>
            </div>
          </SettingRow>
        </div>
        <OctantDialogPresence>
          {connected && disconnectArmed ? (
            <OctantConfirmDialog
              confirmLabel="Confirm disconnect"
              destructive
              onCancel={() => setDisconnectArmed(false)}
              onConfirm={() => {
                setDisconnectArmed(false);
                void runCommand("logout");
              }}
              title="Disconnect Linear?"
            >
              Remove this host&apos;s Linear connection? You can reconnect later.
            </OctantConfirmDialog>
          ) : null}
        </OctantDialogPresence>
        <div className="settings-feedback-slot" aria-live="polite">
          {commandError === undefined ? null : (
            <SettingsState kind="error">{commandError}</SettingsState>
          )}
        </div>
      </SettingsSection>

      {connected && bindableProjects.length > 0 ? (
        <SettingsSection
          description="Pick the Linear team (and optional Linear project) each Project scopes its issues and octant_linear reads to."
          title="Projects"
        >
          {filtersLoading && teams.length === 0 ? (
            <p className="settings-section-line">Loading Linear teams…</p>
          ) : (
            <div className="setgroup" ref={projectsGroupRef} tabIndex={-1}>
              {bindableProjects.map((project) => {
                const current = project.linearTarget;
                const busy = savingProjectId === String(project.id);
                const teamOptions = [
                  { id: UNBOUND, label: "Not bound" },
                  ...teams.map((team) => ({ id: team.id, label: team.label })),
                  ...(current !== undefined && !teams.some((team) => team.id === current.teamId)
                    ? [{ id: current.teamId, label: `${current.teamName} (${current.teamKey})` }]
                    : []),
                ];
                const projectOptions = [
                  { id: ANY_PROJECT, label: "Any Linear project" },
                  ...linearProjects.map((item) => ({ id: item.id, label: item.label })),
                  ...(current?.projectId !== undefined &&
                  current.projectName !== undefined &&
                  !linearProjects.some((item) => item.id === current.projectId)
                    ? [{ id: current.projectId, label: current.projectName }]
                    : []),
                ];
                return (
                  <SettingRow
                    description={project.type === "code" ? "Code Project" : "Work Project"}
                    focused={focusedId === `linear-project-${String(project.id)}`}
                    key={String(project.id)}
                    label={project.name}
                    scope="host"
                    settingId={`linear-project-${String(project.id)}`}
                  >
                    <div className="linear-settings__controls">
                      <OctantSelectField
                        aria-label={`${project.name} Linear team`}
                        disabled={busy || onProjectLinearTargetChange === undefined}
                        onValueChange={(teamId) => {
                          if (teamId === UNBOUND) {
                            void saveMapping(project.id, null);
                            return;
                          }
                          const found = teams.find((team) => team.id === teamId);
                          if (found === undefined) return;
                          const teamKey = found.key ?? extractTeamKey(found.label);
                          const teamName = found.name ?? extractTeamName(found.label);
                          if (teamKey === undefined) return;
                          void saveMapping(project.id, {
                            teamId: found.id,
                            teamKey,
                            teamName,
                            ...(found.id === current?.teamId &&
                            current.projectId !== undefined &&
                            current.projectName !== undefined
                              ? { projectId: current.projectId, projectName: current.projectName }
                              : {}),
                          });
                        }}
                        options={teamOptions}
                        placeholder="Not bound"
                        value={current?.teamId ?? UNBOUND}
                      />
                      {current !== undefined && linearProjects.length > 0 ? (
                        <OctantSelectField
                          aria-label={`${project.name} Linear project`}
                          disabled={busy || onProjectLinearTargetChange === undefined}
                          onValueChange={(linearProjectId) => {
                            if (linearProjectId === ANY_PROJECT) {
                              void saveMapping(project.id, {
                                teamId: current.teamId,
                                teamKey: current.teamKey,
                                teamName: current.teamName,
                              });
                              return;
                            }
                            const found = linearProjects.find(
                              (item) => item.id === linearProjectId,
                            );
                            if (found === undefined) return;
                            void saveMapping(project.id, {
                              teamId: current.teamId,
                              teamKey: current.teamKey,
                              teamName: current.teamName,
                              projectId: found.id,
                              projectName: found.label,
                            });
                          }}
                          options={projectOptions}
                          placeholder="Any Linear project"
                          value={current.projectId ?? ANY_PROJECT}
                        />
                      ) : null}
                    </div>
                  </SettingRow>
                );
              })}
            </div>
          )}
          <div className="settings-feedback-slot" aria-live="polite">
            {mappingError === undefined ? null : (
              <SettingsState kind="error">{mappingError}</SettingsState>
            )}
          </div>
        </SettingsSection>
      ) : null}

      <SettingsSection
        description="A personal API key is stored in the same host secret store as OAuth tokens, and is never used as an OAuth fallback."
        title="Advanced"
      >
        <div className="linear-settings__controls">
          <OctantButton
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
            type="button"
            variant="ghost"
          >
            Personal API key
          </OctantButton>
        </div>
        {advancedOpen ? (
          <div className="linear-settings__advanced">
            <label className="linear-settings__note" htmlFor="linear-personal-api-key">
              Personal API key
            </label>
            <p className="linear-settings__note">
              {personalKeyStored
                ? "A personal API key is stored on this host. "
                : "Stored on this host. "}
              <a href={LINEAR_API_KEYS_URL} rel="noreferrer" target="_blank">
                Create one
              </a>
            </p>
            <OctantInput
              autoComplete="off"
              id="linear-personal-api-key"
              onChange={(event) => setPersonalKey(event.currentTarget.value)}
              placeholder={
                personalKeyStored ? "Stored secret, enter a new key to replace" : "lin_api_…"
              }
              type="password"
              value={personalKey}
            />
            <div className="linear-settings__controls">
              <OctantButton
                disabled={personalBusy || personalKey.trim().length === 0}
                onClick={() => {
                  setPersonalBusy(true);
                  void client
                    .storePersonalCredential(personalKey)
                    .then(() => {
                      setPersonalKey("");
                      return refresh();
                    })
                    .catch((error: unknown) => {
                      setCommandError(
                        error instanceof Error
                          ? error.message
                          : "The personal API key could not be stored.",
                      );
                    })
                    .finally(() => setPersonalBusy(false));
                }}
                type="button"
                variant="secondary"
              >
                Store key
              </OctantButton>
              <OctantButton
                disabled={personalBusy || !personalKeyStored}
                onClick={() => {
                  setPersonalBusy(true);
                  void client
                    .deletePersonalCredential()
                    .then(() => refresh())
                    .catch((error: unknown) => {
                      setCommandError(
                        error instanceof Error
                          ? error.message
                          : "The personal API key could not be removed.",
                      );
                    })
                    .finally(() => setPersonalBusy(false));
                }}
                type="button"
                variant="secondary"
              >
                Remove key
              </OctantButton>
            </div>
          </div>
        ) : null}
      </SettingsSection>

      {connected ? (
        <SettingsSection tone="danger" title="Disconnect">
          <div className="setgroup">
            <SettingRow
              description="Removes Octant's Linear sign-in from this host. Your Linear workspace is untouched."
              focused={focusedId === "linear-disconnect"}
              label="Disconnect Linear"
              scope="host"
              settingId="linear-disconnect"
            >
              <OctantButton
                aria-expanded={disconnectArmed}
                aria-haspopup="dialog"
                disabled={commandBusy || refreshing}
                onClick={() => setDisconnectArmed(true)}
                type="button"
                variant="secondary"
              >
                Disconnect
              </OctantButton>
            </SettingRow>
          </div>
        </SettingsSection>
      ) : null}
    </section>
  );
}

function extractTeamKey(label: string): string | undefined {
  const match = /\(([A-Z][A-Z0-9]{0,9})\)$/.exec(label.trim());
  return match?.[1];
}

function extractTeamName(label: string): string {
  return label.replace(/\s*\([A-Z][A-Z0-9]{0,9}\)$/, "").trim() || label;
}
