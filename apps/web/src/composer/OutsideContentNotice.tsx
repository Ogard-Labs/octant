import type { ContextClient, ExternalContentThread } from "@octant/client-runtime/context-client";
import { ContextClientFailure } from "@octant/client-runtime/context-client";
import type {
  ThreadExternalContentClearRefusal,
  ThreadExternalContentSource,
  ThreadExternalContentState,
} from "@octant/contracts/content-provenance";
import { Globe } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { absoluteTimeFormatter } from "../lib/relativeTime";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import { describeOutsideContentReads, describeSource } from "@octant/domain";
import "./outside-content-notice.css";

/**
 * The thread a pane shows, for the composer inside it. Absent where a composer
 * has no thread yet, where the thread lives on another host, and wherever the
 * window is not a local one.
 */
export interface OutsideContentThread extends ExternalContentThread {
  readonly client: ContextClient;
}

interface OutsideContentMark {
  /** Whether the thread has read outside content since its mark was last cleared. */
  readonly marked: boolean;
  /** How many times it has read some. */
  readonly reads: number;
  /** Whether the mark has any effect: it asks nothing at Full access. */
  readonly effective: boolean;
  /** The access control reports whether the thread is at Full access. */
  readonly reportFullAccess: (fullAccess: boolean) => void;
  /** A turn is running or messages are queued: a clear would be refused. */
  readonly reportBusy: (busy: boolean) => void;
  /** Opens the review dialog; focus returns to `opener` when it closes. */
  readonly review: (opener: HTMLElement | null) => void;
}

const OutsideContentMarkContext = createContext<OutsideContentMark | undefined>(undefined);

/**
 * Owns the mark of the thread a pane shows, for the two places that say it
 * (the Environment panel's row and the icon in the composer's row) and for the
 * one review dialog both open. Server-owned: this only reads the mark and
 * sends the person's clear. A paired device is refused the read, so it never
 * shows a mark.
 */
export function OutsideContentProvider(props: {
  readonly thread: OutsideContentThread | undefined;
  readonly children: ReactNode;
}) {
  const { thread } = props;
  if (thread === undefined || !thread.client.externalContentAvailable) {
    return <>{props.children}</>;
  }
  return (
    <OutsideContentOwner
      client={thread.client}
      key={`${thread.mode}:${thread.threadId}`}
      mode={thread.mode}
      threadId={thread.threadId}
    >
      {props.children}
    </OutsideContentOwner>
  );
}

function OutsideContentOwner(props: OutsideContentThread & { readonly children: ReactNode }) {
  const { client, mode, threadId } = props;
  const [state, setState] = useState<ThreadExternalContentState>();
  const [fullAccess, setFullAccess] = useState(false);
  const [busy, setBusy] = useState(false);
  // The newest version accepted. A read answers whenever it likes, so one begun
  // before a clear can arrive after it; the aggregate version says it is older,
  // and it is dropped instead of bringing the mark back.
  const acceptedVersion = useRef(-1);
  const accept = useCallback((next: ThreadExternalContentState) => {
    if (next.version < acceptedVersion.current) return;
    acceptedVersion.current = next.version;
    setState(next);
  }, []);
  const [reviewing, setReviewing] = useState<ThreadExternalContentState>();
  const opener = useRef<HTMLElement | null>(null);

  // A turn is what takes outside content in, so the mark is read again when
  // one starts and when it settles, not on a timer.
  useEffect(() => {
    const controller = new AbortController();
    client
      .readExternalContent({ mode, threadId }, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) accept(next);
      })
      // Without a read the mark keeps what it last knew; the clear itself names
      // the version it needs and the host refuses a stale one.
      .catch(() => undefined);
    return () => controller.abort();
  }, [client, mode, threadId, busy, accept]);

  const marked = state?.externalContentIngested === true;
  const value: OutsideContentMark = {
    marked,
    reads: state?.ingestionCount ?? 0,
    effective: !fullAccess,
    reportFullAccess: setFullAccess,
    reportBusy: setBusy,
    review: (from) => {
      if (state === undefined || !state.externalContentIngested) return;
      opener.current = from;
      setReviewing(state);
    },
  };

  return (
    <OutsideContentMarkContext value={value}>
      {props.children}
      <OctantDialogPresence>
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
            restoreFocus={opener}
            threadId={threadId}
          />
        )}
      </OctantDialogPresence>
    </OutsideContentMarkContext>
  );
}

