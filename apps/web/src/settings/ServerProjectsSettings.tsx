import { ServerProjectPreviewTunnel } from "./ServerProjectPreviewTunnel";
import { ServerWorkProjectTerminal } from "./ServerWorkProjectTerminal";
import type { ServerProjectsClient } from "@octant/client-runtime/server-projects-client";
import type { ProjectTerminalClient } from "@octant/client-runtime/project-terminal-client";
import { AggregateVersion, type ProjectId } from "@octant/contracts";
import { Schema } from "effect";
import { ProjectActionsSection } from "../projects/ProjectActionsSection";
import {
  ProjectActionRunDialog,
  type ProjectActionTarget,
} from "../projects/ProjectActionRunDialog";
import type { ShieldServersClient } from "@octant/client-runtime/shield-servers-client";
import type {
  ServerProject,
  ServerProjectsCommand,
  ServerProjectsView,
} from "@octant/contracts/server-projects";
import type { ShieldServer } from "@octant/contracts/shield-servers";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { SettingsPanel, SettingsState, revealSettingsWithin } from "./primitives";
import { ShieldServersSettings } from "./ShieldServersSettings";

export interface ServerProjectsSettingsProps {
  /** Absent off this computer: the catalog is host authority. */
  readonly client:
    | Pick<ServerProjectsClient, "read" | "command" | "previewRead" | "previewCommand">
    | undefined;
  readonly servers: Pick<ShieldServersClient, "read"> | undefined;
  /** Bumped when the registry above changes, so the server choices are read again. */
  readonly registryRevision?: number;
  readonly focusedSetting?: string | undefined;
  readonly terminalClient?: ProjectTerminalClient;
  readonly actionStoragePrefix?: string;
  readonly codeProjectId?: ProjectId | undefined;
  readonly workProjectId?: ProjectId | undefined;
  readonly onOpenServerProject?: (project: ServerProject) => void;
}

export const SERVER_PROJECTS_INTRO =
  "A Code or Work Project whose files and commands are on one of your servers. Octant connects with your own SSH agent and never falls back to this computer.";

/**
 * Settings › Permissions › Servers: the Code and Work Projects bound to a folder on one of
 * the registered servers. The host checks the folder over SSH before it binds
 * anything, and its refusal is shown beside the form as it arrived.
 */
