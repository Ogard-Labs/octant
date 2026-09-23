import { decodeWindowId, type WindowId } from "@octant/contracts/shell";
import type { OctantHostBridge } from "../shell/hostBridge";

export function windowIdFromHostBridge(
  hostBridge: OctantHostBridge | undefined,
): WindowId | undefined {
  if (hostBridge?.windowId === undefined) return undefined;
  try {
    return decodeWindowId(hostBridge.windowId);
  } catch {
    return undefined;
  }
}
