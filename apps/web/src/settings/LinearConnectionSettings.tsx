import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IntegrationClientFailure,
  type IntegrationClient,
} from "@octant/client-runtime/integration-client";
import type {
  ProjectId,
  ProjectLinearTarget,
  ProjectSummary,
  SettingsSettingId,
} from "@octant/contracts";
import type {
  IntegrationAccountEntry,
  IntegrationAccountsSnapshot,
  IntegrationAuthenticationSnapshot,
  IntegrationAuthenticationState,
} from "@octant/contracts/integration";
import {
  linearIssueBrowseAvailable,
  type LinearIssueFilterOptions,
} from "@octant/contracts/linear-issues";
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
  | { readonly kind: "single"; readonly snapshot: IntegrationAuthenticationSnapshot }
  | { readonly kind: "multi"; readonly snapshot: IntegrationAccountsSnapshot };

const STATE_LABELS: Readonly<Record<IntegrationAuthenticationState, string>> = {
  ready: "Connected",
  "scope-limited": "Connected (limited scopes)",
  unauthorized: "Not connected",
  "external-token": "Blocked: ambient token detected",
  "rate-limited": "Rate limited",
  unavailable: "Unavailable",
};

function accountLabel(entry: IntegrationAccountEntry): string {
  return entry.account?.workspace ?? entry.account?.login ?? entry.accountRef;
}

function accountIsConnected(entry: IntegrationAccountEntry): boolean {
  return (
    entry.reconnectRequired !== true && (entry.state === "ready" || entry.state === "scope-limited")
  );
}

function accountNeedsReconnect(entry: IntegrationAccountEntry): boolean {
  return (
    entry.reconnectRequired === true ||
    (entry.state === "unauthorized" &&
      entry.remediation !== undefined &&
      entry.remediation.includes("Reconnect"))
  );
}

