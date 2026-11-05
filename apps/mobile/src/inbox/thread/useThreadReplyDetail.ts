import { readMobileReplyDetail, type MobileRemoteTransport } from "@octant/client-runtime";
import type { OctantMode, ReplyDetailLevel, ReplyDetailReading } from "@octant/contracts";
import { effectiveReplyDetail } from "@octant/domain/reply-detail-policy";
import { useEffect, useState } from "react";
import { AppState } from "react-native";

/**
 * The Reply detail level the phone draws one thread at: the thread's own level
 * on the host, else the host's default. It is read when the thread opens and
 * whenever the app returns to the foreground, and reads Low until the host
 * answers or if it cannot, so a transcript never waits on a preference.
 */
export function useThreadReplyDetail(input: {
  readonly transport: MobileRemoteTransport | undefined;
  readonly mode: OctantMode | undefined;
  readonly threadId: string | undefined;
}): ReplyDetailLevel {
  const [reading, setReading] = useState<ReplyDetailReading | undefined>(undefined);
  const { transport, mode, threadId } = input;
  useEffect(() => {
    if (transport === undefined) return;
    const controller = new AbortController();
    const read = () =>
      void readMobileReplyDetail({ transport, signal: controller.signal }).then((answer) => {
        if (!controller.signal.aborted) setReading(answer);
      });
    read();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") read();
    });
    return () => {
      controller.abort();
      subscription.remove();
    };
  }, [transport, mode, threadId]);
  if (reading === undefined || mode === undefined || threadId === undefined) return "low";
  return effectiveReplyDetail(reading, { mode, threadId });
}
