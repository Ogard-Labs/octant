import { BrowserPreviewThumbnail } from "./BrowserPreviewThumbnail";
import { ThreadActivityPreviewContext } from "./ThreadActivityEnvironment";
import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { ComputerUseClient } from "@octant/client-runtime/computer-use-client";
import type { BrowserThreadId } from "@octant/contracts/browser-automation";
import type { BrowserAutomationSnapshot } from "@octant/contracts/browser-automation-rpc";
import type { ComputerUseSessionView } from "@octant/contracts/computer-use";
import { Eye, EyeOff, MonitorUp, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { IconButton } from "../shell/IconButton";
import { OctantButton } from "../ui/base/OctantButton";
import { computerUseApproveLabel } from "../computerUse/computerUseApprovalCopy";

/** The slowest a preview of an unchanged page is asked for again. */
const MAX_UNCHANGED_POLL_MS = 5_000;

/**
 * Browser sessions whose preview the person hid, by thread and session. Held
 * for the life of the page because the preview remounts with its pane, and a
 * preview that came back after being closed would not be closed.
 */
const hiddenBrowserPreviews = new Set<string>();

export interface ThreadActivityPictureInPictureProps {
  /**
   * Whether this thread's Browser is already on screen (a pane, the dock, or
   * the bottom panel). A preview of a page the person can see is a copy of it,
   * so none is drawn and no picture is asked for.
   */
  readonly browserVisible?: boolean;
  readonly browserClient?: BrowserAutomationClient;
  readonly children: ReactNode;
  readonly computerUseClient?: ComputerUseClient;
  readonly enabled?: boolean;
  readonly onComputerUseSessionChange?: (
    threadId: string,
    sessionId: string,
    represented: boolean,
  ) => void;
  /**
   * Asks the window shell to reveal this thread's Browser surface. The payload
   * names the live session so the shell, not this pane instance, can remember
   * a dismissal across remounts.
   */
  readonly onOpenBrowser?: (activity: { readonly sessionIds: ReadonlyArray<string> }) => void;
  /** Shows this thread's Browser because the person opened the preview. */
  readonly onShowBrowser?: () => void;
  readonly pollIntervalMs?: number;
  readonly threadId: BrowserThreadId;
}

/**
 * Companion for a thread-owned Browser or Computer Use session.
 * It never creates or rebinds authority: every action goes back through the
 * existing exact-thread clients, while Browser activity can ask the shell to
 * reveal the already-authoritative Browser surface.
 *
 * Browser activity appears as a small live picture only while the Browser is
 * out of sight. Computer Use keeps its card, since an approval cannot wait for
 * the person to go looking for it.
 */
export function ThreadActivityPictureInPicture(props: ThreadActivityPictureInPictureProps) {
  const [browserSnapshot, setBrowserSnapshot] = useState<BrowserAutomationSnapshot>();
  const [computerSession, setComputerSession] = useState<ComputerUseSessionView>();
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, setHiddenRevision] = useState(0);
  const activityGeneration = useRef(0);
  const browserSignature = useRef("");

  const browserPreviewKey =
    browserSnapshot?.context === undefined
      ? undefined
      : `${String(props.threadId)}:${String(browserSnapshot.context.contextId)}`;
  const browserPreviewHidden =
    browserPreviewKey !== undefined && hiddenBrowserPreviews.has(browserPreviewKey);
  // A picture is asked for only while one could be seen.
  const wantsPicture = props.browserVisible !== true && !browserPreviewHidden;
  const hasPolledActivity =
    (wantsPicture && browserSnapshot !== undefined && isBrowserActivity(browserSnapshot)) ||
    (computerSession !== undefined && isComputerUseActivity(computerSession));
  const pollIntervalMs = props.pollIntervalMs ?? (hasPolledActivity ? 1_000 : 5_000);

  /** Resolves to whether the read changed what the preview would show. */
  const loadBrowser = useCallback(
    async (signal?: AbortSignal): Promise<boolean> => {
      const generation = activityGeneration.current;
      if (props.browserClient === undefined) {
        browserSignature.current = "";
        setBrowserSnapshot(undefined);
        return true;
      }
      try {
        const next = await props.browserClient.inspectThread(
          wantsPicture
            ? { threadId: props.threadId }
            : { threadId: props.threadId, freshPicture: false },
          signal,
        );
        if (signal?.aborted === true || generation !== activityGeneration.current) return true;
        const live =
          String(next.threadId) === String(props.threadId) && isBrowserActivity(next)
            ? next
            : undefined;
        const signature = browserPictureSignature(live);
        if (signature === browserSignature.current) return false;
        browserSignature.current = signature;
        setBrowserSnapshot(live);
        return true;
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) return true;
        if (generation !== activityGeneration.current) return true;
        browserSignature.current = browserPictureSignature(undefined);
        setBrowserSnapshot(undefined);
        return true;
      }
    },
    [props.browserClient, props.threadId, wantsPicture],
  );

  const loadComputerUse = useCallback(
    async (signal?: AbortSignal) => {
      const generation = activityGeneration.current;
      if (props.computerUseClient === undefined) {
        setComputerSession(undefined);
        return;
      }
      try {
        const sessions = await props.computerUseClient.list(signal);
        if (signal?.aborted === true || generation !== activityGeneration.current) return;
        const next = sessions
          .filter(
            (candidate) =>
              String(candidate.threadId) === String(props.threadId) &&
              isComputerUseActivity(candidate),
          )
          .sort((left, right) => right.sequence - left.sequence)[0];
        setComputerSession(next);
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) return;
        if (generation !== activityGeneration.current) return;
        setComputerSession(undefined);
      }
    },
    [props.computerUseClient, props.threadId],
  );

  useEffect(() => {
    if (props.enabled === false) {
      activityGeneration.current += 1;
      browserSignature.current = "";
      setBrowserSnapshot(undefined);
      setComputerSession(undefined);
      return;
    }
    const controller = new AbortController();
    let browserInFlight = false;
    let computerInFlight = false;
    let unchangedReads = 0;
    let browserDueAt = 0;
    const refreshBrowser = async () => {
      // A page that has not changed is asked about less and less often, down
      // to one look every few seconds, so a still page costs next to nothing.
      if (browserInFlight || Date.now() < browserDueAt) return;
      browserInFlight = true;
      try {
        const changed = await loadBrowser(controller.signal);
        unchangedReads = changed ? 0 : unchangedReads + 1;
      } finally {
        browserInFlight = false;
      }
      browserDueAt =
        Date.now() +
        Math.min(
          Math.max(pollIntervalMs, MAX_UNCHANGED_POLL_MS),
          pollIntervalMs * 2 ** Math.min(unchangedReads, 3),
        );
    };
    const refreshComputer = async () => {
      if (computerInFlight) return;
      computerInFlight = true;
      await loadComputerUse(controller.signal).finally(() => {
        computerInFlight = false;
      });
    };
    // Paused while the window is hidden: a preview nobody can see takes no
    // pictures.
    const stop = scheduleVisibleInterval(
      () => {
        void refreshBrowser();
        void refreshComputer();
      },
      pollIntervalMs,
      { runImmediately: true },
    );
    return () => {
      controller.abort();
      stop();
    };
  }, [loadBrowser, loadComputerUse, pollIntervalMs, props.enabled]);

  const currentBrowserSnapshot =
    props.enabled !== false &&
    browserSnapshot !== undefined &&
    String(browserSnapshot.threadId) === String(props.threadId)
      ? browserSnapshot
      : undefined;
  const currentComputerSession =
    props.enabled !== false &&
    computerSession !== undefined &&
    String(computerSession.threadId) === String(props.threadId)
      ? computerSession
      : undefined;

  const browserSessionIds =
    currentBrowserSnapshot === undefined ? [] : browserActivitySessionIds(currentBrowserSnapshot);
  const browserSessionKey = browserSessionIds.join("\0");
  const announcedBrowserSessionKey = useRef("");
  useEffect(() => {
    // The shell owns whether this session has already been offered. This
    // effect only reports a change in the live session set; a remount starts
    // with an empty ref and reports again, which is what lets the window
    // remember a dismissal the pane itself cannot.
    if (browserSessionKey === "" || browserSessionKey === announcedBrowserSessionKey.current) {
      announcedBrowserSessionKey.current = browserSessionKey;
      return;
    }
    announcedBrowserSessionKey.current = browserSessionKey;
    props.onOpenBrowser?.({ sessionIds: browserSessionIds });
  }, [browserSessionIds, browserSessionKey, props.onOpenBrowser]);

  const representedComputerUseSessionId = currentComputerSession?.sessionId;
  useEffect(() => {
    if (representedComputerUseSessionId === undefined) return;
    const threadId = String(props.threadId);
    const sessionId = String(representedComputerUseSessionId);
    props.onComputerUseSessionChange?.(threadId, sessionId, true);
    return () => props.onComputerUseSessionChange?.(threadId, sessionId, false);
  }, [props.onComputerUseSessionChange, props.threadId, representedComputerUseSessionId]);

  const previousComputerSessionId = useRef(currentComputerSession?.sessionId);
  useEffect(() => {
    if (currentComputerSession?.sessionId !== previousComputerSessionId.current) {
      previousComputerSessionId.current = currentComputerSession?.sessionId;
      setCollapsed(false);
    }
  }, [currentComputerSession?.sessionId]);

  async function decideComputerUse(decision: "approved" | "denied") {
    const pending = currentComputerSession?.pendingApproval;
    if (
      pending === undefined ||
      currentComputerSession === undefined ||
      props.computerUseClient === undefined ||
      busy
    ) {
      return;
    }
    activityGeneration.current += 1;
    setBusy(true);
    try {
      const next = await props.computerUseClient.decide({
        sessionId: currentComputerSession.sessionId,
        threadId: currentComputerSession.threadId,
        authority: currentComputerSession.authority,
        actionId: pending.actionId,
        approvalId: pending.approvalId,
        decision,
      });
      setComputerSession(isComputerUseActivity(next) ? next : undefined);
    } catch {
      setComputerSession(undefined);
    } finally {
      setBusy(false);
    }
  }

  async function stopComputerUse() {
    if (currentComputerSession === undefined || props.computerUseClient === undefined || busy)
      return;
    activityGeneration.current += 1;
    setBusy(true);
    try {
      const next = await props.computerUseClient.stop({
        sessionId: currentComputerSession.sessionId,
        threadId: currentComputerSession.threadId,
        authority: currentComputerSession.authority,
      });
      setComputerSession(isComputerUseActivity(next) ? next : undefined);
    } catch {
      setComputerSession(undefined);
    } finally {
      setBusy(false);
    }
  }

  function hideBrowserPreview() {
    if (browserPreviewKey === undefined) return;
    hiddenBrowserPreviews.add(browserPreviewKey);
    setHiddenRevision((revision) => revision + 1);
  }

  const hasComputerUse = currentComputerSession !== undefined;
  const showBrowserPreview =
    currentBrowserSnapshot !== undefined && props.browserVisible !== true && !browserPreviewHidden;

  const computerUsePreview = !hasComputerUse ? null : collapsed ? (
    <>
      <OctantButton
        aria-label="Show Computer Use activity preview"
        className="thread-activity-pip-trigger window-no-drag"
        onClick={() => setCollapsed(false)}
        type="button"
        variant="secondary"
      >
        <span className="thread-activity-pip__pulse" />
        <MonitorUp aria-hidden="true" size={14} strokeWidth={1.7} />
        <span>Computer Use active</span>
        <Eye aria-hidden="true" size={14} strokeWidth={1.7} />
      </OctantButton>
      <div className="thread-activity-pip__collapsed-controls">
        {currentComputerSession.pendingApproval === undefined ? null : (
          <>
            <OctantButton
              disabled={busy}
              onClick={() => void decideComputerUse("approved")}
              size="sm"
              type="button"
            >
              {computerUseApproveLabel(currentComputerSession.pendingApproval)}
            </OctantButton>
            <OctantButton
              disabled={busy}
              onClick={() => void decideComputerUse("denied")}
              size="sm"
              type="button"
              variant="secondary"
            >
              Deny
            </OctantButton>
          </>
        )}
        <OctantButton
          disabled={busy}
          onClick={() => void stopComputerUse()}
          size="sm"
          type="button"
          variant="secondary"
        >
          Stop Computer Use
        </OctantButton>
      </div>
    </>
  ) : (
    <aside
      aria-label="Thread activity preview"
      className="thread-activity-pip"
      data-activity-kind="computer-use"
      data-approval={currentComputerSession.pendingApproval !== undefined ? "pending" : undefined}
    >
      <section
        aria-label="Computer Use activity"
        className="thread-activity-pip__card"
        data-kind="computer-use"
      >
        <ComputerUseActivityPreview
          busy={busy}
          onApprove={() => void decideComputerUse("approved")}
          onDeny={() => void decideComputerUse("denied")}
          session={currentComputerSession}
        />
        {/* Name, status, and controls ride the picture's top edge and show
            under the pointer; a card with nothing to cover keeps them out in
            the open. */}
        <div className="thread-activity-pip__controls">
          <span className="thread-activity-pip__identity">
            {currentComputerSession.pendingApproval === undefined ? (
              <span className="thread-activity-pip__pulse" />
            ) : null}
            <MonitorUp aria-hidden="true" size={14} strokeWidth={1.7} />
            <strong>Computer Use</strong>
            {currentComputerSession.pendingApproval === undefined ? (
              <span>
                {currentComputerSession.state === "waiting-for-approval"
                  ? "Approval needed"
                  : "Live"}
              </span>
            ) : null}
          </span>
          <span className="thread-activity-pip__header-actions">
            <IconButton
              icon={EyeOff}
              label="Hide activity preview"
              onClick={() => setCollapsed(true)}
            />
            <IconButton
              disabled={busy}
              icon={Square}
              label="Stop Computer Use"
              onClick={() => void stopComputerUse()}
            />
          </span>
        </div>
      </section>
    </aside>
  );
  const presentation = useMemo(
    () => ({
      available: hasComputerUse,
      hidden: collapsed,
      setHidden: setCollapsed,
    }),
    [hasComputerUse, collapsed],
  );
  return (
    <ThreadActivityPreviewContext.Provider value={presentation}>
      <div className="thread-activity-frame">
        <div className="thread-activity-frame__content">{props.children}</div>
        {showBrowserPreview ? (
          <BrowserPreviewThumbnail
            onClose={hideBrowserPreview}
            snapshot={currentBrowserSnapshot}
            {...(props.onShowBrowser === undefined ? {} : { onOpen: props.onShowBrowser })}
          />
        ) : null}
        {computerUsePreview}
      </div>
    </ThreadActivityPreviewContext.Provider>
  );
}