export function ServerProjectsSettings(props: ServerProjectsSettingsProps) {
  const { client, servers: serversClient } = props;
  const fieldId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ServerProjectsView | undefined>(undefined);
  const [servers, setServers] = useState<ReadonlyArray<ShieldServer>>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [actionProblem, setActionProblem] = useState<string | undefined>(undefined);
  const [actionsChanged, setActionsChanged] = useState(false);
  const [name, setName] = useState("");
  const [serverId, setServerId] = useState("");
  const [folder, setFolder] = useState("");
  const [mode, setMode] = useState<"code" | "work">("code");
  const [editingActions, setEditingActions] = useState<string>();
  const [actionTarget, setActionTarget] = useState<ProjectActionTarget>();

  const registryRevision = props.registryRevision ?? 0;
  const load = useCallback(async () => {
    if (client === undefined) return;
    try {
      const [projects, registry] = await Promise.all([client.read(), serversClient?.read()]);
      setView(projects);
      setEditingActions((current) =>
        projects.projects.some((project) => String(project.id) === current) ? current : undefined,
      );
      setServers(registry?.servers ?? []);
      setLoadFailed(false);
      setProblem(undefined);
      setActionProblem(undefined);
      setActionsChanged(false);
    } catch {
      setLoadFailed(true);
      setProblem("Server Projects could not be read from this host.");
    }
  }, [client, serversClient]);

  // A changed registry above is read again, so a server added there can be chosen here.
  useEffect(() => {
    void load();
  }, [load, registryRevision]);

  const loaded = view !== undefined;
  useEffect(() => {
    if (!loaded || props.focusedSetting !== "server-projects") return;
    const panel = root.current;
    if (panel === null) return;
    const land = () => {
      const target = panel.querySelector<HTMLInputElement>("form input");
      (target ?? panel).focus();
      panel.scrollIntoView?.({ block: "center" });
    };
    // The bind form sits in a collapsed section; it opens on the next frame.
    if (!revealSettingsWithin(panel)) {
      land();
      return;
    }
    const frame = requestAnimationFrame(land);
    return () => cancelAnimationFrame(frame);
  }, [loaded, props.focusedSetting]);

  async function send(command: ServerProjectsCommand): Promise<boolean> {
    if (client === undefined) return false;
    const actionSave = command.kind === "set-server-project-actions";
    const reportProblem = actionSave ? setActionProblem : setProblem;
    reportProblem(undefined);
    if (actionSave) setActionsChanged(false);
    setBusy(true);
    try {
      const result = await client.command(command);
      if (result.kind === "server-projects-updated") {
        setView(result.view);
        setEditingActions((current) =>
          result.view.projects.some((project) => String(project.id) === current)
            ? current
            : undefined,
        );
        return true;
      }
      reportProblem(result.message);
      if (actionSave) setActionsChanged(result.reason === "actions-changed");
      return false;
    } catch {
      reportProblem("The server Project could not be saved.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (client === undefined) return null;
  if (view === undefined) {
    return (
      <SettingsState kind={loadFailed ? "error" : "loading"}>
        {loadFailed
          ? "Server Projects could not be read from this host."
          : "Reading server Projects…"}
      </SettingsState>
    );
  }

  const chosenServer = servers.find((server) => String(server.serverId) === serverId) ?? servers[0];
  const aliasOf = (id: string) =>
    servers.find((server) => String(server.serverId) === id)?.alias ?? "a removed server";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (chosenServer === undefined) return;
    void send({
      kind: "bind-server-project",
      name: name.trim(),
      serverId: chosenServer.serverId,
      folder: folder.trim(),
      ...(mode === "work" ? { mode: "work" as const } : {}),
    }).then((bound) => {
      if (!bound) return;
      setName("");
      setFolder("");
    });
  }

  return (
    <div className="shield-servers" data-setting-id="server-projects" ref={root} tabIndex={-1}>
      <SettingsPanel
        collapse={{
          open: view.projects.length > 0,
          summary:
            view.projects.length === 0
              ? "No folders on a server are bound"
              : view.projects.length === 1
                ? "1 folder bound"
                : `${view.projects.length} folders bound`,
        }}
        description={SERVER_PROJECTS_INTRO}
        title="Projects on your servers"
      >
        {view.projects.length === 0 ? (
          <p className="shield-servers__empty">No folders on a server are bound.</p>
        ) : (
          <ul aria-label="Server Projects" className="shield-servers__list">
            {view.projects.map((project) => (
              <li className="shield-servers__server" key={String(project.id)}>
                <span className="shield-servers__name">{project.name}</span>
                <span className="shield-servers__login">
                  {project.mode === "work" ? "Work · " : "Code · "}
                  {aliasOf(String(project.serverId))}:{project.folder}
                </span>
                <span className="shield-servers__row-actions">
                  {project.mode === "work" && project.developerTools?.enabled !== true ? null : (
                    <OctantButton
                      aria-expanded={editingActions === String(project.id)}
                      onClick={() =>
                        setEditingActions((current) =>
                          current === String(project.id) ? undefined : String(project.id),
                        )
                      }
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Actions
                    </OctantButton>
                  )}
                  <OctantButton
                    aria-label={`Remove ${project.name}`}
                    disabled={busy}
                    onClick={() =>
                      void send({ kind: "remove-server-project", projectId: project.id })
                    }
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Remove
                  </OctantButton>
                </span>
                {project.mode === "work" ? (
                  <div className="basis-full min-w-0">
                    <div className="project-overview-inspector__row">
                      <div>
                        <h3>Developer tools</h3>
                        <p id={`${fieldId}-${project.id}-actions`}>
                          Show saved actions and your Project terminal. Tasks keep their existing
                          access.
                        </p>
                      </div>
                      <OctantSwitch
                        label={`Show developer tools for ${project.name}`}
                        describedBy={`${fieldId}-${project.id}-actions`}
                        checked={project.developerTools?.enabled === true}
                        disabled={busy}
                        onCheckedChange={(enabled) =>
                          void send({
                            kind: "set-server-work-developer-tools",
                            projectId: project.id,
                            enabled,
                          })
                        }
                      />
                    </div>
                  </div>
                ) : null}
                {project.mode === "work" &&
                project.developerTools?.enabled === true &&
                String(props.workProjectId) === String(project.id) &&
                props.terminalClient !== undefined ? (
                  <ServerWorkProjectTerminal
                    key={String(project.id)}
                    client={props.terminalClient}
                    projectId={project.id}
                    login={`${servers.find((server) => String(server.serverId) === String(project.serverId))?.user ?? "unavailable"}@${aliasOf(String(project.serverId))}`}
                    folder={project.folder}
                  />
                ) : null}
                {(project.mode === "work" && project.developerTools?.enabled !== true) ||
                props.terminalClient === undefined ? null : (
                  <span className="shield-servers__row-actions min-w-0 max-w-full flex-wrap">
                    {String(project.mode === "work" ? props.workProjectId : props.codeProjectId) !==
                    String(project.id) ? (
                      <>
                        <span>Open this Project to run actions and read suggestions.</span>
                        {props.onOpenServerProject === undefined ? null : (
                          <OctantButton
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() => props.onOpenServerProject?.(project)}
                          >
                            Open {project.name}
                          </OctantButton>
                        )}
                      </>
                    ) : (
                      (project.actions ?? []).map((action) => (
                        <OctantButton
                          key={String(action.id)}
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() =>
                            setActionTarget({ projectId: project.id, actionId: action.id })
                          }
                        >
                          Run {action.name}
                        </OctantButton>
                      ))
                    )}
                  </span>
                )}
                {(project.mode === "work" && project.developerTools?.enabled !== true) ||
                editingActions !== String(project.id) ? null : (
                  <div className="basis-full min-w-0">
                    <ProjectActionsSection
                      key={`${project.id}:${project.actionsVersion ?? 0}`}
                      project={project}
                      {...(props.terminalClient === undefined ||
                      String(
                        project.mode === "work" ? props.workProjectId : props.codeProjectId,
                      ) !== String(project.id)
                        ? {}
                        : { client: props.terminalClient })}
                      disabled={busy}
                      onChange={(actions) =>
                        send({
                          kind: "set-server-project-actions",
                          projectId: project.id,
                          expectedVersion: Schema.decodeUnknownSync(AggregateVersion)(
                            project.actionsVersion ?? 0,
                          ),
                          actions,
                        })
                      }
                    />
                    {actionProblem === undefined ? null : (
                      <OctantAlert tone="danger">{actionProblem}</OctantAlert>
                    )}
                    {actionsChanged ? (
                      <>
                        <p className="project-provider-policy__hint">
                          Reloading replaces this action draft with the current saved list.
                        </p>
                        <OctantButton
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() => void load()}
                        >
                          Reload current actions
                        </OctantButton>
                      </>
                    ) : null}
                  </div>
                )}
                <ServerProjectPreviewTunnel client={client} project={project} />
              </li>
            ))}
          </ul>
        )}
      </SettingsPanel>
      {actionTarget === undefined || props.terminalClient === undefined ? null : (
        <ProjectActionRunDialog
          key={`${actionTarget.projectId}:${actionTarget.actionId}`}
          client={props.terminalClient}
          target={actionTarget}
          open={true}
          storageKey={`${props.actionStoragePrefix ?? "octant.server-action-run"}:${actionTarget.projectId}:${actionTarget.actionId}`}
          onClose={() => setActionTarget(undefined)}
        />
      )}
      <SettingsPanel
        collapse={{ summary: "Bind a folder on a registered server" }}
        description="Octant checks the folder on the server before it binds it."
        title="Bind a folder on a server"
      >
        {chosenServer === undefined ? (
          <p className="shield-servers__empty">Register a server above first.</p>
        ) : (
          <form
            aria-label="Bind a folder on a server"
            className="shield-servers__form"
            noValidate
            onSubmit={submit}
          >
            <div className="host-settings__field">
              <label htmlFor={`${fieldId}-name`}>Project name</label>
              <OctantInput
                autoComplete="off"
                id={`${fieldId}-name`}
                onChange={(event) => setName(event.currentTarget.value)}
                placeholder="Website"
                type="text"
                value={name}
              />
            </div>
            <div className="host-settings__field">
              <label htmlFor={`${fieldId}-mode`}>Project kind</label>
              <OctantSelectField
                aria-label="Project kind"
                id={`${fieldId}-mode`}
                onValueChange={(next) => setMode(next === "work" ? "work" : "code")}
                options={[
                  { id: "code", label: "Code" },
                  { id: "work", label: "Work" },
                ]}
                value={mode}
              />
            </div>
            <div className="host-settings__field">
              <label htmlFor={`${fieldId}-server`}>Server</label>
              <OctantSelectField
                aria-label="Server"
                id={`${fieldId}-server`}
                onValueChange={(next) => setServerId(next)}
                options={servers.map((server) => ({
                  id: String(server.serverId),
                  label: `${server.user}@${server.alias}`,
                }))}
                value={String(chosenServer.serverId)}
              />
            </div>
            <div className="host-settings__field">
              <label htmlFor={`${fieldId}-folder`}>Folder on the server</label>
              <OctantInput
                autoCapitalize="off"
                autoComplete="off"
                id={`${fieldId}-folder`}
                onChange={(event) => setFolder(event.currentTarget.value)}
                placeholder="/srv/website"
                spellCheck={false}
                type="text"
                value={folder}
              />
            </div>
            <div aria-live="polite">
              {problem === undefined ? null : (
                <OctantAlert className="shield-servers__problem" tone="danger">
                  {problem}
                </OctantAlert>
              )}
            </div>
            <div className="shield-servers__actions">
              <OctantButton
                disabled={busy || name.trim() === "" || !folder.trim().startsWith("/")}
                size="sm"
                type="submit"
                variant="secondary"
              >
                {busy ? "Checking the folder…" : "Bind folder"}
              </OctantButton>
            </div>
          </form>
        )}
      </SettingsPanel>
    </div>
  );
}

