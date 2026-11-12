import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { ProviderClient } from "@octant/client-runtime/provider-client";
import type { RemoteShellSurfaceKind } from "@octant/client-runtime";
import { useState } from "react";
import { ExtensionsSettingsView } from "../extensions/ExtensionsSettingsView";
import type {
  ProviderOAuthCommand,
  ProviderOAuthCommandResult,
} from "../providers/ProviderOAuthSignIn";
import { ProviderSettingsView } from "../providers/ProviderSettingsView";
import { providerSettingsViewProps } from "../providers/providerSettingsViewProps";
import { useProviderController } from "../providers/useProviderController";
import { OctantButton } from "../ui/base/OctantButton";

type HostSettingsSection = "extensions" | "providers";

const SECTIONS: ReadonlyArray<{
  readonly id: HostSettingsSection;
  readonly label: string;
  /** The matrix surface whose routes the section sends to. */
  readonly surface: RemoteShellSurfaceKind;
}> = [
  { id: "extensions", label: "Extensions", surface: "extension-install" },
  { id: "providers", label: "Providers", surface: "provider-setup" },
];

export interface RemoteHostSettingsProps {
  /** The surfaces the host forwards for this session, from the shared matrix. */
  readonly reachable: ReadonlySet<RemoteShellSurfaceKind>;
  readonly extensionClient: ExtensionClient;
  readonly providerClient: ProviderClient;
  /** Starts and polls a provider sign-in over the session. */
  readonly providerOAuth: (
    command: ProviderOAuthCommand,
  ) => Promise<ProviderOAuthCommandResult | undefined>;
}

/**
 * The host's Extensions and Providers settings in a browser the host's own
 * person paired: the same sections a local window's Settings mounts, driven by
 * clients that travel over the session (maintainer decision, 2026-11-12). A
 * section is offered only where the matrix says the host forwards its routes,
 * and each is closed until asked for so the shell opens without its reads.
 * There is no host bridge here, so the Providers section takes no key: a key
 * reaches the credential broker only from a window on the host.
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
      {open === "providers" ? (
        <RemoteProviderSettings client={props.providerClient} providerOAuth={props.providerOAuth} />
      ) : null}
    </section>
  );
}

function RemoteProviderSettings(props: {
  readonly client: ProviderClient;
  readonly providerOAuth: RemoteHostSettingsProps["providerOAuth"];
}) {
  const controller = useProviderController({ client: props.client });
  return (
    <ProviderSettingsView
      {...providerSettingsViewProps(controller, undefined)}
      // Scanning the host for installed CLIs is a route the host keeps local.
      discovery={null}
      onProviderOAuth={props.providerOAuth}
    />
  );
}
