import type { ContextClient, ExternalContentThread } from "@octant/client-runtime/context-client";
import { ContextClientFailure } from "@octant/client-runtime/context-client";
import type {
  ThreadExternalContentClearRefusal,
  ThreadExternalContentSource,
  ThreadExternalContentState,
} from "@octant/contracts/content-provenance";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { absoluteTimeFormatter } from "../lib/relativeTime";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { describeSource } from "./outsideContentSources";
import "./outside-content-notice.css";

/**
 * The thread a pane shows, for the composer inside it. Absent where a composer
 * has no thread yet, where the thread lives on another host, and wherever the
 * window is not a local one.
 */
export interface OutsideContentThread extends ExternalContentThread {
  readonly client: ContextClient;
}
export const OutsideContentContext = createContext<OutsideContentThread | undefined>(undefined);

/**
 * The notice for the thread around this composer, if it has read outside
 * content. A paired device is refused the read, so it never draws one.
 */
export function ComposerOutsideContentNotice(props: {
  /** A turn is running or messages are queued: a clear would be refused. */
  readonly busy: boolean;
}) {
  const thread = useContext(OutsideContentContext);
  if (thread === undefined || !thread.client.externalContentAvailable) return null;
  return (
    <OutsideContentNotice
      busy={props.busy}
      client={thread.client}
      key={`${thread.mode}:${thread.threadId}`}
      mode={thread.mode}
      threadId={thread.threadId}
    />
  );
}

export function OutsideContentNotice(props: OutsideContentThread & { readonly busy: boolean }) {
  const { client, mode, threadId, busy } = props;
  const [state, setState] = useState<ThreadExternalContentState>();
  // The newest version the notice has accepted. A read answers whenever it
  // likes, so one begun before a clear can arrive after it; the aggregate
  // version says it is older, and it is dropped instead of bringing the
  // notice back.
  const acceptedVersion = useRef(-1);
  const accept = useCallback((next: ThreadExternalContentState) => {
    if (next.version < acceptedVersion.current) return;
    acceptedVersion.current = next.version;
    setState(next);
  }, []);
  const [reviewing, setReviewing] = useState<ThreadExternalContentState>();
  const reviewButton = useRef<HTMLButtonElement>(null);

  // A turn is what takes outside content in, so the mark is read again when
  // one starts and when it settles, not on a timer.
  useEffect(() => {
    const controller = new AbortController();
    client
      .readExternalContent({ mode, threadId }, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) accept(next);
      })
      // Without a read the notice keeps what it last knew; the clear itself
      // names the version it needs and the host refuses a stale one.
      .catch(() => undefined);
    return () => controller.abort();
  }, [client, mode, threadId, busy, accept]);

  return (
    <>
      {state?.externalContentIngested === true ? (
        <OctantAlert
          action={
            <OctantButton
              onClick={() => setReviewing(state)}
              ref={reviewButton}
              size="sm"
              type="button"
              variant="outline"
            >
              Review
            </OctantButton>
          }
          className="outside-content-notice"
        >
          This thread has read outside content, so some actions will ask each time.
        </OctantAlert>
      ) : null}
      {reviewing === undefined ? null : (
        <ReviewOutsideContentDialog
          busy={busy}
          client={client}
          initial={reviewing}
          mode={mode}
          onClose={() => setReviewing(undefined)}
          onSettled={(next) => {
            accept(next);
            setReviewing(undefined);
          }}
          restoreFocus={reviewButton}
          threadId={threadId}
        />
      )}
    </>
  );
}

