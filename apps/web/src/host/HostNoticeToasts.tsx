import {
  createAccessActivityClient,
  type AccessActivityPort,
} from "@octant/client-runtime/access-activity-client";
import { useMemo } from "react";
import { OctantToast } from "../ui/base/OctantToast";
import { describeNotice, useChangeNotices } from "./changeNoticeState";
import type { RestartNoticeThread } from "./hostRestartNotice";
import { useHostMemoryNotice, type HostMemoryStatusSource } from "./useHostMemoryNotice";
import { useHostRestartNotice, type HostRestartStatusSource } from "./useHostRestartNotice";

const TRANSIENT_NOTICE_MS = 10_000;

/** Host notices mount together after the shell's first render. */
export function HostNoticeToasts(props: {
  readonly port: AccessActivityPort;
  readonly host: HostMemoryStatusSource & HostRestartStatusSource;
  readonly changeRevision: number;
  readonly onReview: () => void;
  readonly restartThreads: ReadonlyArray<RestartNoticeThread>;
  readonly onOpenThread: (thread: RestartNoticeThread) => void;
  readonly onOpenHost: () => void;
}) {
  const client = useMemo(() => createAccessActivityClient(props.port), [props.port]);
  const { notices, act } = useChangeNotices(client, props.changeRevision);
  const [restart, dismissRestart] = useHostRestartNotice(props.host, props.restartThreads);
  const [memory, dismissMemory] = useHostMemoryNotice(props.host);
  const newest = notices[0];
  const restartThread = restart?.open;
  return (
    <>
      {newest === undefined ? null : (
        <OctantToast
          action={{ label: "Review", onSelect: props.onReview }}
          detail={
            newest.kind === "provider-key-replaced"
              ? "Revoke who did it in Settings › Remote access. A replaced key has no Undo."
              : "Undo it or revoke who did it in Settings › Remote access."
          }
          key={newest.noticeId}
          onDismiss={() => void act("dismiss", newest.noticeId)}
          title={describeNotice(newest)}
          tone="warning"
        />
      )}
      {restart === undefined ? null : (
        <OctantToast
          {...(restartThread === undefined
            ? {}
            : {
                action: {
                  label: `Open ${restartThread.title}`,
                  onSelect: () => props.onOpenThread(restartThread),
                },
              })}
          detail={restart.detail}
          onDismiss={dismissRestart}
          title={restart.title}
          tone={restart.needsYou ? "warning" : "neutral"}
        />
      )}
      {memory === undefined ? null : (
        <OctantToast
          action={{ label: "View host", onSelect: props.onOpenHost }}
          detail={memory.detail}
          // A later notice must start its own dismissal timer.
          key={memory.id}
          {...(memory.transient ? { leavesAfterMs: TRANSIENT_NOTICE_MS } : {})}
          onDismiss={dismissMemory}
          title={memory.title}
        />
      )}
    </>
  );
}
