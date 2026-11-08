import { useEffect, useState } from "react";
import { hubAdministrationOf, ownerUnlockOf, type OctantHostBridge } from "../../shell/hostBridge";
import { PrepareToShutDownDialog } from "./PrepareToShutDownDialog";
import { threadMoveClientForBridge } from "./threadMoveClient";

const STATUS_REFRESH_MS = 60_000;

/** A spoke with a roster naming anyone else, or a hub whose roster names another member. */
function inHubWithOthers(body: unknown): boolean {
  const members = (side: unknown): number => {
    const roster =
      typeof side === "object" && side !== null ? Reflect.get(side, "roster") : undefined;
    const inner =
      typeof roster === "object" && roster !== null ? Reflect.get(roster, "roster") : undefined;
    const list =
      typeof inner === "object" && inner !== null ? Reflect.get(inner, "members") : undefined;
    return Array.isArray(list) ? list.length : 0;
  };
  if (typeof body !== "object" || body === null) return false;
  const spoke = Reflect.get(body, "spoke");
  const hub = Reflect.get(body, "hub");
  const spokeMember =
    typeof spoke === "object" && spoke !== null && Reflect.get(spoke, "membership") === "member";
  const hubOn = typeof hub === "object" && hub !== null && Reflect.get(hub, "enabled") === true;
  return (spokeMember && members(spoke) > 1) || (hubOn && members(hub) > 1);
}

/**
 * Opens Prepare to shut down when the desktop asks: from Prepare to Shut
 * Down… in the application menu, or Move threads first… in the quit
 * confirmation, which ends with Quit Octant. A window without the loopback
 * hub administration (a remote client) never shows it.
 */
export function PrepareToShutDownHost(props: {
  readonly hostBridge: OctantHostBridge | undefined;
  readonly onOpenHubSettings?: () => void;
}) {
  // Once opened, the dialog stays mounted while hidden: its batch keeps
  // moving on the server, and opening it again shows that batch's progress.
  const [request, setRequest] = useState<
    { readonly fromQuit: boolean; readonly open: boolean } | undefined
  >(undefined);
  const subscribe = props.hostBridge?.subscribePrepareToShutDown;
  useEffect(() => {
    if (subscribe === undefined) return;
    return subscribe((next) => setRequest({ fromQuit: next.fromQuit, open: true }));
  }, [subscribe]);
  const hide = () => setRequest((current) => current && { ...current, open: false });
  const hub = hubAdministrationOf(props.hostBridge);
  const report = props.hostBridge?.reportShutdownMovesOffered;
  // Quit offers Move threads first… only while this computer is in a hub with
  // another member; the hub's status is read now and then, never per thread.
  useEffect(() => {
    if (hub === undefined || report === undefined) return;
    let stopped = false;
    const read = () => {
      hub
        .hubAdministrationRequest("status")
        .then((answer) => {
          if (!stopped) report(answer.status === 200 && inHubWithOthers(answer.body));
        })
        .catch(() => undefined);
    };
    read();
    const timer = setInterval(read, STATUS_REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // The bridge's administration object is rebuilt each render; its request is stable.
  }, [hub?.hubAdministrationRequest, report]);
  if (props.hostBridge === undefined || hub === undefined || request === undefined) return null;
  const unlock = ownerUnlockOf(props.hostBridge);
  const requestQuit = props.hostBridge.requestQuit;
  return (
    <PrepareToShutDownDialog
      client={threadMoveClientForBridge(props.hostBridge, hub)}
      onClose={hide}
      {...(props.onOpenHubSettings === undefined
        ? {}
        : {
            onOpenHubSettings: () => {
              hide();
              props.onOpenHubSettings?.();
            },
          })}
      {...(request.fromQuit && requestQuit !== undefined
        ? {
            onQuit: () => {
              hide();
              requestQuit();
            },
          }
        : {})}
      open={request.open}
      {...(unlock === undefined ? {} : { unlock })}
    />
  );
}
