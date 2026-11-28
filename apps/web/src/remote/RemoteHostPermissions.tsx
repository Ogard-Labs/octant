import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { RemoteProductPort } from "./remoteProductClients";
import { useEffect, useMemo, useState } from "react";
import { ArchivedWorktreesSettings } from "../settings/ArchivedWorktreesSettings";
import { HostWorktreesSettings } from "../settings/HostWorktreesSettings";
import { ProtectedFilesSettings } from "../settings/ProtectedFilesSettings";
import { SafeNetworksSettings } from "../settings/SafeNetworksSettings";
import { ShieldServersSettings } from "../settings/ShieldServersSettings";
import { XcodeBuildDataSettings } from "../settings/XcodeBuildDataSettings";
import { SettingsSection } from "../settings/primitives";
import { ProjectSpendCeilingSection } from "../usage/ProjectSpendCeilingSection";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { createRemotePermissionClients } from "./remotePersonClients";

export interface RemoteHostPermissionsProps {
  readonly port: RemoteProductPort;
  /** The host's Projects, which these lists and ceilings name. */
  readonly projectClient: Pick<ProjectClient, "bootstrap">;
}

/**
 * Settings › Permissions and the cleanup and spend-ceiling pages as a local
 * window shows them, on a browser the host's own person paired. The same
 * components run over clients that travel over the session; the host takes
 * each change only from that person and journals this device as the actor.
 * The sandbox restrictions, blocked tools and remembered browser sites are
 * not offered here.
 */
export function RemoteHostPermissions(props: RemoteHostPermissionsProps) {
  const { port, projectClient } = props;
  const clients = useMemo(() => createRemotePermissionClients(port), [port]);
  const [projects, setProjects] = useState<ReadonlyArray<{ id: string; name: string }>>([]);
  useEffect(() => {
    let current = true;
    void projectClient
      .bootstrap()
      .then((bootstrap) => {
        if (current)
          setProjects(
            bootstrap.active.map((project) => ({ id: String(project.id), name: project.name })),
          );
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [projectClient]);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const [ceilingProject, setCeilingProject] = useState<string>();
  const ceilingProjectId =
    projects.find((project) => project.id === ceilingProject)?.id ?? projects[0]?.id;

  return (
    <div className="flex min-w-0 flex-col gap-3" id="settings-permissions">
      <p className="text-xs text-muted-foreground">
        These belong to the paired computer. “This computer” below means that computer, not the
        device you are using.
      </p>
      <ProtectedFilesSettings client={clients.protectedFiles} />
      <SafeNetworksSettings client={clients.safeNetworks} projectNames={projectNames} />
      <ShieldServersSettings client={clients.shieldServers} projectNames={projectNames} />
      <ArchivedWorktreesSettings client={clients.archivedWorktrees} projectNames={projectNames} />
      <HostWorktreesSettings client={clients.diskCleanup} />
      <XcodeBuildDataSettings client={clients.diskCleanup} />
      {ceilingProjectId === undefined ? null : (
        <SettingsSection
          description="The most a Project's agents may spend. A ceiling that is set stops further turns."
          title="Spend ceiling"
        >
          <OctantSelectField
            aria-label="Project"
            onValueChange={setCeilingProject}
            options={projects.map((project) => ({ id: project.id, label: project.name }))}
            value={ceilingProjectId}
          />
          <ProjectSpendCeilingSection
            client={clients.spendCeiling}
            inSettings
            key={ceilingProjectId}
            projectId={ceilingProjectId}
          />
        </SettingsSection>
      )}
    </div>
  );
}
