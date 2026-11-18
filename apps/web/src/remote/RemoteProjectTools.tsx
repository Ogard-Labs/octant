import type { ProjectBrowserClient } from "@octant/client-runtime/project-browser-client";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { ProjectTerminalClient } from "@octant/client-runtime/project-terminal-client";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import type { ProjectId } from "@octant/contracts/projects";
import { useMemo, useState } from "react";
import { useProjectController } from "../projects/useProjectController";
import { StartQuickTools, StartQuickToolsContext } from "../shell/StartQuickTools";
import { OctantSelectField } from "../ui/base/OctantSelect";

export interface RemoteProjectToolsProps {
  readonly mode: "work" | "code";
  readonly projectClient: ProjectClient;
  readonly projectTerminalClient: ProjectTerminalClient;
  readonly projectBrowserClient: ProjectBrowserClient;
}

/**
 * A Project's own terminal and browser, on a browser the host's own person
 * paired: the device's own shell in the Project's folder and its own Private
 * page, through the same quick tools a window's start screen offers. The host
 * decides everything that matters (the Project is local and active, a Work
 * Project's Developer tools are on, the shell and page belong to this device
 * alone and end when it is revoked or goes quiet, a profile page stays at a
 * window); the shell mounts this for no other session.
 */
export function RemoteProjectTools(props: RemoteProjectToolsProps) {
  const projects = useProjectController({ activeMode: props.mode, client: props.projectClient });
  const choices = projects.projects.filter(
    (project) => project.type === props.mode && project.lifecycle === "active",
  );
  const [chosen, setChosen] = useState<ProjectId>();
  const projectId = choices.find((project) => project.id === chosen)?.id ?? choices[0]?.id;
  const services = useMemo(
    () => ({
      hostId: LOCAL_HOST_ID,
      projectTerminalClient: props.projectTerminalClient,
      projectBrowserClient: props.projectBrowserClient,
    }),
    [props.projectTerminalClient, props.projectBrowserClient],
  );
  if (choices.length === 0) return null;

  return (
    <section aria-label="Project tools" className="remote-shell__device-panel">
      <h2 className="remote-shell__section-title">Project tools</h2>
      <span className="text-xs text-muted-foreground">
        Your own terminal and Private browser page in a Project on this host
      </span>
      <OctantSelectField
        aria-label="Project"
        onValueChange={(next) => {
          const match = choices.find((project) => String(project.id) === next);
          if (match !== undefined) setChosen(match.id);
        }}
        options={choices.map((project) => ({ id: String(project.id), label: project.name }))}
        value={projectId === undefined ? "" : String(projectId)}
      />
      {projectId === undefined ? null : (
        <StartQuickToolsContext.Provider value={services}>
          <StartQuickTools
            key={String(projectId)}
            note="They end when you close them, or when this browser is revoked or goes quiet."
            projectId={projectId}
          />
        </StartQuickToolsContext.Provider>
      )}
    </section>
  );
}
