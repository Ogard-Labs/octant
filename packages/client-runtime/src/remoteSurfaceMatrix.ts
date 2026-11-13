import { RemoteOwnDeviceMetadataV1, decodeHostAnswer } from "@octant/contracts";
import { authorizePrincipalAction, classifyRemoteAction } from "@octant/domain";

/**
 * What the host says an authenticated session is. A session that acts as the
 * host's own person (a device that person paired) is let through every route
 * the host forwards; every other session is held to the remote action
 * catalogue. Read it from the host's own-device answer and never assume it:
 * the host decides each request from its own record whatever a client holds.
 */
export interface RemoteSessionStanding {
  readonly actsAsHostPerson: boolean;
}

/** A session the host has not said acts as its person, and one whose host does not say. */
export const RESTRICTED_REMOTE_SESSION: RemoteSessionStanding = { actsAsHostPerson: false };

/**
 * Ask the host what this session is. Anything but a plain yes reads as
 * restricted: an older host that does not say, a refusal, an answer that does
 * not decode, and a host that cannot be reached. A client then hides what a
 * person-paired device could have done, which the next read puts back.
 */
export async function readRemoteSessionStanding(transport: {
  readonly authenticatedFetch: (input: {
    readonly method: string;
    readonly path: string;
  }) => Promise<Response>;
}): Promise<RemoteSessionStanding> {
  try {
    const response = await transport.authenticatedFetch({
      method: "GET",
      path: "/api/remote/auth/device",
    });
    if (!response.ok) return RESTRICTED_REMOTE_SESSION;
    const device = decodeHostAnswer(RemoteOwnDeviceMetadataV1)(await response.json());
    return { actsAsHostPerson: device.actsAsHostPerson === true };
  } catch {
    return RESTRICTED_REMOTE_SESSION;
  }
}

export type RemoteShellSurfaceKind =
  | "chat"
  | "work"
  | "code"
  | "preview"
  | "provider-models"
  | "settings-read"
  | "shell-settings"
  | "approvals"
  | "extension-install"
  | "provider-setup"
  | "provider-credentials"
  | "device-management"
  | "listener-controls"
  | "host-controls";

export type RemoteShellSurfaceAvailability = "remote" | "local-host-only";

export interface RemoteShellSurfaceDescriptor {
  readonly id: RemoteShellSurfaceKind;
  readonly label: string;
  readonly description: string;
  readonly availability: RemoteShellSurfaceAvailability;
  readonly catalogAction: string;
  /**
   * Set where the host forwards none of the surface's routes to any device, a
   * person-paired one included: the desktop bridge and the secret stores sit
   * behind the private listener's local-only prefixes. Such a surface stays
   * unavailable to every session.
   */
  readonly keptOnHost?: true;
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
    id: "shell-settings",
    label: "Shell settings",
    description: "Change the host's shell settings, a thread's Reply detail included.",
    availability: "local-host-only",
    // No catalogued action: the host opens the route only to a session that
    // acts as its person, so a restricted session reads it as unavailable.
    catalogAction: "shell.settings.replace",
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
    id: "provider-setup",
    label: "Provider setup",
    description: "Add, change, and remove providers and start a provider sign-in.",
    availability: "local-host-only",
    catalogAction: "provider.oauth.begin",
  },
  {
    id: "provider-credentials",
    label: "Provider credentials",
    description: "Store, replace, and clear a provider key in the host's credential store.",
    availability: "local-host-only",
    catalogAction: "provider.credentials.write",
  },
  {
    id: "device-management",
    label: "Paired devices",
    description: "List, rename, and revoke paired devices, and approve a new device.",
    availability: "local-host-only",
    catalogAction: "desktop.approve-device",
  },
  {
    id: "listener-controls",
    label: "Remote listener",
    description: "Enable, disable, and configure the HTTPS listener locally.",
    availability: "local-host-only",
    catalogAction: "desktop.enable-listener",
    keptOnHost: true,
  },
  {
    id: "host-controls",
    label: "Host controls",
    description:
      "Stop and restart the host, its startup policy, backups, memory limits, and retention.",
    availability: "local-host-only",
    catalogAction: "host.service.stop",
  },
];

export function listRemoteShellSurfaces(): ReadonlyArray<RemoteShellSurfaceDescriptor> {
  return REMOTE_SHELL_SURFACES;
}

/**
 * A restricted session reaches what the catalogue calls remote work. A session
 * that acts as the host's person reaches every surface but the ones whose
 * routes the host forwards to no device: the host hands such a session each
 * forwarded route without asking the catalogue, so the catalogue's class says
 * nothing about it and the route boundary is the whole answer.
 */
export function remoteShellSurfaceAvailability(
  descriptor: RemoteShellSurfaceDescriptor,
  session: RemoteSessionStanding = RESTRICTED_REMOTE_SESSION,
): RemoteShellSurfaceAvailability {
  if (session.actsAsHostPerson) {
    return descriptor.keptOnHost === true ? "local-host-only" : "remote";
  }
  const decision = classifyRemoteAction(descriptor.catalogAction);
  if (decision.kind === "remote-approvable") return "remote";
  return "local-host-only";
}

export function listRemoteShellSurfacesByAvailability(
  availability: RemoteShellSurfaceAvailability,
  session: RemoteSessionStanding = RESTRICTED_REMOTE_SESSION,
): ReadonlyArray<RemoteShellSurfaceDescriptor> {
  return listRemoteShellSurfaces().filter(
    (surface) => remoteShellSurfaceAvailability(surface, session) === availability,
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
  session: RemoteSessionStanding = RESTRICTED_REMOTE_SESSION,
): RemoteThreadSurfaceReach {
  // The host's own rule for the two kinds of session: a person-paired device
  // also passes the actions the catalogue keeps for the host's person.
  const allowed = (action: string) =>
    authorizePrincipalAction({
      principalKind: session.actsAsHostPerson ? "person-paired-device" : "remote-device",
      action,
    }).kind === "allow";
  if (!allowed(descriptor.observeAction)) return "unavailable";
  if (descriptor.interactAction === undefined) return "read-only";
  return allowed(descriptor.interactAction) ? "interactive" : "read-only";
}

export function listRemoteThreadSurfacesByReach(
  reach: RemoteThreadSurfaceReach,
  session: RemoteSessionStanding = RESTRICTED_REMOTE_SESSION,
): ReadonlyArray<RemoteThreadSurfaceDescriptor> {
  return listRemoteThreadSurfaces().filter(
    (surface) => remoteThreadSurfaceReach(surface, session) === reach,
  );
}
