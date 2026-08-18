import {
  listRemoteThreadSurfaces,
  remoteThreadSurfaceReach,
  type MobileInboxMode,
  type RemoteThreadSurfaceKind,
  type RemoteThreadSurfaceReach,
} from "@octant/client-runtime";

/**
 * The surfaces this device can actually fill. A surface the host would allow but
 * the phone has no view for is not offered: an empty tab reads as a broken
 * feature, not as an honest boundary.
 */
const RENDERABLE_SURFACES: ReadonlyArray<RemoteThreadSurfaceKind> = ["chat", "browser"];

export interface MobileThreadSurfaceOption {
  readonly id: RemoteThreadSurfaceKind;
  readonly label: string;
  readonly reach: RemoteThreadSurfaceReach;
}

/**
 * Which surfaces a thread offers on the phone, in the order they are shown.
 *
 * Reach comes from the shared remote surface matrix, which derives it from the
 * host's own least-authority catalog. A surface the catalog would refuse is
 * dropped here rather than shown and then denied, and a surface the catalog
 * allows only reading is still offered — watching is the point.
 */
export function listMobileThreadSurfaces(input: {
  readonly mode: MobileInboxMode;
}): ReadonlyArray<MobileThreadSurfaceOption> {
  return listRemoteThreadSurfaces()
    .filter((surface) => RENDERABLE_SURFACES.includes(surface.id))
    .map((surface) => ({
      id: surface.id,
      label: surface.id === "chat" ? conversationLabel(input.mode) : surface.label,
      reach: remoteThreadSurfaceReach(surface),
    }))
    .filter((surface) => surface.reach !== "unavailable");
}

function conversationLabel(mode: MobileInboxMode): string {
  return mode === "chat" ? "Chat" : "Thread";
}

/**
 * What the user may do on the browser surface, said plainly. A companion client
 * that can tap must also say what it cannot do, so nobody waits for a keyboard
 * that is never coming.
 */
export function browserSurfaceReachNote(reach: RemoteThreadSurfaceReach): string {
  if (reach === "interactive") {
    return "Tap to click in this page. Typing and opening new pages stay on the Mac.";
  }
  if (reach === "read-only") return "Watching only. Acting in this page stays on the Mac.";
  return "This host does not share its browser with paired devices.";
}

/** The line under a browser view, describing the picture rather than guessing at it. */
export function browserSurfaceStatusNote(input: {
  readonly status: "showing" | "waiting" | "idle" | "unavailable";
  readonly stale: boolean;
  readonly url?: string;
}): string {
  if (input.status === "unavailable") {
    return "This host does not share its browser with paired devices.";
  }
  if (input.status === "idle") return "No browser is running for this thread.";
  if (input.status === "waiting") return "Waiting for the Mac to capture this page.";
  const where = input.url ?? "this page";
  return input.stale ? `${where} · the Mac has moved on since this picture` : where;
}
