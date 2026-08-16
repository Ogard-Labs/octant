import type { MobileInboxRow } from "@octant/client-runtime";
import { parseMobileThreadDeepLink, type MobileDeepLinkTarget } from "../notifications/deepLinks";

/**
 * Resolve a deep-link URL into an inbox row the navigator can open.
 * Title is a placeholder until ThreadScreen loads host truth.
 */
export function resolveDeepLinkToInboxRow(
  url: string,
  knownRows: ReadonlyArray<MobileInboxRow> = [],
): MobileInboxRow | undefined {
  const target = parseMobileThreadDeepLink(url);
  if (target === undefined) return undefined;
  return inboxRowFromDeepLinkTarget(target, knownRows);
}

export function inboxRowFromDeepLinkTarget(
  target: MobileDeepLinkTarget,
  knownRows: ReadonlyArray<MobileInboxRow> = [],
): MobileInboxRow {
  const known = knownRows.find(
    (row) =>
      row.hostId === target.hostId &&
      row.threadId === target.threadId &&
      (target.mode === undefined || row.mode === target.mode),
  );
  if (known !== undefined) return known;
  return {
    hostId: target.hostId,
    threadId: target.threadId,
    mode: target.mode ?? "chat",
    title: "Thread",
    status: "active",
    freshness: new Date(0).toISOString(),
  };
}
