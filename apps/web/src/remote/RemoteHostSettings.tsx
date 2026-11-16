import type { AgentGrantClient } from "@octant/client-runtime/agent-grant-client";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { PairedDeviceAdministrationClient } from "@octant/client-runtime/paired-device-administration-client";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { ProviderClient } from "@octant/client-runtime/provider-client";
import type { RemoteShellSurfaceKind } from "@octant/client-runtime";
import type { AgentAccessCommand } from "@octant/contracts";
import { useEffect, useMemo, useState } from "react";
import { AgentAccessSettingsSection } from "../agentAccess/AgentAccessSettingsSection";
import { ExtensionsSettingsView } from "../extensions/ExtensionsSettingsView";
import type {
  ProviderOAuthCommand,
  ProviderOAuthCommandResult,
} from "../providers/ProviderOAuthSignIn";
import type { ProviderKeyHost } from "../providers/providerKeyHost";
import { ProviderSettingsView } from "../providers/ProviderSettingsView";
import { providerSettingsViewProps } from "../providers/providerSettingsViewProps";
import { useProviderController } from "../providers/useProviderController";
import { OctantButton } from "../ui/base/OctantButton";
import { RemotePairedDevices } from "./RemotePairedDevices";

type HostSettingsSection = "extensions" | "providers" | "devices" | "agents";

const SECTIONS: ReadonlyArray<{
  readonly id: HostSettingsSection;
  readonly label: string;
  /** The matrix surface whose routes the section sends to. */
  readonly surface: RemoteShellSurfaceKind;
}> = [
  { id: "extensions", label: "Extensions", surface: "extension-install" },
  { id: "providers", label: "Providers", surface: "provider-setup" },
  { id: "devices", label: "Paired devices", surface: "device-management" },
  { id: "agents", label: "Agent access", surface: "agent-access" },
];

export interface RemoteHostSettingsProps {
  /** The surfaces the host forwards for this session, from the shared matrix. */
  readonly reachable: ReadonlySet<RemoteShellSurfaceKind>;
  readonly extensionClient: ExtensionClient;
  readonly providerClient: ProviderClient;
  /** Stores, replaces and clears a provider key in the host's credential store. */
  readonly providerKeys: ProviderKeyHost;
  readonly pairedDevices: PairedDeviceAdministrationClient;
  /** Outside agents' grants, made, changed and revoked over the session. */
  readonly agentGrants: AgentGrantClient;
  /** The host's Projects, which a grant names. */
  readonly projectClient: Pick<ProjectClient, "bootstrap">;
  /** The host's address as this browser reached it. */
  readonly origin: string;
  /** Starts and polls a provider sign-in over the session. */
  readonly providerOAuth: (
    command: ProviderOAuthCommand,
  ) => Promise<ProviderOAuthCommandResult | undefined>;
}

/**
 * The host's Extensions, Providers and Paired devices settings in a browser
 * the host's own person paired, driven by clients that travel over the
 * session (maintainer decision, 2026-11-12). Extensions and Providers are the
 * sections a local window's Settings mounts. A
 * section is offered only where the matrix says the host forwards its routes,
 * and each is closed until asked for so the shell opens without its reads.
 * The Providers section takes a key only where the matrix says the host
 * forwards the credential routes; the key then travels in a request body to
 * the host's credential store and is never read back.
 */
export function RemoteHostSettings(props: RemoteHostSettingsProps) {
  const sections = SECTIONS.filter((section) => props.reachable.has(section.surface));
  const [open, setOpen] = useState<HostSettingsSection>();
  if (sections.length === 0) return null;
  return (
    <section aria-label="Host settings" className="remote-shell__device-panel">
      <h2 className="remote-shell__section-title">Host settings</h2>
      <div className="flex gap-1">
        {sections.map((section) => (
          <OctantButton
            aria-pressed={open === section.id}
            key={section.id}
            onClick={() => setOpen(open === section.id ? undefined : section.id)}
            size="sm"
            type="button"
            variant={open === section.id ? "secondary" : "ghost"}
          >
            {section.label}
          </OctantButton>
        ))}
      </div>
      {open === "extensions" ? <ExtensionsSettingsView client={props.extensionClient} /> : null}
      {open === "devices" ? (
        <RemotePairedDevices client={props.pairedDevices} origin={props.origin} />
      ) : null}
      {open === "agents" ? (
        <RemoteAgentAccess client={props.agentGrants} projectClient={props.projectClient} />
      ) : null}
      {open === "providers" ? (
        <RemoteProviderSettings
          client={props.providerClient}
          keyHost={props.reachable.has("provider-credentials") ? props.providerKeys : undefined}
          providerOAuth={props.providerOAuth}
        />
      ) : null}
    </section>
  );
}

function RemoteProviderSettings(props: {
  readonly client: ProviderClient;
  readonly keyHost: ProviderKeyHost | undefined;
  readonly providerOAuth: RemoteHostSettingsProps["providerOAuth"];
}) {
  const controller = useProviderController({
    client: props.client,
    ...(props.keyHost === undefined ? {} : { hostBridge: props.keyHost }),
  });
  return (
    <ProviderSettingsView
      {...providerSettingsViewProps(controller, props.keyHost)}
      // Scanning the host for installed CLIs is a route the host keeps local.
      discovery={null}
      onProviderOAuth={props.providerOAuth}
    />
  );
}

/**
 * Settings › Agent access as a local window shows it, its commands sent over
 * the session instead of the desktop bridge. The host takes them only from a
 * device its own person paired and journals that device as the actor.
 */
function RemoteAgentAccess(props: {
  readonly client: AgentGrantClient;
  readonly projectClient: Pick<ProjectClient, "bootstrap">;
}) {
  const { client, projectClient } = props;
  const [projectNames, setProjectNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let current = true;
    void projectClient
      .bootstrap()
      .then((bootstrap) => {
        if (current)
          setProjectNames(
            new Map(bootstrap.active.map((project) => [String(project.id), project.name])),
          );
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [projectClient]);
  const administration = useMemo(
    () => ({
      agentAccessRequest: async (
        request:
          | { readonly kind: "list" }
          | { readonly kind: "command"; readonly command: AgentAccessCommand },
      ) => ({
        status: 200,
        body:
          request.kind === "list" ? await client.grants() : await client.command(request.command),
      }),
    }),
    [client],
  );
  return (
    <AgentAccessSettingsSection
      administration={administration}
      client={client}
      projectNames={projectNames}
    />
  );
}