function ComputerUseActivityPreview(props: {
  readonly busy: boolean;
  readonly onApprove: () => void;
  readonly onDeny: () => void;
  readonly session: ComputerUseSessionView;
}) {
  if (props.session.pendingApproval !== undefined) {
    return (
      <div className="thread-activity-pip__permission">
        <div className="thread-activity-pip__permission-title">
          <MonitorUp aria-hidden="true" size={16} strokeWidth={1.7} />
          <h3>Allow computer access?</h3>
        </div>
        <p>{props.session.pendingApproval.summary}</p>
        <div className="thread-activity-pip__permission-actions">
          <OctantButton
            disabled={props.busy}
            onClick={props.onDeny}
            size="sm"
            type="button"
            variant="secondary"
          >
            Deny
          </OctantButton>
          <OctantButton disabled={props.busy} onClick={props.onApprove} size="sm" type="button">
            {computerUseApproveLabel(props.session.pendingApproval)}
          </OctantButton>
        </div>
      </div>
    );
  }
  return (
    <div className="thread-activity-pip__visual thread-activity-pip__empty">
      <MonitorUp aria-hidden="true" size={24} strokeWidth={1.5} />
      <strong>{computerUseState(props.session.state)}</strong>
      <span>
        Native pixels stay on the authoritative host; activity and approvals remain visible.
      </span>
    </div>
  );
}

