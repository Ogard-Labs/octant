import {
  BrowserAutomationClientFailure,
  type BrowserAutomationClient,
} from "@octant/client-runtime/browser-automation-client";
import type {
  BrowserAutomationSnapshot,
  BrowserThreadScope,
  BrowserWorkspaceStatus,
} from "@octant/contracts/browser-automation-rpc";
import type {
  BrowserActionKind,
  BrowserActionRequest,
  BrowserViewportPoint,
} from "@octant/contracts/browser-automation";
import { MAX_BROWSER_TABS_PER_CONTEXT } from "@octant/contracts/browser-automation";
import type { ToolActionRequest } from "@octant/contracts/tool-actions";
import type { WorkspaceTab } from "@octant/contracts/shell";
import {
  ArrowLeft,
  ArrowRight,
  Globe2,
  ExternalLink,
  LoaderCircle,
  LockKeyhole,
  PanelRight,
  RotateCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { ProductFeedbackPanel } from "./ProductFeedbackPanel";
import { useProductFeedback } from "./useProductFeedback";
import type { OctantHostBridge } from "../shell/hostBridge";
import { useNativeBrowserSurface } from "./useNativeBrowserSurface";

/**
 * Renderer chrome a native page must never be painted over. A native view is a
 * window-level sibling rather than a node in the document, so nothing drawn in
 * React can cover it; while any of these is up the page leaves the window.
 */
export const RENDERER_OVERLAY_SELECTOR = [
  ".code-board-layer",
  ".rail-placeholder",
  ".workspace-drag-preview",
  ".workspace-drop-overlay",
  ".octant-dialog__backdrop",
  ".octant-dialog__viewport",
  ".octant-dialog__popup",
].join(", ");

const BROWSER_REFRESH_INTERVAL_MS = 500;
const BROWSER_MAX_REFRESH_INTERVAL_MS = 5_000;

export interface BrowserWorkspaceProps {
  readonly client: BrowserAutomationClient;
  readonly hostBridge?: OctantHostBridge;
  readonly tab: Extract<WorkspaceTab, { kind: "browser" }>;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  /**
   * Dock this thread's research browser into the focus zone. Absent when this
   * window has no zone to dock into. The dock shows the same thread's browsing
   * context under the same authority; docking moves where the page is shown
   * and changes nothing about what may reach it.
   */
  readonly onDockResearch?: (request: {
    readonly threadId: string;
    readonly mode: "work" | "code";
  }) => void;
}

export function BrowserWorkspace(props: BrowserWorkspaceProps) {
  const [url, setUrl] = useState("https://example.com");
  const [scope, setScope] = useState<BrowserThreadScope>();
  const [snapshot, setSnapshot] = useState<BrowserAutomationSnapshot>();
  const [status, setStatus] = useState<BrowserWorkspaceStatus>(
    props.tab.threadId === undefined ? "unavailable" : "ready",
  );
  const [message, setMessage] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [nativeSupported, setNativeSupported] = useState(false);
  const [remoteFocused, setRemoteFocused] = useState(false);
  // Pointing at the page is a separate gesture from using it: while it is on, a
  // click marks a spot to write about instead of clicking through to the page.
  const [pointing, setPointing] = useState(false);
  const [pendingPoint, setPendingPoint] = useState<BrowserViewportPoint>();
  const feedback = useProductFeedback({
    threadId: props.tab.threadId === undefined ? undefined : String(props.tab.threadId),
    mode: "code",
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  const startInFlight = useRef(false);
  const localFailure = useRef(false);
  const localFailureRevision = useRef<string | undefined>(undefined);
  const currentSnapshotRevision = useRef<string | undefined>(undefined);
  const lastPolledRevision = useRef<string | undefined>(undefined);
  const unchangedPolls = useRef(0);
  const currentObservationRevision =
    useRef<BrowserActionRequest["expectedObservationRevision"]>(undefined);
  const remoteActionTail = useRef<Promise<void>>(Promise.resolve());
  const activeContext = snapshot?.context?.state === "active";
  const nativeContext = nativeSupported && snapshot?.context?.presentation !== "headless";
  const nativeSurface = useNativeBrowserSurface({
    ...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge }),
    ...(snapshot?.context?.contextId === undefined
      ? {}
      : { contextId: String(snapshot.context.contextId) }),
    ...(props.tab.threadId === undefined ? {} : { threadId: String(props.tab.threadId) }),
    enabled: nativeContext && activeContext,
    overlaySelector: RENDERER_OVERLAY_SELECTOR,
  });
  const nativeState = nativeSurface.state;

  const committedAddress = activeContext
    ? ((nativeContext ? nativeState?.url : undefined) ?? snapshot?.observation?.url)
    : undefined;
  const secureAddress = committedAddress?.toLocaleLowerCase().startsWith("https:") === true;
  const addressSecurityLabel =
    committedAddress === undefined ? "Address" : secureAddress ? "Secure HTTPS" : "Not secure HTTP";
  const controlLabel = !nativeContext
    ? snapshot?.observation?.revision === undefined
      ? "Headless preview"
      : "Interactive preview"
    : nativeSurface.failed
      ? "Live page unavailable"
      : nativeState?.control === "agent"
        ? "Agent active"
        : nativeState?.control === "user"
          ? "You control"
          : "Shared live page";

  useEffect(() => {
    let active = true;
    void Promise.resolve(props.hostBridge?.getHostCapabilities?.()).then((capabilities) => {
      if (active) setNativeSupported(capabilities?.liveBrowserSupported === true);
    });
    return () => {
      active = false;
    };
  }, [props.hostBridge]);

  useEffect(() => {
    if (nativeState?.url) setUrl(nativeState.url);
  }, [nativeState?.url]);

  useEffect(() => {
    if (nativeState?.url === undefined && snapshot?.observation?.url) {
      setUrl(snapshot.observation.url);
    }
  }, [nativeState?.url, snapshot?.observation?.url]);

  useEffect(() => {
    if (props.tab.threadId === undefined) return;
    const controller = new AbortController();
    let active = true;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setStatus("waiting");
    const refresh = async () => {
      let nextDelay = BROWSER_REFRESH_INTERVAL_MS;
      try {
        // A tab opened for one host-owned context shows that context and no
        // other: asking for the thread's current context instead
        // would move this tab onto whatever was opened last.
        const next =
          props.tab.contextId === undefined
            ? await props.client.inspectThread({ threadId: props.tab.threadId! }, controller.signal)
            : await props.client.inspect(
                { contextId: props.tab.contextId, threadId: props.tab.threadId! },
                controller.signal,
              );
        if (!active || controller.signal.aborted) return;
        const revision = snapshotRevision(next);
        const changed = revision !== lastPolledRevision.current;
        lastPolledRevision.current = revision;
        unchangedPolls.current = changed ? 0 : unchangedPolls.current + 1;
        nextDelay = browserRefreshDelay(unchangedPolls.current);
        if (changed) {
          currentSnapshotRevision.current = revision;
          currentObservationRevision.current = next.observation?.revision;
          setSnapshot(next);
          setScope(
            next.context === undefined
              ? undefined
              : { threadId: next.threadId, authority: next.context.authority },
          );
        }
        const recovered =
          localFailure.current &&
          next.failure === undefined &&
          revision !== localFailureRevision.current;
        if (!localFailure.current || recovered) {
          if (recovered) {
            localFailure.current = false;
            localFailureRevision.current = undefined;
          }
          setStatus(next.status);
          setMessage(next.failure?.message);
        }
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        applyFailure(error, setStatus, setMessage);
      } finally {
        if (active && !controller.signal.aborted) {
          refreshTimer = setTimeout(() => void refresh(), nextDelay);
        }
      }
    };
    void refresh();
    return () => {
      active = false;
      controller.abort();
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    };
  }, [props.client, props.tab.contextId, props.tab.threadId]);

  if (props.tab.threadId === undefined) {
    return (
      <section
        aria-label="Browser automation"
        className="browser-workspace browser-workspace--state"
      >
        <p className="browser-workspace__eyebrow">Browser unavailable</p>
        <h2>Open Browser from a Work or Code thread</h2>
        <p>The host requires one exact owning thread before it can create an isolated context.</p>
      </section>
    );
  }

  async function start(): Promise<void> {
    if (startInFlight.current) return;
    startInFlight.current = true;
    localFailure.current = false;
    setStarting(true);
    setStatus("waiting");
    setMessage(undefined);
    try {
      const targetUrl = validTargetUrl(url);
      if (targetUrl === undefined) return;
      const origin = new URL(targetUrl).origin;
      setUrl(targetUrl);
      const resolved = await props.client.resolve({
        threadId: props.tab.threadId!,
        mode: props.tab.mode,
      });
      const action = makeAction(resolved);
      const next = await props.client.create({
        threadId: props.tab.threadId!,
        action,
        policy: {
          profileMode: "isolated",
          allowedOrigins: [origin],
          credentialFieldProtection: true,
          maxConcurrentTabs: MAX_BROWSER_TABS_PER_CONTEXT,
          sessionTimeoutMs: 300_000,
        },
      });
      setScope(resolved);
      update(next);
      if (next.context !== undefined) {
        if (next.context.state === "active") {
          const navigated = await props.client.act({
            actionId: next.context.actionId,
            contextId: next.context.contextId,
            correlationId: next.context.correlationId,
            authority: resolved.authority,
            kind: "navigate",
            target: targetUrl,
          });
          update(navigated);
        }
      }
    } catch (error) {
      localFailure.current = true;
      localFailureRevision.current = currentSnapshotRevision.current ?? snapshotRevision(snapshot);
      applyFailure(error, setStatus, setMessage);
    } finally {
      startInFlight.current = false;
      setStarting(false);
    }
  }

  async function act(
    kind: BrowserActionKind,
    input: Partial<
      Pick<
        BrowserActionRequest,
        "target" | "value" | "point" | "deltaX" | "deltaY" | "expectedObservationRevision"
      >
    > = {},
  ): Promise<void> {
    if (snapshot?.context === undefined || scope === undefined) return;
    localFailure.current = false;
    setStatus("waiting");
    setMessage(undefined);
    try {
      const next = await props.client.act({
        actionId: snapshot.context.actionId,
        contextId: snapshot.context.contextId,
        correlationId: snapshot.context.correlationId,
        authority: scope.authority,
        kind,
        ...input,
        ...(kind === "navigate" ? { target: input.target ?? normalizeBrowserUrl(url) } : {}),
      });
      update(next);
    } catch (error) {
      localFailure.current = true;
      localFailureRevision.current = currentSnapshotRevision.current ?? snapshotRevision(snapshot);
      applyFailure(error, setStatus, setMessage);
    }
  }

  async function stop(cancel: boolean): Promise<void> {
    if (snapshot?.context === undefined) return;
    localFailure.current = false;
    setStatus("waiting");
    try {
      const next = cancel
        ? await props.client.cancel({
            contextId: snapshot.context.contextId,
            threadId: props.tab.threadId!,
            cancellation: {
              actionId: snapshot.context.actionId,
              correlationId: snapshot.context.correlationId,
              authority: snapshot.context.authority,
              reason: "user-requested",
            },
          })
        : await props.client.stop({
            contextId: snapshot.context.contextId,
            threadId: props.tab.threadId!,
          });
      update(next);
    } catch (error) {
      localFailure.current = true;
      localFailureRevision.current = currentSnapshotRevision.current ?? snapshotRevision(snapshot);
      applyFailure(error, setStatus, setMessage);
    }
  }

  function update(next: BrowserAutomationSnapshot): void {
    localFailure.current = next.failure !== undefined;
    currentSnapshotRevision.current = snapshotRevision(next);
    currentObservationRevision.current = next.observation?.revision;
    localFailureRevision.current =
      next.failure === undefined ? undefined : currentSnapshotRevision.current;
    unchangedPolls.current = 0;
    setSnapshot(next);
    setStatus(next.status);
    setMessage(next.failure?.message);
  }

  function queueRemoteAction(
    kind: "click" | "type" | "press" | "scroll",
    input: Partial<Pick<BrowserActionRequest, "value" | "point" | "deltaX" | "deltaY">>,
  ): void {
    if (currentObservationRevision.current === undefined) return;
    remoteActionTail.current = remoteActionTail.current
      .catch(() => undefined)
      .then(() =>
        act(kind, {
          ...input,
          expectedObservationRevision: currentObservationRevision.current!,
        }),
      );
  }

  async function navigate(): Promise<void> {
    if (!activeContext) {
      await start();
      return;
    }
    const target = validTargetUrl(url);
    if (target === undefined) return;
    const targetOrigin = new URL(target).origin;
    const allowed = snapshot?.context?.policy.allowedOrigins.some(
      (origin) => new URL(normalizeBrowserUrl(origin)).origin === targetOrigin,
    );
    if (allowed) {
      await act("navigate");
      return;
    }
    await stop(false);
    await start();
  }

  function nativeCommand(command: "back" | "forward" | "reload" | "stop"): void {
    if (snapshot?.context === undefined || props.hostBridge?.commandBrowserSurface === undefined)
      return;
    void props.hostBridge
      .commandBrowserSurface({
        contextId: snapshot.context.contextId,
        threadId: props.tab.threadId!,
        command,
      })
      .catch(() => undefined);
  }

  function validTargetUrl(value: string): string | undefined {
    try {
      return normalizeBrowserUrl(value);
    } catch {
      localFailure.current = true;
      setStatus("failed");
      setMessage("Enter a valid HTTP or HTTPS address.");
      return undefined;
    }
  }

  return (
    <section
      aria-label="Browser automation"
      className={`browser-workspace${message === undefined ? "" : " browser-workspace--message"}`}
    >
      <header className="browser-workspace__chrome">
        <div className="browser-workspace__history" aria-label="Browser history controls">
          <OctantButton
            aria-label="Back"
            className="browser-workspace__history-button"
            disabled={!nativeContext || !nativeState?.canGoBack}
            onClick={() => nativeCommand("back")}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ArrowLeft aria-hidden="true" size={14} />
          </OctantButton>
          <OctantButton
            aria-label="Forward"
            className="browser-workspace__history-button"
            disabled={!nativeContext || !nativeState?.canGoForward}
            onClick={() => nativeCommand("forward")}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ArrowRight aria-hidden="true" size={14} />
          </OctantButton>
          <OctantButton
            aria-label={nativeState?.loading ? "Stop loading" : "Reload"}
            className="browser-workspace__history-button"
            disabled={!activeContext}
            onClick={() => {
              if (nativeContext) {
                nativeCommand(nativeState?.loading ? "stop" : "reload");
              } else if (!nativeState?.loading) {
                // Reload must use the committed page, not an unsubmitted omnibox draft.
                const target = committedAddress ?? validTargetUrl(url);
                if (target !== undefined) {
                  void act("navigate", { target });
                }
              }
            }}
            size="icon"
            type="button"
            variant="ghost"
          >
            {nativeState?.loading ? (
              <X aria-hidden="true" size={14} />
            ) : (
              <RotateCw aria-hidden="true" size={14} />
            )}
          </OctantButton>
        </div>
        <form
          className="browser-workspace__omnibox"
          onSubmit={(event) => {
            event.preventDefault();
            void navigate();
          }}
        >
          <span
            aria-label={addressSecurityLabel}
            className="browser-workspace__security"
            title={
              committedAddress === undefined
                ? "Enter an HTTP or HTTPS address"
                : secureAddress
                  ? "Secure HTTPS connection"
                  : "HTTP connection is not secure"
            }
          >
            {secureAddress ? (
              <LockKeyhole aria-hidden="true" size={12} />
            ) : (
              <Globe2 aria-hidden="true" size={12} />
            )}
          </span>
          <OctantInput
            aria-label="Browser URL"
            onChange={(event) => setUrl(event.target.value)}
            spellCheck={false}
            type="text"
            value={url}
          />
        </form>
        <span
          className="browser-workspace__control-state"
          title={
            nativeContext
              ? "You and the agent share this live Chromium page."
              : "Click, type, and scroll this headless page through the shared Browser context."
          }
        >
          {nativeState?.loading || nativeState?.control === "agent" ? (
            <LoaderCircle aria-hidden="true" size={12} />
          ) : null}
          {controlLabel}
        </span>
        {activeContext ? (
          props.hostBridge?.openBrowserExternal === undefined ? null : (
            <OctantButton
              aria-label="Open in default browser"
              className="browser-workspace__close"
              onClick={() => {
                const target = validTargetUrl(committedAddress ?? url);
                if (target !== undefined) void props.hostBridge!.openBrowserExternal!(target);
              }}
              size="icon"
              title="Open in default browser"
              type="button"
              variant="ghost"
            >
              <ExternalLink aria-hidden="true" size={13} />
            </OctantButton>
          )
        ) : null}
        {props.onDockResearch === undefined || props.tab.threadId === undefined ? null : (
          <OctantButton
            aria-label="Dock in the focus zone"
            className="browser-workspace__close"
            onClick={() =>
              props.onDockResearch?.({
                threadId: String(props.tab.threadId),
                mode: props.tab.mode,
              })
            }
            size="icon"
            title="Dock in the focus zone"
            type="button"
            variant="ghost"
          >
            <PanelRight aria-hidden="true" size={13} />
          </OctantButton>
        )}
        {activeContext ? (
          <OctantButton
            aria-label="Stop"
            className="browser-workspace__close"
            onClick={() => void stop(false)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" size={14} />
          </OctantButton>
        ) : null}
        <span aria-live="polite" className="sr-only">
          <span>{statusLabel(status)}</span>
          {snapshot?.observation?.title === undefined ? null : (
            <span>{snapshot.observation.title}</span>
          )}
        </span>
      </header>
      {message === undefined ? null : (
        <p className="browser-workspace__message" role="alert">
          {message}
        </p>
      )}
      {!activeContext ? (
        <div className="browser-workspace__empty">
          <ShieldCheck aria-hidden="true" size={20} />
          <h2>Open a private Browser session</h2>
          <p>The page is isolated to this thread and shared with its agent.</p>
          <OctantButton
            aria-label="Start browser"
            disabled={starting}
            onClick={() => void start()}
            type="button"
          >
            {starting ? "Starting…" : "Open page"}
          </OctantButton>
        </div>
      ) : nativeContext ? (
        <div
          aria-label="Live Chromium page"
          className="browser-workspace__native"
          ref={nativeSurface.mount}
        >
          {nativeSurface.failed ? (
            <div className="browser-workspace__native-error" role="alert">
              <p>The live Chromium page could not attach to this pane.</p>
              <OctantButton onClick={nativeSurface.retry} type="button" variant="secondary">
                Retry
              </OctantButton>
            </div>
          ) : null}
        </div>
      ) : (
        <article
          aria-label="Interactive headless Browser preview"
          className={`browser-workspace__remote${remoteFocused ? " browser-workspace__remote--focused" : ""}`}
          onBlur={() => setRemoteFocused(false)}
          onFocus={() => setRemoteFocused(true)}
          onKeyDown={(event) => {
            if (!remoteFocused || event.metaKey || event.ctrlKey || event.altKey) return;
            if (event.key.length === 1) {
              event.preventDefault();
              queueRemoteAction("type", { value: event.key });
              return;
            }
            const key = event.shiftKey && event.key === "Tab" ? "Shift+Tab" : event.key;
            if (!SUPPORTED_REMOTE_KEYS.has(key)) return;
            event.preventDefault();
            queueRemoteAction("press", { value: key });
          }}
          onWheel={(event) => {
            event.preventDefault();
            queueRemoteAction("scroll", {
              deltaX: boundedWheelDelta(event.deltaX),
              deltaY: boundedWheelDelta(event.deltaY),
            });
          }}
          role="application"
          tabIndex={0}
        >
          {snapshot?.observation?.screenshotDataUrl === undefined ? (
            <div className="browser-workspace__remote-empty">
              <p>Waiting for the host to capture this page.</p>
              <OctantButton
                onClick={() => void act("screenshot")}
                type="button"
                variant="secondary"
              >
                Refresh preview
              </OctantButton>
            </div>
          ) : (
            <img
              alt={`${snapshot.observation.title ?? "Current page"} browser preview`}
              className="browser-workspace__preview"
              draggable={false}
              onClick={(event) => {
                const point = previewPoint(event.currentTarget, event.clientX, event.clientY);
                if (point === undefined) return;
                if (pointing) {
                  // Marking a spot never touches the page: the host is asked
                  // what is there only once the user has written the note.
                  setPendingPoint(point);
                  return;
                }
                event.currentTarget.parentElement?.focus();
                queueRemoteAction("click", { point });
              }}
              src={snapshot.observation.screenshotDataUrl}
            />
          )}
        </article>
      )}
      {!feedback.available || snapshot?.context === undefined ? null : (
        <ProductFeedbackPanel
          busy={feedback.busy}
          {...(feedback.message === undefined ? {} : { message: feedback.message })}
          onCancel={() => setPendingPoint(undefined)}
          onDiscard={(note) => void feedback.discard(note)}
          onSubmit={(comment) => {
            const point = pendingPoint;
            const contextId = snapshot.context?.contextId;
            if (point === undefined || contextId === undefined) return;
            void (async () => {
              const captured = await feedback.capture({
                contextId: String(contextId),
                point,
                comment,
              });
              if (captured) {
                setPendingPoint(undefined);
                setPointing(false);
              }
            })();
          }}
          onTogglePointing={() => {
            setPointing((current) => !current);
            setPendingPoint(undefined);
          }}
          pending={feedback.pending}
          {...(pendingPoint === undefined ? {} : { pendingPoint })}
          pointing={pointing}
        />
      )}
    </section>
  );
}

const SUPPORTED_REMOTE_KEYS = new Set([
  "Enter",
  "Tab",
  "Shift+Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

function previewPoint(
  image: HTMLImageElement,
  clientX: number,
  clientY: number,
): BrowserViewportPoint | undefined {
  const rect = image.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return undefined;
  }
  const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
  const contentWidth = image.naturalWidth * scale;
  const contentHeight = image.naturalHeight * scale;
  const offsetX = (rect.width - contentWidth) / 2;
  const offsetY = 0;
  const x = clientX - rect.left - offsetX;
  const y = clientY - rect.top - offsetY;
  if (x < 0 || y < 0 || x > contentWidth || y > contentHeight) return undefined;
  return { x: x / contentWidth, y: y / contentHeight } as BrowserViewportPoint;
}

function boundedWheelDelta(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-2000, Math.min(2000, Math.round(value)));
}

export function normalizeBrowserUrl(value: string): string {
  const trimmed = value.trim();
  const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Browser supports HTTP and HTTPS addresses only.");
  }
  return url.toString();
}

function snapshotRevision(snapshot: BrowserAutomationSnapshot | undefined): string {
  if (snapshot === undefined) return "none";
  return JSON.stringify([
    snapshot.status,
    snapshot.context?.contextId,
    snapshot.context?.state,
    snapshot.context?.presentation,
    snapshot.observation?.revision,
    snapshot.observation?.observedAt,
    snapshot.observation?.contentHash,
    snapshot.observation?.url,
    snapshot.evidence.length,
    snapshot.failure?.category,
    snapshot.failure?.message,
  ]);
}

function browserRefreshDelay(unchangedCount: number): number {
  return Math.min(
    BROWSER_MAX_REFRESH_INTERVAL_MS,
    BROWSER_REFRESH_INTERVAL_MS * 2 ** Math.min(unchangedCount, 4),
  );
}

function makeAction(scope: BrowserThreadScope): ToolActionRequest {
  return makeBrowserToolAction(scope, "Open and operate one host-owned isolated browser context.");
}

/** One tool-action envelope for a host-owned Browser request under `scope`. */
export function makeBrowserToolAction(
  scope: BrowserThreadScope,
  intent: string,
): ToolActionRequest {
  return {
    actionId: crypto.randomUUID() as ToolActionRequest["actionId"],
    correlationId: crypto.randomUUID() as ToolActionRequest["correlationId"],
    capability: { id: "browser-automation" as ToolActionRequest["capability"]["id"], version: 1 },
    authority: scope.authority,
    intent,
    approval: { kind: "not-required" },
  };
}

function statusLabel(status: BrowserWorkspaceStatus): string {
  return `Browser ${status}`;
}

function applyFailure(
  error: unknown,
  setStatus: (status: BrowserWorkspaceStatus) => void,
  setMessage: (message: string | undefined) => void,
): void {
  if (error instanceof BrowserAutomationClientFailure) {
    setStatus(
      error.category === "interrupted"
        ? "interrupted"
        : error.category === "unavailable"
          ? "unavailable"
          : error.category === "stale"
            ? "stale"
            : "failed",
    );
    setMessage(error.message);
    return;
  }
  setStatus("failed");
  setMessage("Browser automation failed closed.");
}
