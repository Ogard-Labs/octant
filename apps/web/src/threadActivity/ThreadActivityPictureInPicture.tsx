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
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";

type ActivityKind = "browser" | "computer-use";

export interface ThreadActivityPictureInPictureProps {
  readonly browserClient?: BrowserAutomationClient;
  readonly children: ReactNode;
  readonly computerUseClient?: ComputerUseClient;
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
      props.pollIntervalMs ?? 1_000,
      { runImmediately: true },
    );
    return () => {
      controller.abort();
      stop();
    };
  }, [loadBrowser, loadComputerUse, props.pollIntervalMs]);

  const currentBrowserSnapshot =
    browserSnapshot !== undefined && String(browserSnapshot.threadId) === String(props.threadId)
      ? browserSnapshot
      : undefined;
  const currentComputerSession =
    computerSession !== undefined && String(computerSession.threadId) === String(props.threadId)
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
            variant="ghost"
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
          <header className="thread-activity-pip__header">
            <div className="thread-activity-pip__identity">
              <span className="thread-activity-pip__pulse" />
              {activeKind === "browser" ? (
                <Globe2 aria-hidden="true" size={14} strokeWidth={1.7} />
              ) : (
                <MonitorUp aria-hidden="true" size={14} strokeWidth={1.7} />
              )}
              <strong>{activeKind === "browser" ? "Browser" : "Computer Use"}</strong>
              <span>
                {activityStatus(activeKind, currentBrowserSnapshot, currentComputerSession)}
              </span>
            </div>
            <div className="thread-activity-pip__header-actions">
              {activeKind === "browser" && props.onOpenBrowser !== undefined ? (
                <IconButton
                  icon={ExternalLink}
                  label="Open Browser tab"
                  onClick={props.onOpenBrowser}
                />
              ) : null}
              <IconButton
                icon={EyeOff}
                label="Hide activity preview"
                onClick={() => setCollapsed(true)}
              />
            </div>
          </header>

          {availableKinds.length < 2 || activeKind === undefined ? null : (
            <OctantToggleGroup<ActivityKind>
              aria-label="Active tools"
              onValueChange={(value) => {
                const selected = value[0];
                if (selected !== undefined) setSelectedKind(selected);
              }}
              value={[activeKind]}
            >
              <OctantToggleGroupItem value="browser">Browser</OctantToggleGroupItem>
              <OctantToggleGroupItem value="computer-use">Computer Use</OctantToggleGroupItem>
            </OctantToggleGroup>
          )}

          {activeKind === "browser" && currentBrowserSnapshot !== undefined ? (
            <BrowserActivityPreview
              {...(props.onOpenBrowser === undefined ? {} : { onOpenBrowser: props.onOpenBrowser })}
              snapshot={currentBrowserSnapshot}
            />
          ) : activeKind === "computer-use" && currentComputerSession !== undefined ? (
            <ComputerUseActivityPreview
              busy={busy}
              onApprove={() => void decideComputerUse("approved")}
              onDeny={() => void decideComputerUse("denied")}
              session={currentComputerSession}
            />
          ) : null}

          <footer className="thread-activity-pip__footer">
            <span>
              {activeKind === "browser"
                ? (currentBrowserSnapshot?.observation?.url ?? "Thread-owned Browser")
                : latestComputerUseDetail(currentComputerSession)}
            </span>
            <IconButton
              disabled={busy}
              icon={Square}
              label={activeKind === "browser" ? "Stop Browser" : "Stop Computer Use"}
              onClick={() =>
                activeKind === "browser" ? void stopBrowser() : void stopComputerUse()
              }
            />
          </footer>
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
  return (
    <div className="thread-activity-pip__visual thread-activity-pip__empty">
      <Globe2 aria-hidden="true" size={24} strokeWidth={1.5} />
      <strong>{observation?.stale === true ? "Preview is stale" : "Browser is active"}</strong>
      <span>
        {props.snapshot.context?.presentation === "native-live"
          ? "Open the Browser tab for the live native surface."
          : "Waiting for the next safe page snapshot."}
      </span>
    </div>
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

function latestComputerUseDetail(session: ComputerUseSessionView | undefined): string {
  return session?.events.at(-1)?.detail ?? "Host-controlled activity";
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}
