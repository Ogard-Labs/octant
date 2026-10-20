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

/**
 * A link without a mode is refused rather than opened as Chat: guessing the
 * mode opened Work and Code threads in the wrong screen.
 */
export function inboxRowFromDeepLinkTarget(
  target: MobileDeepLinkTarget,
  knownRows: ReadonlyArray<MobileInboxRow> = [],
): MobileInboxRow | undefined {
  const { mode } = target;
  if (mode === undefined) return undefined;
  const known = knownRows.find(
    (row) => row.hostId === target.hostId && row.threadId === target.threadId && row.mode === mode,
  );
  if (known !== undefined) return known;
  return {
    hostId: target.hostId,
    threadId: target.threadId,
    mode,
    title: "Thread",
    status: "active",
    freshness: new Date(0).toISOString(),
  };
}

// Defined here because the shared copy file is owned elsewhere in this change.
export const DEEP_LINK_HOST_NOT_PAIRED = "That computer isn't paired on this phone.";

/**
 * A link to a computer this phone never paired would open a thread screen that
 * can only fail. The navigator shows this reason instead of opening it.
 */
export function deepLinkRefusal(
  row: Pick<MobileInboxRow, "hostId">,
  pairedHostIds: ReadonlyArray<string>,
): string | undefined {
  return pairedHostIds.some((hostId) => hostId === row.hostId)
    ? undefined
    : DEEP_LINK_HOST_NOT_PAIRED;
}
