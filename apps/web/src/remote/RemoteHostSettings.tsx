import type { DiagnosticsExportClient } from "@octant/client-runtime/diagnostics-export-client";
import type { AgentGrantClient } from "@octant/client-runtime/agent-grant-client";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { PairedDeviceAdministrationClient } from "@octant/client-runtime/paired-device-administration-client";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { ProviderClient } from "@octant/client-runtime/provider-client";
import type { ProviderCloudSessionClient } from "@octant/client-runtime/provider-cloud-session-client";
import type { RemoteShellSurfaceKind } from "@octant/client-runtime";
import type { AgentAccessCommand } from "@octant/contracts";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
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
import type { RemoteProductPort } from "./remoteProductClients";

const RemoteDiagnostics = lazy(() => import("./RemoteDiagnostics"));

// Loaded when the Claude and Codex tab is opened, from the desktop Settings view it is made of.
const LazyProviderTooling = lazy(async () => ({
  default: (await import("../shell/SettingsView")).RemoteProviderTooling,
}));

// Loaded when the section is opened, from the desktop Settings view it is made of.
const LazyRemoteHostPermissions = lazy(async () => ({
  default: (await import("../shell/SettingsView")).RemoteHostPermissions,
}));

type HostSettingsSection =
  | "extensions"
  | "providers"
  | "devices"
  | "agents"
  | "permissions"
  | "diagnostics";

const SECTIONS: ReadonlyArray<{
  readonly id: HostSettingsSection;
  readonly label: string;
  /**
   * The matrix surface whose routes the section sends to. Absent where the
   * section stands on what the shell hands it.
   */
  readonly surface?: RemoteShellSurfaceKind;
}> = [
  { id: "extensions", label: "Extensions", surface: "extension-install" },
  { id: "providers", label: "Providers", surface: "provider-setup" },
  { id: "devices", label: "Paired devices", surface: "device-management" },
  { id: "agents", label: "Agent access", surface: "agent-access" },
  { id: "permissions", label: "Permissions" },
  { id: "diagnostics", label: "Diagnostics", surface: "diagnostics" },
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
  /** The diagnostics bundle, failure report and journal growth over the session. */
  readonly diagnosticsClient: DiagnosticsExportClient;
  /** The host's Projects, which a grant names. */
  readonly projectClient: Pick<ProjectClient, "bootstrap">;
  /** The host's address as this browser reached it. */
  readonly origin: string;
  /** Starts and polls a provider sign-in over the session. */
  readonly providerOAuth: (
    command: ProviderOAuthCommand,
  ) => Promise<ProviderOAuthCommandResult | undefined>;
  /**
   * The session, given only for a browser the host's own person paired: it
   * offers the Claude and Codex tab and the Permissions section, which build
   * their own clients over it when opened. Absent, neither is offered and the
   * host refuses the routes anyway.
   */
  readonly personPort?: RemoteProductPort;
  /** Opts supported endpoints in or out of provider cloud jobs over the session. */
  readonly providerCloudSessionClient?: ProviderCloudSessionClient;
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
  const sections = SECTIONS.filter((section) =>
    section.id === "permissions"
      ? props.personPort !== undefined
      : section.surface !== undefined && props.reachable.has(section.surface),
  );
  const [open, setOpen] = useState<HostSettingsSection>();
  if (sections.length === 0) return null;
  return (
    <section aria-label="Host settings" className="remote-shell__device-panel min-w-0">
      <h2 className="remote-shell__section-title">Host settings</h2>
      <div className="flex flex-wrap gap-1">
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
      {open === "extensions" ? (
        <RemoteExtensions
          client={props.extensionClient}
          providerClient={props.providerClient}
          personPort={props.personPort}
          onOpenProviders={() => setOpen("providers")}
        />
      ) : null}
      {open === "devices" ? (
        <RemotePairedDevices client={props.pairedDevices} origin={props.origin} />
      ) : null}
      {open === "agents" ? (
        <RemoteAgentAccess client={props.agentGrants} projectClient={props.projectClient} />
      ) : null}
      {open === "diagnostics" && props.reachable.has("diagnostics") ? (
        <Suspense fallback={null}>
          <RemoteDiagnostics client={props.diagnosticsClient} />
        </Suspense>
      ) : null}
      {open === "permissions" && props.personPort !== undefined ? (
        <Suspense fallback={null}>
          <LazyRemoteHostPermissions port={props.personPort} projectClient={props.projectClient} />
        </Suspense>
      ) : null}
      {open === "providers" ? (
        <RemoteProviderSettings
          client={props.providerClient}
          keyHost={props.reachable.has("provider-credentials") ? props.providerKeys : undefined}
          providerOAuth={props.providerOAuth}
          {...(props.providerCloudSessionClient === undefined
            ? {}
            : { providerCloudSessionClient: props.providerCloudSessionClient })}
        />
      ) : null}
    </section>
  );
}

/**
 * Skills & Extensions, with the Claude and Codex tab where the host's own
 * person paired this browser: the host's accounts come from its provider list,
 * and the commands run on the host through the session.
 */
function RemoteExtensions(props: {
  readonly client: ExtensionClient;
  readonly providerClient: ProviderClient;
  readonly personPort: RemoteProductPort | undefined;
  readonly onOpenProviders: () => void;
}) {
  const { personPort } = props;
  if (personPort === undefined) return <ExtensionsSettingsView client={props.client} />;
  return (
    <RemoteExtensionsWithAccountTools
      client={props.client}
      onOpenProviders={props.onOpenProviders}
      providerClient={props.providerClient}
      port={personPort}
    />
  );
}

function RemoteExtensionsWithAccountTools(props: {
  readonly client: ExtensionClient;
  readonly providerClient: ProviderClient;
  readonly port: RemoteProductPort;
  readonly onOpenProviders: () => void;
}) {
  const controller = useProviderController({ client: props.providerClient });
  const accounts = controller.instances.flatMap((instance) =>
    instance.driverKind === "claude" || instance.driverKind === "codex"
      ? [
          {
            id: String(instance.id),
            displayName: instance.displayName,
            driverKind: instance.driverKind,
            nativeSetup: instance.nativeSetup !== false,
          },
        ]
      : [],
  );
  return (
    <ExtensionsSettingsView
      accountTools={
        <Suspense fallback={null}>
          <LazyProviderTooling
            accounts={accounts}
            port={props.port}
            onOpenRunAsItself={props.onOpenProviders}
          />
        </Suspense>
      }
      client={props.client}
    />
  );
}

function RemoteProviderSettings(props: {
  readonly client: ProviderClient;
  readonly keyHost: ProviderKeyHost | undefined;
  readonly providerOAuth: RemoteHostSettingsProps["providerOAuth"];
  readonly providerCloudSessionClient?: ProviderCloudSessionClient;
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
      {...(props.providerCloudSessionClient === undefined
        ? {}
        : { providerCloudSessionClient: props.providerCloudSessionClient })}
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
