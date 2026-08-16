import { classifyRemoteAction } from "@octant/domain";

export type RemoteShellSurfaceKind =
  | "chat"
  | "work"
  | "code"
  | "preview"
  | "provider-models"
  | "settings-read"
  | "approvals"
  | "extension-install"
  | "provider-credentials"
  | "listener-controls"
  | "host-controls";

export type RemoteShellSurfaceAvailability = "remote" | "local-host-only";

export interface RemoteShellSurfaceDescriptor {
  readonly id: RemoteShellSurfaceKind;
  readonly label: string;
  readonly description: string;
  readonly availability: RemoteShellSurfaceAvailability;
  readonly catalogAction: string;
}

const REMOTE_SHELL_SURFACES: ReadonlyArray<RemoteShellSurfaceDescriptor> = [
  {
    id: "chat",
    label: "Chat",
    description: "Send turns and read project overview over the remote session.",
    availability: "remote",
    catalogAction: "chat.send-turn",
  },
  {
    id: "work",
    label: "Work",
    description: "Use Work threads and authorized document surfaces remotely.",
    availability: "remote",
    catalogAction: "work.update-document",
  },
  {
    id: "code",
    label: "Code",
    description: "Plan turns and read Code bootstrap remotely.",
    availability: "remote",
    catalogAction: "code.plan-turn",
  },
  {
    id: "preview",
    label: "Previews",
    description: "Open authorized previews from their Project or thread context.",
    availability: "remote",
    catalogAction: "preview.open-authorized",
  },
  {
    id: "provider-models",
    label: "Provider models",
    description: "List configured provider models without reading credentials.",
    availability: "remote",
    catalogAction: "provider.list-models",
  },
  {
    id: "settings-read",
    label: "Settings",
    description: "Read non-secret settings and tool configuration.",
    availability: "remote",
    catalogAction: "settings.read-non-secret",
  },
  {
    id: "approvals",
    label: "Approvals",
    description: "High-risk approvals require the local packaged host.",
    availability: "local-host-only",
    catalogAction: "desktop.issue-local-approval",
  },
  {
    id: "extension-install",
    label: "Extensions",
    description: "Install and trust extensions on the local host only.",
    availability: "local-host-only",
    catalogAction: "extension.install",
  },
  {
    id: "provider-credentials",
    label: "Provider credentials",
    description: "Keychain-backed provider credentials stay on the local host.",
    availability: "local-host-only",
    catalogAction: "provider.credentials.write",
  },
  {
    id: "listener-controls",
    label: "Remote listener",
    description: "Enable, disable, and configure the HTTPS listener locally.",
    availability: "local-host-only",
    catalogAction: "desktop.enable-listener",
  },
  {
    id: "host-controls",
    label: "Host controls",
    description: "Start, stop, restart, and startup policy stay on the local host.",
    availability: "local-host-only",
    catalogAction: "host.service.stop",
  },
];

export function listRemoteShellSurfaces(): ReadonlyArray<RemoteShellSurfaceDescriptor> {
  return REMOTE_SHELL_SURFACES;
}

export function remoteShellSurfaceAvailability(
  descriptor: RemoteShellSurfaceDescriptor,
): RemoteShellSurfaceAvailability {
  const decision = classifyRemoteAction(descriptor.catalogAction);
  if (decision.kind === "remote-approvable") return "remote";
  return "local-host-only";
}

export function listRemoteShellSurfacesByAvailability(
  availability: RemoteShellSurfaceAvailability,
): ReadonlyArray<RemoteShellSurfaceDescriptor> {
  return listRemoteShellSurfaces().filter(
    (surface) => remoteShellSurfaceAvailability(surface) === availability,
  );
}
