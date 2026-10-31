import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { rotatePhoneNotifications } from "./enablePhoneNotifications";
import type { MobileNotificationPermissionPort } from "./notificationPermissionPort";
import type { PushRegistrationBook } from "./pushRegistrationBook";

/**
 * Keeps this phone's notification registrations current for as long as the app
 * is open: once when the app starts, again whenever a computer connects, and
 * whenever the app returns to the foreground, which is when the system's push
 * token may have changed. Runs never overlap, and a failed run is simply tried
 * again at the next trigger; nothing is shown to the person.
 */
export function usePhoneNotificationRotation(input: {
  readonly book: PushRegistrationBook;
  readonly permission: MobileNotificationPermissionPort;
  readonly transportForHost: (hostId: string) => MobileRemoteTransport | undefined;
  /** Changes when a computer connects or drops, so a waiting registration is retried. */
  readonly transports: ReadonlyArray<MobileRemoteTransport>;
}): void {
  const latest = useRef(input);
  latest.current = input;
  const running = useRef(false);
  const queued = useRef(false);

  const run = useCallback(async (): Promise<void> => {
    if (running.current) {
      queued.current = true;
      return;
    }
    running.current = true;
    try {
      const { book, permission, transportForHost } = latest.current;
      await rotatePhoneNotifications({ book, permission, transportForHost });
    } catch {
      // The next trigger tries again.
    } finally {
      running.current = false;
      if (queued.current) {
        queued.current = false;
        void run();
      }
    }
  }, []);

  useEffect(() => {
    void run();
  }, [input.transports, run]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void run();
    });
    return () => subscription.remove();
  }, [run]);
}
