import { useMemo, useState } from "react";
import type { NativeHarnessSessionView } from "@octant/contracts";
import type { NativeHarnessClient } from "@octant/client-runtime/native-harness-client";
import {
  createThreadMessageQueueClient,
  type ThreadMessageQueueClient,
} from "../messageQueue/threadMessageQueueClient";
import { leadApproval, ThreadHarnessApproval } from "./ThreadHarnessApproval";
import { workLeadQuestion, ThreadHarnessQuestion } from "./ThreadHarnessQuestion";
import { ThreadHarnessSteering } from "./ThreadHarnessSteering";
import { useThreadHarnessSession } from "./useThreadHarnessSession";

export interface ThreadHarnessCardsProps {
  readonly client: Pick<
    NativeHarnessClient,
    "session" | "decideApproval" | "command" | "answerQuestion" | "steer" | "takeSteering"
  >;
  readonly threadId: string;
  /** The thread list says this thread waits on the person. */
  readonly waiting?: boolean;
  /** The thread list says a turn is running. */
  readonly running?: boolean;
  readonly refreshIntervalMs?: number;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly queueClient?: ThreadMessageQueueClient;
}

/**
 * What a harness thread keeps beside its composer, from one read of its
 * session: the lead's own approval, a Work lead's own question, and notes for
 * the running turn. A thread whose lead is not the harness reads one `null`
 * and shows nothing.
 */
export function ThreadHarnessCards(props: ThreadHarnessCardsProps) {
  const { client, threadId } = props;
  const waiting = props.waiting === true;
  const running = props.running === true;
  const queue = useMemo(
    () =>
      props.queueClient ??
      (props.serverUrl === undefined || props.windowCapability === undefined
        ? undefined
        : createThreadMessageQueueClient({
            serverUrl: props.serverUrl,
            windowCapability: props.windowCapability,
          })),
    [props.queueClient, props.serverUrl, props.windowCapability],
  );
  const [retryPending, setRetryPending] = useState(false);
  const { view, reload } = useThreadHarnessSession({
    client,
    threadId,
    // A turn starting, ending, or parking on the person reads at once, so a
    // card or the notes the lead never reached show without waiting a tick.
    readAgainOn: `${running}:${waiting}`,
    refreshEvery: (current) =>
      refreshInterval(current, {
        waiting,
        running,
        followsUpNotes: queue !== undefined,
        retryPending,
        ...(props.refreshIntervalMs === undefined ? {} : { every: props.refreshIntervalMs }),
      }),
  });

  return (
    <>
      <ThreadHarnessApproval client={client} reload={reload} threadId={threadId} view={view} />
      <ThreadHarnessQuestion client={client} reload={reload} threadId={threadId} view={view} />
      <ThreadHarnessSteering
        key={threadId}
        client={client}
        onRetryPending={setRetryPending}
        queue={queue}
        reload={reload}
        running={running}
        threadId={threadId}
        view={view}
      />
    </>
  );
}

/**
 * How soon to read again. A thread waiting on the person, or showing them a
 * card, refreshes quickly so a decision from another surface clears it here. A
 * running turn refreshes a little slower for its notes, and so does a session
 * whose unreached notes still have to be handed to the next message. A thread
 * whose lead is not the harness is read once, unless the thread list says it
 * waits on the person: that hint alone keeps the quick refresh going.
 */
function refreshInterval(
  view: NativeHarnessSessionView | null | undefined,
  input: {
    readonly waiting: boolean;
    readonly running: boolean;
    readonly followsUpNotes: boolean;
    readonly retryPending: boolean;
    readonly every?: number;
  },
): number | undefined {
  if (
    input.waiting ||
    view?.session.status === "recovery-required" ||
    leadApproval(view) !== undefined ||
    workLeadQuestion(view) !== undefined
  ) {
    return input.every ?? 1_500;
  }
  if (view === null) return undefined;
  // The thread list leaves out a turn parked on an approval or a question, but
  // the session is still running then; keep reading while it says so, or a turn
  // that settles between list refreshes would leave the note input showing.
  const live = input.running || view?.session.status === "running";
  // A separate session control can resume a held turn without changing the
  // thread-list props. Keep observing until its unreached notes are claimed.
  const notesToHandOn =
    input.retryPending ||
    (input.followsUpNotes && view?.steering?.some((note) => note.status === "queued") === true);
  return live || notesToHandOn ? (input.every ?? 2_000) : undefined;
}
