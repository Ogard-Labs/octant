import type { ThreadDocumentDelivery } from "@octant/contracts";

import { readPrincipalRouteContext } from "./principalRouteContext";

/** What a paired device is told when it tries to turn on a thread's artifacts. */
export const NATIVE_ARTIFACTS_LOCAL_ONLY =
  "Only the Octant window on this host can turn on Claude artifacts for a thread.";

/**
 * Whether a thread's choice to publish with the provider's own artifact tool
 * comes from anywhere but a window on this host. That choice turns on the
 * provider runtime's usage telemetry for the thread, the person's own privacy
 * decision, so it is the same local-only step as enabling the account's
 * setting. Choosing Canvas narrows nothing anyone holds and stays open to the
 * thread's other clients.
 */
export function refusesThreadDocumentDelivery(
  request: Request,
  documentDelivery: ThreadDocumentDelivery,
): boolean {
  if (documentDelivery !== "native-artifacts") return false;
  const principal = readPrincipalRouteContext(request)?.principal;
  return principal !== undefined && principal.kind !== "local-window";
}
