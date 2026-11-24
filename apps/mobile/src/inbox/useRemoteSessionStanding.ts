import { useEffect, useState } from "react";
import { AppState } from "react-native";
import {
  readRemoteSessionStanding,
  RESTRICTED_REMOTE_SESSION,
  type RemoteSessionStanding,
} from "@octant/client-runtime";
import { enteredMobileForeground } from "./threadRefreshPolicy";

type SessionStandingTransport = Parameters<typeof readRemoteSessionStanding>[0];
const DEMO_STANDING: RemoteSessionStanding = { actsAsHostPerson: true };

/**
 * What the host says this phone's session is, asked per host. Until it
 * answers, and whenever it does not, the session is shown as restricted.
 * The answer is asked again when the app returns to the foreground: a pause
 * or a lost pairing made while the phone sat in the background would
 * otherwise keep the session's old reach until the thread changed.
 */
export function useRemoteSessionStanding(
  transport: SessionStandingTransport | undefined,
  offlineDemo: boolean,
): RemoteSessionStanding {
  const [read, setRead] = useState<{
    readonly transport: SessionStandingTransport;
    readonly standing: RemoteSessionStanding;
  }>();
  useEffect(() => {
    setRead(undefined);
    if (offlineDemo || transport === undefined) return;
    let current = true;
    const reread = () => {
      void readRemoteSessionStanding(transport).then((answer) => {
        if (current) setRead({ transport, standing: answer });
      });
    };
    reread();
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener("change", (next) => {
      const returnedToForeground = enteredMobileForeground(previous, next);
      previous = next;
      if (returnedToForeground) reread();
    });
    return () => {
      current = false;
      subscription.remove();
    };
  }, [transport, offlineDemo]);
  // The offline demo has no host to ask. For live sessions, access from the
  // previous computer cannot apply while the new one is still answering.
  if (offlineDemo) return DEMO_STANDING;
  return read !== undefined && read.transport === transport
    ? read.standing
    : RESTRICTED_REMOTE_SESSION;
}