function isLegacyHostRouteMissing(error: unknown): boolean {
  return (
    error instanceof IntegrationClientFailure &&
    (error.status === 400 || error.status === 404 || error.status === 503)
  );
}

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
  const [authorizationUri, setAuthorizationUri] = useState<string>();
  const [disconnectTarget, setDisconnectTarget] = useState<
    | { readonly kind: "single" }
    | { readonly kind: "account"; readonly entry: IntegrationAccountEntry }
  >();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [personalKey, setPersonalKey] = useState("");
  const [personalBusy, setPersonalBusy] = useState(false);
  const [filtersByAccount, setFiltersByAccount] = useState<
    ReadonlyMap<string, LinearIssueFilterOptions>
  >(() => new Map());
  const [filtersLoading, setFiltersLoading] = useState(false);
  const [catalogueRevision, setCatalogueRevision] = useState(0);
  const [savingProjectId, setSavingProjectId] = useState<string>();
  const [mappingError, setMappingError] = useState<string>();
  const [selectedProjectAccounts, setSelectedProjectAccounts] = useState<
    Readonly<Record<string, string>>
  >({});
  const projectsGroupRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setCommandError(undefined);
    try {
      if (typeof client.accountsSnapshot === "function") {
        try {
          const multi = await client.accountsSnapshot();
          setSnapshotState({ kind: "multi", snapshot: multi });
          setCatalogueRevision((revision) => revision + 1);
          return;
        } catch (error) {
          if (!isLegacyHostRouteMissing(error)) throw error;
        }
      }
      const snapshot = await client.authenticationSnapshot();
      setSnapshotState({ kind: "single", snapshot });
      setCatalogueRevision((revision) => revision + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Linear status is unavailable.";
      setSnapshotState((current) =>
        current.kind === "single" || current.kind === "multi"
          ? current
          : { kind: "error", message },
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

  const bindableProjects = useMemo(
    () =>
      (projects ?? []).filter(
        (project): project is Exclude<ProjectSummary, { readonly type: "chat" }> =>
          project.type !== "chat" && project.lifecycle === "active",
      ),
    [projects],
  );

  const readyMultiAccounts = useMemo(
    () =>
      snapshotState.kind === "multi"
        ? snapshotState.snapshot.accounts.filter(
            (entry) =>
              accountIsConnected(entry) &&
              (entry.capabilities.length === 0 || linearIssueBrowseAvailable(entry.capabilities)),
          )
        : [],
    [snapshotState],
  );

  const singleConnected =
    snapshotState.kind === "single" &&
    (snapshotState.snapshot.state === "ready" || snapshotState.snapshot.state === "scope-limited");

  const catalogueKey = useMemo(() => {
    if (snapshotState.kind === "single") {
      if (!singleConnected) return undefined;
      return `single|${snapshotState.snapshot.account?.login ?? ""}|${snapshotState.snapshot.account?.displayName ?? ""}|${snapshotState.snapshot.account?.source ?? ""}|${String(catalogueRevision)}`;
    }
    if (snapshotState.kind === "multi") {
      if (readyMultiAccounts.length === 0) return undefined;
      return `multi|${readyMultiAccounts.map((entry) => `${entry.accountRef}:${entry.account?.login ?? ""}:${entry.account?.source ?? ""}`).join(",")}|${String(catalogueRevision)}`;
    }
    return undefined;
  }, [snapshotState, singleConnected, readyMultiAccounts, catalogueRevision]);

  useEffect(() => {
    if (catalogueKey === undefined || bindableProjects.length === 0) {
      setFiltersByAccount(new Map());
      setFiltersLoading(false);
      return;
    }
    let active = true;
    setFiltersByAccount(new Map());
    setFiltersLoading(true);
    if (snapshotState.kind === "single") {
      void client.listIssueFilters().then(
        (options) => {
          if (!active) return;
          setFiltersByAccount(new Map([["__single__", options]]));
          setFiltersLoading(false);
        },
        () => {
          if (!active) return;
          setFiltersByAccount(new Map());
          setFiltersLoading(false);
        },
      );
    } else if (snapshotState.kind === "multi") {
      void Promise.all(
        readyMultiAccounts.map(async (entry) => {
          try {
            const options = await client.listIssueFilters(entry.accountRef);
            return [entry.accountRef, options] as const;
          } catch {
            return undefined;
          }
        }),
      ).then((results) => {
        if (!active) return;
        const next = new Map<string, LinearIssueFilterOptions>();
        for (const item of results) {
          if (item !== undefined) next.set(item[0], item[1]);
        }
        setFiltersByAccount(next);
        setFiltersLoading(false);
      });
    }
    return () => {
      active = false;
    };
  }, [client, catalogueKey, bindableProjects.length, snapshotState.kind, readyMultiAccounts]);

  const focusedId = focusedSetting === undefined ? undefined : String(focusedSetting);
  const hasConnectedAccounts = singleConnected || readyMultiAccounts.length > 0;

  useRevealedFocus(
    projectsGroupRef,
    focusedId === "linear-projects" &&
      hasConnectedAccounts &&
      bindableProjects.length > 0 &&
      !filtersLoading,
  );

  const runCommand = async (kind: "setup" | "refresh" | "logout", accountRef?: string) => {
    setCommandBusy(true);
    setCommandError(undefined);
    try {
      const command = accountRef === undefined ? { kind } : { kind, accountRef };
      const snapshot = await client.executeAuthenticationCommand(command);
      if (snapshot.interaction?.kind === "authorization-redirect") {
        setAuthorizationUri(snapshot.interaction.authorizationUri);
      } else if (kind !== "setup") {
        setAuthorizationUri(undefined);
      }
      if (snapshotState.kind === "multi") {
        await refresh();
      } else {
        setSnapshotState({ kind: "single", snapshot });
        setCatalogueRevision((revision) => revision + 1);
      }
    } catch (error) {
      setCommandError(
        error instanceof Error ? error.message : "The Linear command could not be delivered.",
      );
    } finally {
      setCommandBusy(false);
      setDisconnectTarget(undefined);
    }
  };

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

  if (snapshotState.kind === "single") {
    return (
      <SingleAccountLinearSettings
        advancedOpen={advancedOpen}
        authorizationUri={
          authorizationUri ??
          (snapshotState.snapshot.interaction?.kind === "authorization-redirect"
            ? snapshotState.snapshot.interaction.authorizationUri
            : undefined)
        }
        bindableProjects={bindableProjects}
        client={client}
        commandBusy={commandBusy}
        commandError={commandError}
        disconnectArmed={disconnectTarget?.kind === "single"}
        filters={filtersByAccount.get("__single__")}
        filtersLoading={filtersLoading}
        focusedId={focusedId}
        mappingError={mappingError}
        onProjectLinearTargetChange={onProjectLinearTargetChange}
        personalBusy={personalBusy}
        personalKey={personalKey}
        projects={projects}
        projectsGroupRef={projectsGroupRef}
        refresh={refresh}
        refreshing={refreshing}
        runCommand={(kind) => void runCommand(kind)}
        saveMapping={saveMapping}
        savingProjectId={savingProjectId}
        setAdvancedOpen={setAdvancedOpen}
        setCommandError={setCommandError}
        setDisconnectArmed={(armed) => setDisconnectTarget(armed ? { kind: "single" } : undefined)}
        setPersonalBusy={setPersonalBusy}
        setPersonalKey={setPersonalKey}
        snapshot={snapshotState.snapshot}
      />
    );
  }

  const { snapshot: multi } = snapshotState;
  const accounts = multi.accounts;
  const legacyRef = accounts.find((entry) => entry.isLegacy === true)?.accountRef;
  const isSingleAccountHost = readyMultiAccounts.length === 1;
  const anyAccountStored = accounts.length > 0;
  const unusedPersonalKey = multi.unusedPersonalCredentialStored === true;
  const personalKeyStored =
    unusedPersonalKey || accounts.some((entry) => entry.account?.source === "personal-api-key");
  const showAccountColumn =
    readyMultiAccounts.length > 1 ||
    bindableProjects.some((project) => project.linearTarget?.accountRef !== undefined);

  const countLinkedProjectsForAccount = (entry: IntegrationAccountEntry): number =>
    bindableProjects.filter((project) => {
      const target = project.linearTarget;
      if (target === undefined) return false;
      if (target.accountRef !== undefined) return target.accountRef === entry.accountRef;
      return entry.isLegacy === true || (legacyRef === undefined && accounts.length === 1);
    }).length;

  return (
    <section
      aria-label="Linear"
      aria-busy={refreshing}
      className="linear-settings"
      id="settings-linear"
    >
      <SettingsSection
        description="Linear accounts connected on this computer."
        title="Linear workspaces"
      >
        {multi.indexDamaged === true ? (
          <SettingsState kind="error">
            {multi.remediation ?? "The Linear accounts index is damaged."}
          </SettingsState>
        ) : accounts.length === 0 ? (
          <>
            <SettingsFactList facts={[{ label: "State", value: STATE_LABELS.unauthorized }]} />
            {multi.remediation === undefined ? (
              <p className="settings-section-line">Connect Linear to authorize this computer.</p>
            ) : (
              <p className="settings-section-line">{multi.remediation}</p>
            )}
          </>
        ) : (
          <div className="setgroup">
            {accounts.map((entry) => {
              const label = accountLabel(entry);
              const needsReconnect = accountNeedsReconnect(entry);
              const linkedCount = countLinkedProjectsForAccount(entry);
              const descriptionParts = [
                STATE_LABELS[entry.state],
                ...(entry.account?.displayName === undefined ? [] : [entry.account.displayName]),
                ...(entry.account?.source === undefined ? [] : [entry.account.source]),
                ...(projects === undefined
                  ? []
                  : [
                      linkedCount === 1
                        ? "1 project linked"
                        : `${String(linkedCount)} projects linked`,
                    ]),
              ];
              return (
                <SettingRow
                  description={descriptionParts.join(" · ")}
                  key={entry.accountRef}
                  label={label}
                  scope="host"
                  settingId={`linear-account-${entry.accountRef}`}
                >
                  <div className="linear-settings__controls">
                    {needsReconnect ? (
                      <OctantButton
                        disabled={commandBusy || refreshing}
                        onClick={() => void runCommand("setup", entry.accountRef)}
                        type="button"
                        variant="secondary"
                      >
                        Reconnect
                      </OctantButton>
                    ) : null}
                    <OctantButton
                      aria-haspopup="dialog"
                      aria-label={`Disconnect ${label}`}
                      disabled={commandBusy || refreshing}
                      onClick={() => setDisconnectTarget({ kind: "account", entry })}
                      type="button"
                      variant="secondary"
                    >
                      Disconnect
                    </OctantButton>
                  </div>
                </SettingRow>
              );
            })}
          </div>
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

      <SettingsSection title="Linear connection">
        <div className="setgroup">
          <SettingRow
            description="Connect another Linear account, or refresh what Octant sees."
            focused={focusedId === "linear-connection"}
            label="Connection"
            labelledBySection
            scope="host"
            settingId="linear-connection"
          >
            <div className="linear-settings__controls">
              {multi.indexDamaged !== true ? (
                <OctantButton
                  disabled={commandBusy || refreshing}
                  onClick={() => void runCommand("setup")}
                  type="button"
                  variant="secondary"
                >
                  {anyAccountStored ? "Connect another account" : "Connect"}
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
          {disconnectTarget?.kind === "account" ? (
            <OctantConfirmDialog
              confirmLabel="Confirm disconnect"
              destructive
              onCancel={() => setDisconnectTarget(undefined)}
              onConfirm={() => {
                const ref = disconnectTarget.entry.accountRef;
                setDisconnectTarget(undefined);
                void runCommand("logout", ref);
              }}
              title={`Disconnect ${accountLabel(disconnectTarget.entry)}?`}
            >
              Remove {accountLabel(disconnectTarget.entry)} from this computer? Other Linear
              accounts stay connected, and Projects bound to this workspace stay paused until you
              reconnect.
            </OctantConfirmDialog>
          ) : null}
        </OctantDialogPresence>
        <div className="settings-feedback-slot" aria-live="polite">
          {commandError === undefined ? null : (
            <SettingsState kind="error">{commandError}</SettingsState>
          )}
        </div>
      </SettingsSection>

      {(readyMultiAccounts.length > 0 ||
        bindableProjects.some((project) => project.linearTarget !== undefined)) &&
      bindableProjects.length > 0 ? (
        <SettingsSection
          description="Pick the Linear account, team, and optional Linear project each Project scopes its issues and octant_linear reads to."
          title="Linear projects"
        >
          {filtersLoading && filtersByAccount.size === 0 && readyMultiAccounts.length > 0 ? (
            <p className="settings-section-line">Loading Linear teams…</p>
          ) : (
            <div className="setgroup" ref={projectsGroupRef} tabIndex={-1}>
              {bindableProjects.map((project) => {
                const current = project.linearTarget;
                const busy = savingProjectId === String(project.id);
                const resolvedCurrentAccountRef =
                  current?.accountRef ??
                  (current !== undefined
                    ? (legacyRef ??
                      (readyMultiAccounts.length === 1
                        ? readyMultiAccounts[0]?.accountRef
                        : undefined))
                    : undefined);
                const selectedAccountRef =
                  selectedProjectAccounts[String(project.id)] ??
                  resolvedCurrentAccountRef ??
                  readyMultiAccounts[0]?.accountRef;
                const accountConnected =
                  selectedAccountRef !== undefined &&
                  readyMultiAccounts.some((entry) => entry.accountRef === selectedAccountRef);
                const filters =
                  selectedAccountRef === undefined
                    ? undefined
                    : filtersByAccount.get(selectedAccountRef);
                const teams = filters?.teams ?? [];
                const linearProjects = filters?.projects ?? [];
                const accountOptions = [
                  ...readyMultiAccounts.map((entry) => ({
                    id: entry.accountRef,
                    label: accountLabel(entry),
                  })),
                  ...(selectedAccountRef !== undefined && !accountConnected
                    ? [{ id: selectedAccountRef, label: "Disconnected account (unavailable)" }]
                    : []),
                ];
                const teamOptions = [
                  { id: UNBOUND, label: "Not bound" },
                  ...teams.map((team) => ({ id: team.id, label: team.label })),
                  ...(current !== undefined &&
                  resolvedCurrentAccountRef === selectedAccountRef &&
                  !teams.some((team) => team.id === current.teamId)
                    ? [{ id: current.teamId, label: `${current.teamName} (${current.teamKey})` }]
                    : []),
                ];
                const projectOptions = [
                  { id: ANY_PROJECT, label: "Any Linear project" },
                  ...linearProjects.map((item) => ({ id: item.id, label: item.label })),
                  ...(current?.projectId !== undefined &&
                  current.projectName !== undefined &&
                  resolvedCurrentAccountRef === selectedAccountRef &&
                  !linearProjects.some((item) => item.id === current.projectId)
                    ? [{ id: current.projectId, label: current.projectName }]
                    : []),
                ];
                const effectiveTeamValue =
                  current !== undefined && resolvedCurrentAccountRef === selectedAccountRef
                    ? current.teamId
                    : UNBOUND;
                const bindingUnavailable = current !== undefined && !accountConnected;
                return (
                  <SettingRow
                    description={
                      bindingUnavailable
                        ? `${project.type === "code" ? "Code Project" : "Work Project"} · Bound account is disconnected`
                        : project.type === "code"
                          ? "Code Project"
                          : "Work Project"
                    }
                    focused={focusedId === `linear-project-${String(project.id)}`}
                    key={String(project.id)}
                    label={project.name}
                    scope="host"
                    settingId={`linear-project-${String(project.id)}`}
                  >
                    <div className="linear-settings__controls">
                      {showAccountColumn && accountOptions.length > 0 ? (
                        <OctantSelectField
                          aria-label={`${project.name} Linear account`}
                          disabled={busy || onProjectLinearTargetChange === undefined}
                          onValueChange={(nextAccountRef) => {
                            setSelectedProjectAccounts((prev) => ({
                              ...prev,
                              [String(project.id)]: nextAccountRef,
                            }));
                          }}
                          options={accountOptions}
                          placeholder="Choose account"
                          value={selectedAccountRef ?? ""}
                        />
                      ) : null}
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
                          const keepProject =
                            found.id === current?.teamId &&
                            resolvedCurrentAccountRef === selectedAccountRef &&
                            current.projectId !== undefined &&
                            current.projectName !== undefined;
                          const selectedEntry = readyMultiAccounts.find(
                            (entry) => entry.accountRef === selectedAccountRef,
                          );
                          const includeAccountRef =
                            selectedAccountRef !== undefined &&
                            (!isSingleAccountHost ||
                              current?.accountRef !== undefined ||
                              selectedEntry?.isLegacy !== true);
                          void saveMapping(project.id, {
                            ...(includeAccountRef ? { accountRef: selectedAccountRef } : {}),
                            teamId: found.id,
                            teamKey,
                            teamName,
                            ...(keepProject
                              ? { projectId: current.projectId, projectName: current.projectName }
                              : {}),
                          });
                        }}
                        options={teamOptions}
                        placeholder="Not bound"
                        value={effectiveTeamValue}
                      />
                      {current !== undefined &&
                      resolvedCurrentAccountRef === selectedAccountRef &&
                      linearProjects.length > 0 ? (
                        <OctantSelectField
                          aria-label={`${project.name} Linear project`}
                          disabled={busy || onProjectLinearTargetChange === undefined}
                          onValueChange={(linearProjectId) => {
                            const selectedEntry = readyMultiAccounts.find(
                              (entry) => entry.accountRef === selectedAccountRef,
                            );
                            const includeAccountRef =
                              selectedAccountRef !== undefined &&
                              (!isSingleAccountHost ||
                                current.accountRef !== undefined ||
                                selectedEntry?.isLegacy !== true);
                            if (linearProjectId === ANY_PROJECT) {
                              void saveMapping(project.id, {
                                ...(includeAccountRef ? { accountRef: selectedAccountRef } : {}),
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
                              ...(includeAccountRef ? { accountRef: selectedAccountRef } : {}),
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
        description="A personal API key is stored in the same secret store on this computer as OAuth tokens, and is verified against Linear before being added as an account."
        title="Linear API key"
      >
        {unusedPersonalKey ? (
          <div className="linear-settings__controls">
            <p className="linear-settings__note">
              A personal API key is stored on this computer, not used.
            </p>
            {typeof client.adoptLegacyPersonalCredential === "function" ? (
              <OctantButton
                disabled={personalBusy}
                onClick={() => {
                  setPersonalBusy(true);
                  setCommandError(undefined);
                  void client
                    .adoptLegacyPersonalCredential?.()
                    .then(() => refresh())
                    .catch((error: unknown) => {
                      setCommandError(
                        error instanceof Error
                          ? error.message
                          : "The stored personal API key could not be added.",
                      );
                    })
                    .finally(() => setPersonalBusy(false));
                }}
                type="button"
                variant="secondary"
              >
                Add as account
              </OctantButton>
            ) : null}
            <OctantButton
              disabled={personalBusy}
              onClick={() => {
                setPersonalBusy(true);
                setCommandError(undefined);
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
        ) : null}
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
                ? "A personal API key is stored on this computer. "
                : "Stored on this computer. "}
              <a href={LINEAR_API_KEYS_URL} rel="noreferrer" target="_blank">
                Create one
              </a>
            </p>
            <OctantInput
              autoComplete="off"
              id="linear-personal-api-key"
              onChange={(event) => setPersonalKey(event.currentTarget.value)}
              placeholder={
                personalKeyStored ? "Stored secret, enter a new key to add or replace" : "lin_api_…"
              }
              type="password"
              value={personalKey}
            />
            <div className="linear-settings__controls">
              <OctantButton
                disabled={personalBusy || personalKey.trim().length === 0}
                onClick={() => {
                  setPersonalBusy(true);
                  setCommandError(undefined);
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
            </div>
          </div>
        ) : null}
      </SettingsSection>
    </section>
  );
}

interface SingleAccountProps {
  readonly snapshot: IntegrationAuthenticationSnapshot;
  readonly client: IntegrationClient;
  readonly projects?: ReadonlyArray<ProjectSummary> | undefined;
  readonly bindableProjects: ReadonlyArray<Exclude<ProjectSummary, { readonly type: "chat" }>>;
  readonly onProjectLinearTargetChange?: LinearConnectionSettingsProps["onProjectLinearTargetChange"];
  readonly focusedId?: string | undefined;
  readonly refreshing: boolean;
  readonly commandBusy: boolean;
  readonly commandError?: string | undefined;
  readonly authorizationUri?: string | undefined;
  readonly disconnectArmed: boolean;
  readonly advancedOpen: boolean;
  readonly personalKey: string;
  readonly personalBusy: boolean;
  readonly filters?: LinearIssueFilterOptions | undefined;
  readonly filtersLoading: boolean;
  readonly savingProjectId?: string | undefined;
  readonly mappingError?: string | undefined;
  readonly projectsGroupRef: React.RefObject<HTMLDivElement | null>;
  readonly refresh: () => Promise<void>;
  readonly runCommand: (kind: "setup" | "refresh" | "logout") => void;
  readonly saveMapping: (projectId: ProjectId, next: ProjectLinearTarget | null) => Promise<void>;
  readonly setDisconnectArmed: (armed: boolean) => void;
  readonly setAdvancedOpen: React.Dispatch<React.SetStateAction<boolean>>;
  readonly setPersonalKey: (value: string) => void;
  readonly setPersonalBusy: (busy: boolean) => void;
  readonly setCommandError: (message: string | undefined) => void;
}

/**
 * Fallback single-account view used when connected to an older host that does
 * not expose `GET /api/integrations/linear/accounts`.
 */
function SingleAccountLinearSettings(props: SingleAccountProps) {
  const { snapshot, client, projects, bindableProjects, filters } = props;
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
  const teams = filters?.teams ?? [];
  const linearProjects = filters?.projects ?? [];

  return (
    <section
      aria-label="Linear"
      aria-busy={props.refreshing}
      className="linear-settings"
      id="settings-linear"
    >
      <SettingsSection
        description="Linear authentication on the selected computer."
        title="Linear workspace"
      >
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
        {props.authorizationUri === undefined ? null : (
          <p className="settings-section-line">
            Continue in Linear:{" "}
            <a href={props.authorizationUri} rel="noreferrer" target="_blank">
              Approve access
            </a>
            , then refresh the status.
          </p>
        )}
      </SettingsSection>

      <SettingsSection title="Linear connection">
        <div className="setgroup">
          <SettingRow
            description="Connect or reconnect, and refresh what Octant sees."
            focused={props.focusedId === "linear-connection"}
            label="Connection"
            labelledBySection
            scope="host"
            settingId="linear-connection"
          >
            <div className="linear-settings__controls">
              {snapshot.state === "unauthorized" ? (
                <OctantButton
                  disabled={props.commandBusy || props.refreshing}
                  onClick={() => props.runCommand("setup")}
                  type="button"
                  variant="secondary"
                >
                  {reconnect ? "Reconnect" : "Connect"}
                </OctantButton>
              ) : null}
              <OctantButton
                disabled={props.commandBusy || props.refreshing}
                onClick={() => void props.refresh()}
                type="button"
                variant="secondary"
              >
                Refresh status
              </OctantButton>
            </div>
          </SettingRow>
        </div>
        <OctantDialogPresence>
          {connected && props.disconnectArmed ? (
            <OctantConfirmDialog
              confirmLabel="Confirm disconnect"
              destructive
              onCancel={() => props.setDisconnectArmed(false)}
              onConfirm={() => {
                props.setDisconnectArmed(false);
                props.runCommand("logout");
              }}
              title="Disconnect Linear?"
            >
              Remove this computer&apos;s Linear connection? You can reconnect later.
            </OctantConfirmDialog>
          ) : null}
        </OctantDialogPresence>
        <div className="settings-feedback-slot" aria-live="polite">
          {props.commandError === undefined ? null : (
            <SettingsState kind="error">{props.commandError}</SettingsState>
          )}
        </div>
      </SettingsSection>

      {connected && bindableProjects.length > 0 ? (
        <SettingsSection
          description="Pick the Linear team (and optional Linear project) each Project scopes its issues and octant_linear reads to."
          title="Linear projects"
        >
          {props.filtersLoading && teams.length === 0 ? (
            <p className="settings-section-line">Loading Linear teams…</p>
          ) : (
            <div className="setgroup" ref={props.projectsGroupRef} tabIndex={-1}>
              {bindableProjects.map((project) => {
                const current = project.linearTarget;
                const busy = props.savingProjectId === String(project.id);
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
                    focused={props.focusedId === `linear-project-${String(project.id)}`}
                    key={String(project.id)}
                    label={project.name}
                    scope="host"
                    settingId={`linear-project-${String(project.id)}`}
                  >
                    <div className="linear-settings__controls">
                      <OctantSelectField
                        aria-label={`${project.name} Linear team`}
                        disabled={busy || props.onProjectLinearTargetChange === undefined}
                        onValueChange={(teamId) => {
                          if (teamId === UNBOUND) {
                            void props.saveMapping(project.id, null);
                            return;
                          }
                          const found = teams.find((team) => team.id === teamId);
                          if (found === undefined) return;
                          const teamKey = found.key ?? extractTeamKey(found.label);
                          const teamName = found.name ?? extractTeamName(found.label);
                          if (teamKey === undefined) return;
                          void props.saveMapping(project.id, {
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
                          disabled={busy || props.onProjectLinearTargetChange === undefined}
                          onValueChange={(linearProjectId) => {
                            if (linearProjectId === ANY_PROJECT) {
                              void props.saveMapping(project.id, {
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
                            void props.saveMapping(project.id, {
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
            {props.mappingError === undefined ? null : (
              <SettingsState kind="error">{props.mappingError}</SettingsState>
            )}
          </div>
        </SettingsSection>
      ) : null}

      <SettingsSection
        description="A personal API key is stored in the same secret store on this computer as OAuth tokens, and is never used as an OAuth fallback."
        title="Linear API key"
      >
        <div className="linear-settings__controls">
          <OctantButton
            aria-expanded={props.advancedOpen}
            onClick={() => props.setAdvancedOpen((open) => !open)}
            type="button"
            variant="ghost"
          >
            Personal API key
          </OctantButton>
        </div>
        {props.advancedOpen ? (
          <div className="linear-settings__advanced">
            <label className="linear-settings__note" htmlFor="linear-personal-api-key">
              Personal API key
            </label>
            <p className="linear-settings__note">
              {personalKeyStored
                ? "A personal API key is stored on this computer. "
                : "Stored on this computer. "}
              <a href={LINEAR_API_KEYS_URL} rel="noreferrer" target="_blank">
                Create one
              </a>
            </p>
            <OctantInput
              autoComplete="off"
              id="linear-personal-api-key"
              onChange={(event) => props.setPersonalKey(event.currentTarget.value)}
              placeholder={
                personalKeyStored ? "Stored secret, enter a new key to replace" : "lin_api_…"
              }
              type="password"
              value={props.personalKey}
            />
            <div className="linear-settings__controls">
              <OctantButton
                disabled={props.personalBusy || props.personalKey.trim().length === 0}
                onClick={() => {
                  props.setPersonalBusy(true);
                  void client
                    .storePersonalCredential(props.personalKey)
                    .then(() => {
                      props.setPersonalKey("");
                      return props.refresh();
                    })
                    .catch((error: unknown) => {
                      props.setCommandError(
                        error instanceof Error
                          ? error.message
                          : "The personal API key could not be stored.",
                      );
                    })
                    .finally(() => props.setPersonalBusy(false));
                }}
                type="button"
                variant="secondary"
              >
                Store key
              </OctantButton>
              <OctantButton
                disabled={
                  props.personalBusy || (snapshot.state === "unauthorized" && !personalKeyStored)
                }
                onClick={() => {
                  props.setPersonalBusy(true);
                  void client
                    .deletePersonalCredential()
                    .then(() => props.refresh())
                    .catch((error: unknown) => {
                      props.setCommandError(
                        error instanceof Error
                          ? error.message
                          : "The personal API key could not be removed.",
                      );
                    })
                    .finally(() => props.setPersonalBusy(false));
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
        <SettingsSection tone="danger" title="Disconnect Linear">
          <div className="setgroup">
            <SettingRow
              description="Removes Octant's Linear sign-in from this computer; your Linear workspace is untouched."
              focused={props.focusedId === "linear-disconnect"}
              label="Disconnect Linear"
              scope="host"
              settingId="linear-disconnect"
            >
              <OctantButton
                aria-expanded={props.disconnectArmed}
                aria-haspopup="dialog"
                disabled={props.commandBusy || props.refreshing}
                onClick={() => props.setDisconnectArmed(true)}
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