function browserActivitySessionIds(snapshot: BrowserAutomationSnapshot): ReadonlyArray<string> {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (id === "" || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  if (snapshot.context !== undefined) add(String(snapshot.context.contextId));
  if (snapshot.contexts !== undefined) {
    for (const entry of snapshot.contexts) add(String(entry.context.contextId));
  }
  return ids;
}

function isBrowserActivity(snapshot: BrowserAutomationSnapshot): boolean {
  const active = (state: string | undefined) =>
    state === "creating" || state === "active" || state === "stopping" || state === "failed";
  if (snapshot.contexts !== undefined && snapshot.contexts.length > 0) {
    return snapshot.contexts.some((entry) => active(entry.context.state));
  }
  return active(snapshot.context?.state);
}

/**
 * What the preview would draw from a read. Two reads with the same signature
 * are one picture, so the second is not a change and costs no render; the
 * observation's own revision moves on every look and says nothing about the page.
 */
function browserPictureSignature(snapshot: BrowserAutomationSnapshot | undefined): string {
  if (snapshot === undefined) return "none";
  return JSON.stringify([
    snapshot.status,
    snapshot.context?.contextId,
    snapshot.context?.state,
    snapshot.contexts?.length,
    snapshot.observation?.url,
    snapshot.observation?.title,
    snapshot.observation?.stale,
    snapshot.observation?.viewport?.width,
    snapshot.observation?.viewport?.height,
    snapshot.observation?.screenshotDataUrl,
  ]);
}

function isComputerUseActivity(session: ComputerUseSessionView): boolean {
  return (
    session.state === "requesting-approval" ||
    session.state === "active" ||
    session.state === "waiting-for-approval" ||
    session.state === "running" ||
    session.state === "stopping"
  );
}

function computerUseState(state: ComputerUseSessionView["state"]): string {
  return state === "waiting-for-approval" || state === "requesting-approval"
    ? "Approval needed"
    : state === "stopping"
      ? "Computer Use stopping"
      : "Computer Use running";
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}
