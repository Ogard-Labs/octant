import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { ComputerUseClient } from "@octant/client-runtime/computer-use-client";
import type { BrowserThreadId } from "@octant/contracts/browser-automation";
import type { BrowserAutomationSnapshot } from "@octant/contracts/browser-automation-rpc";
import type { ComputerUseSessionView } from "@octant/contracts/computer-use";
import { ExternalLink, Eye, EyeOff, Globe2, MonitorUp, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { IconButton } from "../shell/IconButton";
import { OctantButton } from "../ui/base/OctantButton";

type ActivityKind = "browser" | "computer-use";

export interface ThreadActivityPictureInPictureProps {
  readonly browserClient?: BrowserAutomationClient;
  readonly children: ReactNode;
  readonly computerUseClient?: ComputerUseClient;
  readonly enabled?: boolean;
  readonly onComputerUseSessionChange?: (
    threadId: string,
    sessionId: string,
    represented: boolean,
  ) => void;
  readonly onOpenBrowser?: () => void;
  readonly pollIntervalMs?: number;
  readonly threadId: BrowserThreadId;
}

/**
 * Display-only companion for a thread-owned Browser or Computer Use session.
 * It never creates or rebinds authority: every action goes back through the
 * existing exact-thread clients.
 */
export function ThreadActivityPictureInPicture(props: ThreadActivityPictureInPictureProps) {
  const [browserSnapshot, setBrowserSnapshot] = useState<BrowserAutomationSnapshot>();
  const [computerSession, setComputerSession] = useState<ComputerUseSessionView>();
  const [collapsed, setCollapsed] = useState(false);
  const [selectedKind, setSelectedKind] = useState<ActivityKind>();
  const [busy, setBusy] = useState(false);
  const activityGeneration = useRef(0);
  const hasPolledActivity =
    (browserSnapshot !== undefined && isBrowserActivity(browserSnapshot)) ||
    (computerSession !== undefined && isComputerUseActivity(computerSession));
  const pollIntervalMs = props.pollIntervalMs ?? (hasPolledActivity ? 1_000 : 5_000);

  const loadBrowser = useCallback(
    async (signal?: AbortSignal) => {
      const generation = activityGeneration.current;
      if (props.browserClient === undefined) {
        setBrowserSnapshot(undefined);
        return;
      }
      try {
        const next = await props.browserClient.inspectThread({ threadId: props.threadId }, signal);
        if (signal?.aborted === true || generation !== activityGeneration.current) return;
        if (String(next.threadId) !== String(props.threadId)) {
          setBrowserSnapshot(undefined);
          return;
        }
        setBrowserSnapshot(isBrowserActivity(next) ? next : undefined);
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) return;
        if (generation !== activityGeneration.current) return;
        setBrowserSnapshot(undefined);
      }
    },
    [props.browserClient, props.threadId],
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
      setBrowserSnapshot(undefined);
      setComputerSession(undefined);
      return;
    }
    const controller = new AbortController();
    let browserInFlight = false;
    let computerInFlight = false;
    const refreshBrowser = async () => {
      if (browserInFlight) return;
      browserInFlight = true;
      await loadBrowser(controller.signal).finally(() => {
        browserInFlight = false;
      });
    };
    const refreshComputer = async () => {
      if (computerInFlight) return;
      computerInFlight = true;
      await loadComputerUse(controller.signal).finally(() => {
        computerInFlight = false;
      });
    };
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

  const representedComputerUseSessionId = currentComputerSession?.sessionId;
  useEffect(() => {
    if (representedComputerUseSessionId === undefined) return;
    const threadId = String(props.threadId);
    const sessionId = String(representedComputerUseSessionId);
    props.onComputerUseSessionChange?.(threadId, sessionId, true);
    return () => props.onComputerUseSessionChange?.(threadId, sessionId, false);
  }, [props.onComputerUseSessionChange, props.threadId, representedComputerUseSessionId]);

  const availableKinds = useMemo(() => {
    const kinds: ActivityKind[] = [];
    if (currentBrowserSnapshot !== undefined) kinds.push("browser");
    if (currentComputerSession !== undefined) kinds.push("computer-use");
    return kinds;
  }, [currentBrowserSnapshot, currentComputerSession]);

  const activityKey = `${currentBrowserSnapshot?.context?.contextId ?? ""}:${
    currentComputerSession?.sessionId ?? ""
  }`;
  const previousActivityKey = useRef(activityKey);
  useEffect(() => {
    if (activityKey !== previousActivityKey.current) {
      previousActivityKey.current = activityKey;
      setCollapsed(false);
    }
  }, [activityKey]);

  const activeKind = availableKinds.includes(selectedKind ?? "browser")
    ? (selectedKind ?? "browser")
    : currentComputerSession?.pendingApproval !== undefined
      ? "computer-use"
      : availableKinds[0];

  useEffect(() => {
    if (currentComputerSession?.pendingApproval !== undefined) setSelectedKind("computer-use");
  }, [currentComputerSession?.pendingApproval]);

  async function stopBrowser() {
    const context = currentBrowserSnapshot?.context;
    if (context === undefined || props.browserClient === undefined || busy) return;
    activityGeneration.current += 1;
    setBusy(true);
    try {
      const next = await props.browserClient.stop({
        contextId: context.contextId,
        threadId: props.threadId,
      });
      setBrowserSnapshot(isBrowserActivity(next) ? next : undefined);
    } catch {
      setBrowserSnapshot(undefined);
    } finally {
      setBusy(false);
    }
  }

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

  const hasActivity = activeKind !== undefined;
  const collapsedLabel =
    availableKinds.length > 1
      ? `${availableKinds.length} activities`
      : activeKind === "browser"
        ? "Browser"
        : "Computer Use";

  return (
    <div className="thread-activity-frame">
      <div className="thread-activity-frame__content">{props.children}</div>
      {!hasActivity ? null : collapsed ? (
        <>
          <OctantButton
            aria-label={`Show ${collapsedLabel} activity preview`}
            className="thread-activity-pip-trigger window-no-drag"
            onClick={() => setCollapsed(false)}
            type="button"
            variant="secondary"
          >
            <span className="thread-activity-pip__pulse" />
            {activeKind === "browser" ? (
              <Globe2 aria-hidden="true" size={14} strokeWidth={1.7} />
            ) : (
              <MonitorUp aria-hidden="true" size={14} strokeWidth={1.7} />
            )}
            <span>{collapsedLabel} active</span>
            <Eye aria-hidden="true" size={14} strokeWidth={1.7} />
          </OctantButton>
          {activeKind === "computer-use" && currentComputerSession !== undefined ? (
            <div className="thread-activity-pip__collapsed-controls">
              {currentComputerSession.pendingApproval === undefined ? null : (
                <>
                  <OctantButton
                    disabled={busy}
                    onClick={() => void decideComputerUse("approved")}
                    size="sm"
                    type="button"
                  >
                    Approve once
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
          ) : null}
        </>
      ) : (
        <aside
          aria-label="Thread activity preview"
          className="thread-activity-pip"
          data-activity-kind={activeKind}
        >
          {/* The preview is the pictures, stacked, and nothing else at rest:
              each card's name, status, and controls sit over its top edge and
              show under the pointer. A card without a picture keeps them out
              in the open, since there is nothing for them to cover. */}
          {currentBrowserSnapshot === undefined ? null : (
            <section
              aria-label="Browser activity"
              className="thread-activity-pip__card"
              data-kind="browser"
            >
              <BrowserActivityPreview
                {...(props.onOpenBrowser === undefined
                  ? {}
                  : { onOpenBrowser: props.onOpenBrowser })}
                snapshot={currentBrowserSnapshot}
              />
              <div className="thread-activity-pip__controls">
                <span className="thread-activity-pip__identity">
                  <span className="thread-activity-pip__pulse" />
                  <Globe2 aria-hidden="true" size={14} strokeWidth={1.7} />
                  <strong>Browser</strong>
                  <span>
                    {activityStatus("browser", currentBrowserSnapshot, currentComputerSession)}
                  </span>
                </span>
                <span className="thread-activity-pip__header-actions">
                  {props.onOpenBrowser === undefined ? null : (
                    <IconButton
                      icon={ExternalLink}
                      label="Open Browser tab"
                      onClick={props.onOpenBrowser}
                    />
                  )}
                  <IconButton
                    icon={EyeOff}
                    label="Hide activity preview"
                    onClick={() => setCollapsed(true)}
                  />
                  <IconButton
                    disabled={busy}
                    icon={Square}
                    label="Stop Browser"
                    onClick={() => void stopBrowser()}
                  />
                </span>
              </div>
            </section>
          )}
          {currentComputerSession === undefined ? null : (
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
              <div className="thread-activity-pip__controls">
                <span className="thread-activity-pip__identity">
                  <span className="thread-activity-pip__pulse" />
                  <MonitorUp aria-hidden="true" size={14} strokeWidth={1.7} />
                  <strong>Computer Use</strong>
                  <span>
                    {activityStatus("computer-use", currentBrowserSnapshot, currentComputerSession)}
                  </span>
                </span>
                <span className="thread-activity-pip__header-actions">
                  {currentBrowserSnapshot === undefined ? (
                    <IconButton
                      icon={EyeOff}
                      label="Hide activity preview"
                      onClick={() => setCollapsed(true)}
                    />
                  ) : null}
                  <IconButton
                    disabled={busy}
                    icon={Square}
                    label="Stop Computer Use"
                    onClick={() => void stopComputerUse()}
                  />
                </span>
              </div>
            </section>
          )}
        </aside>
      )}
    </div>
  );
}

function BrowserActivityPreview(props: {
  readonly onOpenBrowser?: () => void;
  readonly snapshot: BrowserAutomationSnapshot;
}) {
  const observation = props.snapshot.observation;
  const screenshot = observation?.stale === false ? observation.screenshotDataUrl : undefined;
  const title = observation?.title ?? "Browser";
  if (screenshot !== undefined) {
    return (
      <OctantButton
        aria-label="Open Browser from preview"
        className="thread-activity-pip__visual thread-activity-pip__visual--interactive"
        disabled={props.onOpenBrowser === undefined}
        onClick={props.onOpenBrowser}
        type="button"
        variant="ghost"
      >
        <img alt={`${title} browser activity`} src={screenshot} />
      </OctantButton>
    );
  }
  // Without a picture there is nothing to frame: a box holding an icon and
  // two sentences was the preview's whole height with nothing previewed. One
  // line says where the page is, and the header already offers the way there.
  return (
    <p className="thread-activity-pip__note">
      {props.snapshot.context?.presentation === "native-live"
        ? "Live in the Browser tab."
        : observation?.stale === true
          ? "Preview is stale; waiting for the next page snapshot."
          : "Waiting for the next page snapshot."}
    </p>
  );
}

function ComputerUseActivityPreview(props: {
  readonly busy: boolean;
  readonly onApprove: () => void;
  readonly onDeny: () => void;
  readonly session: ComputerUseSessionView;
}) {
  return (
    <div className="thread-activity-pip__visual thread-activity-pip__empty">
      <MonitorUp aria-hidden="true" size={24} strokeWidth={1.5} />
      <strong>{computerUseState(props.session.state)}</strong>
      <span>
        {props.session.pendingApproval?.summary ??
          "Native pixels stay on the authoritative host; activity and approvals remain visible."}
      </span>
      {props.session.pendingApproval === undefined ? null : (
        <div className="thread-activity-pip__approval">
          <OctantButton disabled={props.busy} onClick={props.onApprove} size="sm" type="button">
            Approve once
          </OctantButton>
          <OctantButton
            disabled={props.busy}
            onClick={props.onDeny}
            size="sm"
            type="button"
            variant="secondary"
          >
            Deny
          </OctantButton>
        </div>
      )}
    </div>
  );
}

function isBrowserActivity(snapshot: BrowserAutomationSnapshot): boolean {
  const state = snapshot.context?.state;
  return state === "creating" || state === "active" || state === "stopping" || state === "failed";
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

function activityStatus(
  kind: ActivityKind,
  browser: BrowserAutomationSnapshot | undefined,
  computer: ComputerUseSessionView | undefined,
): string {
  if (kind === "browser") {
    if (browser?.observation?.stale === true) return "Stale";
    if (browser?.status === "failed") return "Needs attention";
    return browser?.context?.state === "stopping" ? "Stopping" : "Live";
  }
  return computer?.state === "waiting-for-approval" ? "Approval needed" : "Live";
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
