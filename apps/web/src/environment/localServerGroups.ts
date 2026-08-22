import type { LocalServerListener, LocalServerSnapshot } from "@octant/contracts";

export interface LocalServerListenerGroup {
  readonly key: string;
  readonly processName: string;
  readonly port: LocalServerListener["port"];
  readonly framework: string | undefined;
  readonly workingDirectory: string | undefined;
  readonly workspaceLabel: string | undefined;
  readonly listeners: ReadonlyArray<LocalServerListener>;
  readonly primary: LocalServerListener;
}

/**
 * Collapse duplicate loopback sockets that are one logical process on one
 * port. Vite routinely binds `127.0.0.1` and `::1` together; listing both as
 * separate servers made one leftover look like two.
 */
export function groupLocalServerListeners(
  listeners: ReadonlyArray<LocalServerListener>,
): ReadonlyArray<LocalServerListenerGroup> {
  const grouped = new Map<string, LocalServerListener[]>();
  const order: string[] = [];
  for (const listener of listeners) {
    const key = groupKey(listener);
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, [listener]);
      order.push(key);
      continue;
    }
    existing.push(listener);
  }
  return order.flatMap((key) => {
    const members = grouped.get(key);
    const first = members?.[0];
    if (members === undefined || first === undefined) return [];
    return [toGroup(key, first, members)];
  });
}

/** One dual-stack process counts once in the compact Environment summary. */
export function countGroupedLocalServerListeners(
  snapshot: Pick<LocalServerSnapshot, "currentCheckout" | "other">,
): number {
  return (
    groupLocalServerListeners(snapshot.currentCheckout).length +
    groupLocalServerListeners(snapshot.other).length
  );
}

function groupKey(listener: LocalServerListener): string {
  return [
    listener.processName,
    String(listener.port),
    listener.workingDirectory ?? "",
    listener.attribution,
  ].join("\0");
}

function toGroup(
  key: string,
  first: LocalServerListener,
  listeners: ReadonlyArray<LocalServerListener>,
): LocalServerListenerGroup {
  return {
    key,
    processName: first.processName,
    port: first.port,
    framework: first.framework,
    workingDirectory: first.workingDirectory,
    workspaceLabel: first.workspaceLabel,
    listeners,
    primary: primaryListener(listeners, first),
  };
}

function primaryListener(
  listeners: ReadonlyArray<LocalServerListener>,
  first: LocalServerListener,
): LocalServerListener {
  return (
    listeners.find((listener) => listener.openAvailable) ??
    listeners.find((listener) => listener.stop.status === "available") ??
    first
  );
}
