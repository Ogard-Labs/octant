import { useCallback } from "react";
import {
  askRemoteSessionStanding,
  RESTRICTED_REMOTE_SESSION,
  type RemoteSessionStanding,
} from "@octant/client-runtime";
import { usePolledResource } from "../runtime/usePolledResource";

type SessionStandingTransport = Parameters<typeof askRemoteSessionStanding>[0];
const DEMO_STANDING: RemoteSessionStanding = { actsAsHostPerson: true };
const STANDING_REFRESH_INTERVAL_MS = 10_000;

/**
 * What the host says this phone's session is, asked per host. Until it
 * answers, and whenever it does not, the session is shown as restricted.
 * Refresh while the app is in front and when it returns to the foreground.
 * The host can change a device's access without replacing its connection.
 */
export function useRemoteSessionStanding(
  transport: SessionStandingTransport | undefined,
  offlineDemo: boolean,
  refresh = 0,
  /** Told what the host said, and nothing when it could not be reached. */
  onAnswered?: (standing: RemoteSessionStanding) => void,
): RemoteSessionStanding {
  const load = useCallback(async () => {
    const asked =
      transport === undefined
        ? { answered: false, standing: RESTRICTED_REMOTE_SESSION }
        : await askRemoteSessionStanding(transport);
    if (asked.answered) onAnswered?.(asked.standing);
    return { transport, refresh, standing: asked.standing };
  }, [onAnswered, transport, refresh]);
  const { value: read } = usePolledResource(load, {
    intervalMs: STANDING_REFRESH_INTERVAL_MS,
    enabled: !offlineDemo && transport !== undefined,
  });
  // The offline demo has no host to ask. For live sessions, access from the
  // previous computer cannot apply while the new one is still answering.
  if (offlineDemo) return DEMO_STANDING;
  return read !== undefined && read.transport === transport && read.refresh === refresh
    ? read.standing
    : RESTRICTED_REMOTE_SESSION;
}
