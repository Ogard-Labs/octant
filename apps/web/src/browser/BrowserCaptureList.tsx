import {
  BrowserAutomationClientFailure,
  type BrowserAutomationClient,
} from "@octant/client-runtime/browser-automation-client";
import type { BrowserCapture, BrowserThreadId } from "@octant/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { samePollingData } from "../polling/samePollingData";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import { useWorkspaceContentView } from "../shell/WorkspaceContentView";
import { OctantButton } from "../ui/base/OctantButton";
import "./browser-captures.css";

/**
 * Captures only appear when the agent takes a screenshot or the person does,
 * so an idle thread re-reads on a slow beat rather than on every frame.
 */
const CAPTURE_POLL_MS = 5_000;

export interface BrowserCaptureListProps {
  readonly client: BrowserAutomationClient;
  readonly threadId: BrowserThreadId;
  /**
   * The column the strip sits in. Chat and Code lay each transcript block in
   * the thread column themselves; Work's trail is already inside it. Without
   * it the strip ran to the pane's edge, clear of the messages.
   */
  readonly className?: string;
}

/**
 * The screenshots a thread kept, newest first. Absent entirely until the
 * thread has one, so a thread that never used the Browser shows nothing.
 */
export function BrowserCaptureList(props: BrowserCaptureListProps) {
  const workspace = useWorkspaceContentView();
  const [captures, setCaptures] = useState<ReadonlyArray<BrowserCapture>>([]);
  const [expanded, setExpanded] = useState<BrowserCapture | undefined>(undefined);
  const refused = useRef(false);
  const revision = useThreadActivityRevision("browserCaptures");

  // A different client or thread starts clean; a notice never clears the list.
  useEffect(() => {
    refused.current = false;
    setCaptures([]);
    setExpanded(undefined);
  }, [props.client, props.threadId]);

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      const listCaptures = props.client.listCaptures;
      if (listCaptures === undefined || refused.current) return;
      try {
        const response = await listCaptures.call(
          props.client,
          { threadId: props.threadId },
          signal,
        );
        if (signal.aborted) return;
        setCaptures((current) =>
          samePollingData(current, response.captures) ? current : response.captures,
        );
      } catch (error) {
        // An aborted read belongs to the old thread; its refusal must not
        // suppress the new one.
        if (signal.aborted) return;
        // A host that refuses this window will refuse the next read too, so
        // stop asking for this thread. Any other failure is transient: keep
        // the last list and try again rather than parking an error above
        // the composer.
        if (error instanceof BrowserAutomationClientFailure && error.category === "unauthorized") {
          refused.current = true;
        }
      }
    },
    [props.client, props.threadId],
  );
  useVisibleRefresh(
    refresh,
    revision,
    revision === undefined ? CAPTURE_POLL_MS : THREAD_ACTIVITY_RECOVERY_MS,
  );

  if (captures.length === 0) return null;

  const open = (capture: BrowserCapture) => {
    if (workspace === undefined) {
      setExpanded((current) => (current?.captureId === capture.captureId ? undefined : capture));
      return;
    }
    workspace.open(`browser-capture:${capture.captureId}`, captureLabel(capture), () => (
      <BrowserCaptureView capture={capture} client={props.client} threadId={props.threadId} />
    ));
  };

  return (
    <section
      aria-label="Browser captures"
      className={
        props.className === undefined ? "browser-captures" : `browser-captures ${props.className}`
      }
      data-testid="browser-capture-list"
    >
      <h3 className="oct-section-label">Browser captures</h3>
      <ul className="browser-captures__list">
        {captures.map((capture) => (
          <li className="browser-capture" key={capture.captureId}>
            <OctantButton
              aria-label={`Open capture of ${captureLabel(capture)}`}
              className="browser-capture__hit"
              onClick={() => open(capture)}
              type="button"
              variant="bare"
            />
            <BrowserCaptureImage
              capture={capture}
              className="browser-capture__thumb"
              client={props.client}
              threadId={props.threadId}
            />
            <span className="browser-capture__text">
              <span className="browser-capture__title">{captureLabel(capture)}</span>
              <span className="oct-meta oct-meta--mono browser-capture__origin">
                {capture.origin}
                {capture.profile === undefined
                  ? ""
                  : ` · ${capture.profile.kind === "personal" ? "Personal" : "Project"} profile`}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {expanded === undefined ? null : (
        <BrowserCaptureView capture={expanded} client={props.client} threadId={props.threadId} />
      )}
    </section>
  );
}

function BrowserCaptureView(props: {
  readonly capture: BrowserCapture;
  readonly client: BrowserAutomationClient;
  readonly threadId: BrowserThreadId;
}) {
  return (
    <figure className="browser-capture-view" data-testid="browser-capture-view">
      <BrowserCaptureImage
        capture={props.capture}
        className="browser-capture-view__image"
        client={props.client}
        threadId={props.threadId}
      />
      <figcaption className="oct-meta">
        <span className="oct-meta--mono">{props.capture.url}</span>
        <span> · {new Date(props.capture.capturedAt).toLocaleString()}</span>
      </figcaption>
    </figure>
  );
}

function BrowserCaptureImage(props: {
  readonly capture: BrowserCapture;
  readonly client: BrowserAutomationClient;
  readonly threadId: BrowserThreadId;
  readonly className: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | undefined>(undefined);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const readCapture = props.client.readCapture;
    setDataUrl(undefined);
    setUnavailable(false);
    if (readCapture === undefined) return;
    const controller = new AbortController();
    void readCapture
      .call(
        props.client,
        { threadId: props.threadId, captureId: props.capture.captureId },
        controller.signal,
      )
      .then((image) => {
        if (!controller.signal.aborted) setDataUrl(image.dataUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setUnavailable(true);
      });
    return () => controller.abort();
  }, [props.capture.captureId, props.client, props.threadId]);

  if (unavailable) {
    return <span aria-label="Capture is unavailable" className={props.className} role="img" />;
  }
  if (dataUrl === undefined) return <span aria-hidden="true" className={props.className} />;
  // The contract constrains the data URL to an image, so this never loads a
  // network or local resource.
  return (
    <img
      alt={`Capture of ${captureLabel(props.capture)}`}
      className={props.className}
      draggable={false}
      src={dataUrl}
    />
  );
}

function captureLabel(capture: BrowserCapture): string {
  return capture.title ?? capture.origin;
}