function ReviewOutsideContentDialog(
  props: OutsideContentThread & {
    readonly busy: boolean;
    readonly initial: ThreadExternalContentState;
    readonly onClose: () => void;
    readonly onSettled: (state: ThreadExternalContentState) => void;
    readonly restoreFocus: React.RefObject<HTMLElement | null>;
  },
) {
  const { client, mode, threadId } = props;
  // What the person is looking at, and so the version a clear names.
  const [shown, setShown] = useState(props.initial);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<{
    readonly kind: "info" | "warning";
    readonly text: string;
  }>();

  async function clear() {
    if (pending || props.busy) return;
    setPending(true);
    setRefusal(undefined);
    try {
      const outcome = await client.clearExternalContent({
        mode,
        threadId,
        expectedVersion: shown.version,
      });
      if (outcome.kind === "cleared" || outcome.kind === "already-clear") {
        props.onSettled(outcome.state);
        return;
      }
      if (outcome.reason === "stale") {
        const next = outcome.state ?? (await client.readExternalContent({ mode, threadId }));
        if (!next.externalContentIngested) {
          props.onSettled(next);
          return;
        }
        setShown(next);
        setRefusal({ kind: "info", text: REFUSAL_COPY.stale });
        return;
      }
      setRefusal({ kind: "warning", text: REFUSAL_COPY[outcome.reason] });
    } catch (error) {
      setRefusal({
        kind: "warning",
        text:
          error instanceof ContextClientFailure && error.category === "unauthorized"
            ? REFUSAL_COPY.unauthorized
            : "Octant could not reach the host to clear the mark. Try again.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <OctantConfirmDialog
      confirmDisabled={props.busy}
      confirmLabel="Clear the mark"
      details={
        <div className="outside-content-review">
          <ul aria-label="Outside content this thread read" className="outside-content-sources">
            {shown.sources.map((source) => (
              <li className="outside-content-sources__row" key={source.sourceLabel}>
                <span className="outside-content-sources__name">
                  {describeSource(source.sourceLabel)}
                </span>
                <span className="outside-content-sources__meta">{describeReads(source)}</span>
              </li>
            ))}
          </ul>
          {props.busy ? (
            <p className="outside-content-review__reason" role="status">
              A turn is running or messages are queued. Clear the mark once the thread is idle.
            </p>
          ) : null}
          {refusal === undefined ? null : (
            <OctantAlert
              className="outside-content-review__message"
              tone={refusal.kind === "info" ? "neutral" : "warning"}
            >
              {refusal.text}
            </OctantAlert>
          )}
        </div>
      }
      onCancel={props.onClose}
      onConfirm={() => void clear()}
      pending={pending}
      restoreFocus={props.restoreFocus}
      title="Outside content this thread read"
    >
      Clearing the mark tells Octant you looked at what this thread read, so actions stop asking
      because of it. It does not remove anything the model already read, and the next outside
      content marks the thread again.
    </OctantConfirmDialog>
  );
}

const REFUSAL_COPY: Record<ThreadExternalContentClearRefusal, string> = {
  stale:
    "New outside content arrived since you looked. The list is updated; review it, then clear.",
  "turn-active":
    "This thread is busy. Try again once its turn and any queued messages have finished.",
  "turn-unconfirmed":
    "This thread's last turn did not finish cleanly, so Octant cannot tell whether it has stopped. Check the thread, then try again.",
  unauthorized: "The mark cannot be cleared from this window.",
  "thread-unavailable": "This thread cannot be reached from this window, so its mark stays.",
};

/** How often and when a source was read; a row recorded before times were kept shows none. */
export function describeReads(source: ThreadExternalContentSource): string {
  const reads = source.ingestionCount === 1 ? "Read once" : `Read ${source.ingestionCount} times`;
  const first = time(source.firstIngestedAt);
  const last = time(source.lastIngestedAt);
  if (first === undefined && last === undefined) return reads;
  if (source.ingestionCount === 1 || first === last) return `${reads}, ${last ?? first}`;
  return [
    reads,
    first === undefined ? undefined : `first ${first}`,
    last === undefined ? undefined : `last ${last}`,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
}

function time(at: string | undefined): string | undefined {
  if (at === undefined) return undefined;
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? undefined : absoluteTimeFormatter.format(parsed);
}
