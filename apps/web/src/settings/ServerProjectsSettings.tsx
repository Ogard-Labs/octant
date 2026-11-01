import type { ServerProjectsClient } from "@octant/client-runtime/server-projects-client";
import type { ShieldServersClient } from "@octant/client-runtime/shield-servers-client";
import type { ServerProjectsCommand, ServerProjectsView } from "@octant/contracts/server-projects";
import type { ShieldServer } from "@octant/contracts/shield-servers";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { SettingsPanel, SettingsState } from "./primitives";

export interface ServerProjectsSettingsProps {
  /** Absent off this computer: the catalog is host authority. */
  readonly client: Pick<ServerProjectsClient, "read" | "command"> | undefined;
  readonly servers: Pick<ShieldServersClient, "read"> | undefined;
}

export const SERVER_PROJECTS_INTRO =
  "A Code Project whose files, commands, Git and terminals are on one of your servers. Octant connects with your own SSH agent and never falls back to this computer.";

/**
 * Settings › Access › Servers: the Code Projects bound to a folder on one of
 * the registered servers. The host checks the folder over SSH before it binds
 * anything, and its refusal is shown beside the form as it arrived.
 */
export function ServerProjectsSettings(props: ServerProjectsSettingsProps) {
  const { client, servers: serversClient } = props;
  const fieldId = useId();
  const [view, setView] = useState<ServerProjectsView | undefined>(undefined);
  const [servers, setServers] = useState<ReadonlyArray<ShieldServer>>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [name, setName] = useState("");
  const [serverId, setServerId] = useState("");
  const [folder, setFolder] = useState("");

  const load = useCallback(async () => {
    if (client === undefined) return;
    try {
      const [projects, registry] = await Promise.all([client.read(), serversClient?.read()]);
      setView(projects);
      setServers(registry?.servers ?? []);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [client, serversClient]);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(command: ServerProjectsCommand): Promise<boolean> {
    if (client === undefined) return false;
    setProblem(undefined);
    setBusy(true);
    try {
      const result = await client.command(command);
      if (result.kind === "server-projects-updated") {
        setView(result.view);
        return true;
      }
      setProblem(result.message);
      return false;
    } catch {
      setProblem("The server Project could not be saved.");
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
    }).then((bound) => {
      if (!bound) return;
      setName("");
      setFolder("");
    });
  }

  return (
    <div className="shield-servers" data-setting-id="server-projects">
      <SettingsPanel description={SERVER_PROJECTS_INTRO} title="Code Projects on your servers">
        {view.projects.length === 0 ? (
          <p className="shield-servers__empty">No folders on a server are bound.</p>
        ) : (
          <ul aria-label="Server Projects" className="shield-servers__list">
            {view.projects.map((project) => (
              <li className="shield-servers__server" key={String(project.id)}>
                <span className="shield-servers__name">{project.name}</span>
                <span className="shield-servers__login">
                  {aliasOf(String(project.serverId))}:{project.folder}
                </span>
                <span className="shield-servers__row-actions">
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
              </li>
            ))}
          </ul>
        )}
      </SettingsPanel>
      <SettingsPanel
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