/**
 * Settings › Permissions › Servers: the registry and the server Projects below it,
 * which read the registry again whenever it changes above.
 */
export function ServerAccessSettings(props: {
  readonly terminalClient?: ProjectTerminalClient;
  readonly actionStoragePrefix?: string;
  readonly codeProjectId?: ProjectId | undefined;
  readonly workProjectId?: ProjectId | undefined;
  readonly onOpenServerProject?: (project: ServerProject) => void;
  readonly servers: ShieldServersClient | undefined;
  readonly projects:
    | Pick<ServerProjectsClient, "read" | "command" | "previewRead" | "previewCommand">
    | undefined;
  readonly focusedSetting?: string | undefined;
  /** Project names by id, for the registry's Project picker. */
  readonly projectNames: ReadonlyMap<string, string>;
}) {
  const { servers } = props;
  const [registryRevision, setRegistryRevision] = useState(0);
  const watched = useMemo<ShieldServersClient | undefined>(
    () =>
      servers === undefined
        ? undefined
        : {
            read: (projectId, signal) => servers.read(projectId, signal),
            command: async (command, signal) => {
              const result = await servers.command(command, signal);
              if (result.kind === "shield-servers-updated") setRegistryRevision((n) => n + 1);
              return result;
            },
          },
    [servers],
  );
  return (
    <>
      <ShieldServersSettings
        client={watched}
        focusedSetting={props.focusedSetting}
        projectNames={props.projectNames}
      />
      <ServerProjectsSettings
        codeProjectId={props.codeProjectId}
        workProjectId={props.workProjectId}
        {...(props.onOpenServerProject === undefined
          ? {}
          : { onOpenServerProject: props.onOpenServerProject })}
        {...(props.terminalClient === undefined ? {} : { terminalClient: props.terminalClient })}
        {...(props.actionStoragePrefix === undefined
          ? {}
          : { actionStoragePrefix: props.actionStoragePrefix })}
        client={props.projects}
        focusedSetting={props.focusedSetting}
        registryRevision={registryRevision}
        servers={servers}
      />
    </>
  );
}
