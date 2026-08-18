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

/**
 * The surfaces one thread can be watched through from a companion client: the
 * conversation itself, and the running product behind it.
 */
export type RemoteThreadSurfaceKind =
  | "chat"
  | "browser"
  | "terminal"
  | "simulator"
  | "canvas"
  | "preview";

/**
 * How far a paired device may go on a surface. `unavailable` is the answer
 * whenever the host would refuse even the read, so a client that trusts this
 * matrix never offers a view it cannot fill.
 */
export type RemoteThreadSurfaceReach = "unavailable" | "read-only" | "interactive";

export interface RemoteThreadSurfaceDescriptor {
  readonly id: RemoteThreadSurfaceKind;
  readonly label: string;
  /** What the surface shows, in the words the companion client puts on screen. */
  readonly description: string;
  /** The catalog action that reading this surface needs. */
  readonly observeAction: string;
  /**
   * The catalog action acting on this surface needs. Absent on a surface a
   * companion client only ever watches.
   */
  readonly interactAction?: string;
}

const REMOTE_THREAD_SURFACES: ReadonlyArray<RemoteThreadSurfaceDescriptor> = [
  {
    id: "chat",
    label: "Conversation",
    description: "The thread's messages, and the composer that adds to them.",
    observeAction: "project.overview.read",
    interactAction: "chat.send-turn",
  },
  {
    id: "browser",
    label: "Browser",
    description: "What the host's browser is showing, with taps landing in the page.",
    observeAction: "browser.observe",
    interactAction: "browser.interact",
  },
  {
    id: "terminal",
    label: "Terminal",
    description: "Output from the thread's terminals, read only.",
    observeAction: "terminal.read",
    interactAction: "terminal.write",
  },
  {
    id: "simulator",
    label: "Simulator",
    description: "The most recent simulator screenshot the host recorded.",
    observeAction: "simulator.observe",
  },
  {
    id: "canvas",
    label: "Canvas",
    description: "The thread's canvases as the host last rendered them.",
    observeAction: "project.overview.read",
  },
  {
    id: "preview",
    label: "Preview",
    description: "An authorized file preview from the thread's own context.",
    observeAction: "preview.open-authorized",
  },
];

export function listRemoteThreadSurfaces(): ReadonlyArray<RemoteThreadSurfaceDescriptor> {
  return REMOTE_THREAD_SURFACES;
}

/**
 * Reach is derived from the catalog rather than declared, so a surface whose
 * action is reclassified — or was never in the catalog at all — loses reach
 * here without anyone remembering to update this table.
 */
export function remoteThreadSurfaceReach(
  descriptor: RemoteThreadSurfaceDescriptor,
): RemoteThreadSurfaceReach {
  if (classifyRemoteAction(descriptor.observeAction).kind !== "remote-approvable") {
    return "unavailable";
  }
  if (descriptor.interactAction === undefined) return "read-only";
  return classifyRemoteAction(descriptor.interactAction).kind === "remote-approvable"
    ? "interactive"
    : "read-only";
}

export function listRemoteThreadSurfacesByReach(
  reach: RemoteThreadSurfaceReach,
): ReadonlyArray<RemoteThreadSurfaceDescriptor> {
  return listRemoteThreadSurfaces().filter(
    (surface) => remoteThreadSurfaceReach(surface) === reach,
  );
}
