import { createContext, useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantAlert } from "../ui/base/OctantAlert";

/**
 * Whether the thread around a composer has lost its host connection. The
 * thread's workspace provides it, so surfaces hoisted into the composer (the
 * subagent tray) can step back without the pane threading it through.
 */
export const ThreadConnectionLostContext = createContext(false);

/** How long "Reconnected" stays before the thread goes back to being quiet. */
export const RECONNECTED_NOTICE_MS = 4_000;

/**
 * The one place a thread says its host connection is lost.
 *
 * A lost connection used to surface as a banner, a transcript note, a line in
 * the subagent strip and a queue row, all describing the same condition in
 * four voices. This notice is the only one that speaks; the strip and queue
 * dim and disable their controls instead. When the host answers again it says
 * "Reconnected" for a moment, so the change is seen rather than inferred from
 * the notice vanishing.
 */
export function ThreadConnectionNotice(props: {
  readonly connected: boolean;
  /** Tries the host now instead of waiting for the next automatic attempt. */
  readonly onRetry?: () => void;
}) {
  const [reconnected, setReconnected] = useState(false);
  const wasLost = useRef(false);
  useEffect(() => {
    if (!props.connected) {
      wasLost.current = true;
      setReconnected(false);
      return;
    }
    if (!wasLost.current) return;
    wasLost.current = false;
    setReconnected(true);
    const timer = window.setTimeout(() => setReconnected(false), RECONNECTED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [props.connected]);

  if (!props.connected) {
    return (
      <OctantAlert
        action={
          props.onRetry === undefined ? undefined : (
            <OctantButton onClick={props.onRetry} size="sm" type="button" variant="outline">
              Retry now
            </OctantButton>
          )
        }
        className="thread-connection-notice"
        testId="thread-connection-notice"
        title="Can't reach the host"
        tone="warning"
      >
        <p>Reconnecting. Your draft is kept.</p>
      </OctantAlert>
    );
  }
  if (!reconnected) return null;
  return (
    <OctantAlert
      className="thread-connection-notice"
      testId="thread-connection-notice"
      tone="success"
    >
      <p>Reconnected</p>
    </OctantAlert>
  );
}