/** Tells the mark whether a turn is running, from the composer that knows. */
export function useReportOutsideContentBusy(busy: boolean): void {
  const report = useContext(OutsideContentMarkContext)?.reportBusy;
  useEffect(() => report?.(busy), [report, busy]);
}

const MARK_TOOLTIP =
  "This thread read outside content, so risky actions ask first. Review in Environment.";

/**
 * The mark in the composer's row, immediately before the access control: a
 * globe in the warning ink and no words, only while the mark has effect. At
 * Full access nothing shows. Rendered by the access control, which says whether
 * the thread is at Full access.
 */
export function ComposerOutsideContentMark(props: { readonly fullAccess: boolean }) {
  const mark = useContext(OutsideContentMarkContext);
  const report = mark?.reportFullAccess;
  const { fullAccess } = props;
  useEffect(() => {
    report?.(fullAccess);
    return () => report?.(false);
  }, [report, fullAccess]);
  if (mark === undefined || !mark.marked || fullAccess) return null;
  return (
    <OctantTooltip label={MARK_TOOLTIP}>
      <OctantButton
        aria-label={MARK_TOOLTIP}
        className="outside-content-mark"
        onClick={(event) => mark.review(event.currentTarget)}
        size="icon"
        type="button"
        variant="ghost"
      >
        <Globe aria-hidden="true" size={16} />
      </OctantButton>
    </OctantTooltip>
  );
}

/**
 * The thread's Environment row while it carries the mark: how many times it
 * read outside content, and Review. The globe takes the warning ink only while
 * the mark has effect.
 */
export function OutsideContentRow() {
  const mark = useContext(OutsideContentMarkContext);
  if (mark === undefined || !mark.marked) return null;
  return (
    <section
      aria-label="Outside content"
      className="outside-content-row"
      data-effective={mark.effective ? "true" : "false"}
    >
      <Globe aria-hidden="true" className="outside-content-row__icon" size={14} />
      <span className="outside-content-row__text">
        Outside content · read {mark.reads === 1 ? "once" : `${String(mark.reads)} times`}
      </span>
      <OctantButton
        className="outside-content-row__action"
        onClick={(event) => mark.review(event.currentTarget)}
        size="sm"
        type="button"
        variant="ghost"
      >
        Review
      </OctantButton>
    </section>
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
      confirmLabel="Clear mark"
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
      title="Outside content in this thread"
    >
      This thread read text from outside Octant: {readSummary(shown.sources)}. While it's marked,
      risky actions ask you first. Clearing it says you've checked it; it doesn't undo what the
      model read, and new outside content marks it again.
    </OctantConfirmDialog>
  );
}

/**
 * The first few kinds of source in words, each with its count: "command output,
 * 2 times". Two labels that read the same in words (a page the browser showed
 * is recorded under more than one) are one kind here.
 */
function readSummary(sources: ReadonlyArray<ThreadExternalContentSource>): string {
  const kinds = new Map<string, number>();
  for (const source of sources) {
    const words = describeSource(source.sourceLabel);
    const lower = /^(?:An? |Your |[A-Z][a-z])/.test(words)
      ? `${words.charAt(0).toLowerCase()}${words.slice(1)}`
      : words;
    kinds.set(lower, (kinds.get(lower) ?? 0) + source.ingestionCount);
  }
  const named = [...kinds].slice(0, 3).map(([words, count]) => {
    return `${words}, ${count === 1 ? "once" : `${String(count)} times`}`;
  });
  const more = kinds.size - named.length;
  return more > 0 ? `${named.join("; ")}; and ${String(more)} more` : named.join("; ");
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
  return describeOutsideContentReads(source, time);
}

function time(at: string | undefined): string | undefined {
  if (at === undefined) return undefined;
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? undefined : absoluteTimeFormatter.format(parsed);
}
