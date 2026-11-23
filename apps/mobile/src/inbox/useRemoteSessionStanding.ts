import { useEffect, useState } from "react";
import { AppState } from "react-native";
import {
  readRemoteSessionStanding,
  RESTRICTED_REMOTE_SESSION,
  type RemoteSessionStanding,
} from "@octant/client-runtime";
import { enteredMobileForeground } from "./threadRefreshPolicy";

type SessionStandingTransport = Parameters<typeof readRemoteSessionStanding>[0];

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
  const [standing, setStanding] = useState<RemoteSessionStanding>(RESTRICTED_REMOTE_SESSION);
  useEffect(() => {
    // The offline demo has no host to ask or to refuse: its sample session
    // acts as the person, the only answer the fail-closed rule is exempt for.
    if (offlineDemo) {
      setStanding({ actsAsHostPerson: true });
      return;
    }
    setStanding(RESTRICTED_REMOTE_SESSION);
    if (transport === undefined) return;
    let current = true;
    const reread = () => {
      void readRemoteSessionStanding(transport).then((answer) => {
        if (current) setStanding(answer);
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
  return standing;
}
