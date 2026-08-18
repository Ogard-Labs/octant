import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { BrowserAutomationSnapshot } from "@octant/contracts/browser-automation-rpc";
import { decodeBrowserThreadId } from "@octant/contracts/browser-automation";
import { MAX_BROWSER_TABS_PER_CONTEXT } from "@octant/contracts/browser-automation";
import type { ZenResearchDock as ZenResearchDockBinding } from "@octant/contracts/zen";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  LoaderCircle,
  Plus,
  RotateCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import {
  makeBrowserToolAction,
  normalizeBrowserUrl,
  RENDERER_OVERLAY_SELECTOR,
} from "../browser/BrowserWorkspace";
import { useNativeBrowserSurface } from "../browser/useNativeBrowserSurface";
import type { OctantHostBridge } from "../shell/hostBridge";

export interface ZenResearchDockProps {
  readonly client: BrowserAutomationClient;
  readonly hostBridge?: OctantHostBridge;
  /**
   * The dock as the space holds it. The bound source context is the thread the
   * page belongs to; the dock shows that thread's browsing context and works
   * under its authority, never the space's.
   */
  readonly dock: ZenResearchDockBinding;
  readonly onCollapse: (collapsed: boolean) => void;
  readonly onUndock: () => void;
}

/**
 * A research browser docked to the edge of a focus zone space.
 *
 * Docked rather than pinned to the canvas: the page is a live native view the
 * host places by absolute window bounds, and the canvas draws its cards under
 * a CSS transform, so a page arranged among them would be positioned by the
 * canvas's last pan rather than by where it appears. Everything here — rail,
 * address, page — lives outside that transform.
 *
 * Its tabs are real pages of one browsing context, opened by the host, so they
 * share that context's session: a sign-in in one is a sign-in in the next, as
 * it is in any browser profile. Opening a tab and following a link are the
 * person's own actions and reach the page through the host's navigation
 * admission; neither adds anything the agent may act on.
 */
export function ZenResearchDock(props: ZenResearchDockProps) {
  const [address, setAddress] = useState("https://example.com");
  const [snapshot, setSnapshot] = useState<BrowserAutomationSnapshot>();
  const [message, setMessage] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [nativeSupported, setNativeSupported] = useState(false);
  const context = snapshot?.context;
  const active = context?.state === "active";
  const threadId = String(props.dock.sourceContext.threadId);
  // The dock holds the thread as the source context names it; the browsing
  // context names the same thread under its own brand. Decoding rather than
  // casting keeps that one identity honest at the seam.
  const browserThreadId = decodeBrowserThreadId(threadId);
  useEffect(() => {
    let active = true;
    void Promise.resolve(props.hostBridge?.getHostCapabilities?.()).then((capabilities) => {
      if (active) setNativeSupported(capabilities?.liveBrowserSupported === true);
    });
    return () => {
      active = false;
    };
  }, [props.hostBridge]);
  const surface = useNativeBrowserSurface({
    ...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge }),
    ...(context === undefined ? {} : { contextId: String(context.contextId) }),
    threadId,
    enabled: nativeSupported && active && !props.dock.collapsed,
    overlaySelector: RENDERER_OVERLAY_SELECTOR,
  });
  const state = surface.state;
  // A host that reports no tabs is showing exactly one page; the rail says so
  // rather than pretending the context has none.
  const tabs = state?.tabs ?? [];
  const canOpenTab =
    props.hostBridge?.tabBrowserSurface !== undefined && tabs.length < MAX_BROWSER_TABS_PER_CONTEXT;

  async function open(): Promise<void> {
    if (starting) return;
    setStarting(true);
    setMessage(undefined);
    try {
      const target = normalizeBrowserUrl(address);
      setAddress(target);
      const scope = await props.client.resolve({
        threadId: browserThreadId,
        mode: props.dock.sourceContext.threadKind === "work" ? "work" : "code",
      });
      const created = await props.client.create({
        threadId: browserThreadId,
        action: makeBrowserToolAction(scope, "Open a docked research browser for this thread."),
        policy: {
          profileMode: "isolated",
          allowedOrigins: [new URL(target).origin],
          credentialFieldProtection: true,
          maxConcurrentTabs: MAX_BROWSER_TABS_PER_CONTEXT,
          sessionTimeoutMs: 600_000,
        },
      });
      setSnapshot(created);
      if (created.context?.state !== "active") return;
      setSnapshot(
        await props.client.act({
          actionId: created.context.actionId,
          contextId: created.context.contextId,
          correlationId: created.context.correlationId,
          authority: scope.authority,
          kind: "navigate",
          target,
        }),
      );
    } catch {
      setMessage("This thread could not open a research page.");
    } finally {
      setStarting(false);
    }
  }

  async function close(): Promise<void> {
    if (context === undefined) return;
    try {
      setSnapshot(
        await props.client.stop({
          contextId: context.contextId,
          threadId: browserThreadId,
        }),
      );
    } catch {
      setMessage("This research page could not be closed.");
    }
  }

  async function command(kind: "back" | "forward" | "reload" | "stop"): Promise<void> {
    if (context === undefined || props.hostBridge?.commandBrowserSurface === undefined) return;
    await props.hostBridge
      .commandBrowserSurface({ contextId: String(context.contextId), threadId, command: kind })
      .catch(() => setMessage("The page did not answer."));
  }

  async function tabCommand(kind: "open" | "select" | "close", tabId?: string): Promise<void> {
    const send = props.hostBridge?.tabBrowserSurface;
    if (context === undefined || send === undefined) return;
    try {
      surface.adopt(
        await send({
          contextId: String(context.contextId),
          threadId,
          command: kind === "open" ? { kind } : { kind, tabId: tabId ?? "" },
        }),
      );
    } catch {
      setMessage("That tab is no longer open.");
    }
  }

  if (props.dock.collapsed) {
    return (
      <aside aria-label="Research browser" className="zen-research zen-research--collapsed">
        <OctantButton
          aria-label="Expand research browser"
          onClick={() => props.onCollapse(false)}
          type="button"
          variant="secondary"
        >
          <ChevronRight aria-hidden="true" size={14} />
        </OctantButton>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Research browser"
      className="zen-research"
      style={{ width: props.dock.width }}
    >
      <header className="zen-research__header">
        <span className="zen-research__title">Research</span>
        <button
          aria-label="Collapse research browser"
          className="zen-research__chrome-button"
          onClick={() => props.onCollapse(true)}
          type="button"
        >
          <ChevronRight aria-hidden="true" size={13} />
        </button>
        <button
          aria-label="Undock research browser"
          className="zen-research__chrome-button"
          onClick={() => {
            void close();
            props.onUndock();
          }}
          type="button"
        >
          <X aria-hidden="true" size={13} />
        </button>
      </header>
      {!nativeSupported ? (
        <p className="zen-research__notice" role="status">
          A research page needs the Octant desktop app on this host.
        </p>
      ) : !active ? (
        <div className="zen-research__empty">
          <ShieldCheck aria-hidden="true" size={18} />
          <p>The page belongs to this thread and is shared with its agent.</p>
          <input
            aria-label="Research address"
            onChange={(event) => setAddress(event.target.value)}
            spellCheck={false}
            type="text"
            value={address}
          />
          <OctantButton disabled={starting} onClick={() => void open()} type="button">
            {starting ? "Opening…" : "Open page"}
          </OctantButton>
        </div>
      ) : (
        <>
          <div aria-label="Research tabs" className="zen-research__rail" role="tablist">
            {(tabs.length === 0
              ? [
                  {
                    tabId: state?.activeTabId ?? "",
                    url: state?.url ?? "",
                    title: state?.title ?? "",
                  },
                ]
              : tabs
            ).map((tab) => (
              <span className="zen-research__tab" key={tab.tabId}>
                <button
                  aria-selected={tab.tabId === state?.activeTabId}
                  onClick={() => void tabCommand("select", tab.tabId)}
                  role="tab"
                  title={tab.url}
                  type="button"
                >
                  {tab.title === "" ? "New tab" : tab.title}
                </button>
                {tabs.length > 1 ? (
                  <button
                    aria-label={`Close ${tab.title === "" ? "new tab" : tab.title}`}
                    onClick={() => void tabCommand("close", tab.tabId)}
                    type="button"
                  >
                    <X aria-hidden="true" size={11} />
                  </button>
                ) : null}
              </span>
            ))}
            {canOpenTab ? (
              <button
                aria-label="Open a new research tab"
                className="zen-research__new-tab"
                onClick={() => void tabCommand("open")}
                type="button"
              >
                <Plus aria-hidden="true" size={13} />
              </button>
            ) : null}
          </div>
          <div className="zen-research__chrome">
            <button
              aria-label="Back"
              className="zen-research__chrome-button"
              disabled={state?.canGoBack !== true}
              onClick={() => void command("back")}
              type="button"
            >
              <ArrowLeft aria-hidden="true" size={13} />
            </button>
            <button
              aria-label="Forward"
              className="zen-research__chrome-button"
              disabled={state?.canGoForward !== true}
              onClick={() => void command("forward")}
              type="button"
            >
              <ArrowRight aria-hidden="true" size={13} />
            </button>
            <button
              aria-label={state?.loading === true ? "Stop loading" : "Reload"}
              className="zen-research__chrome-button"
              onClick={() => void command(state?.loading === true ? "stop" : "reload")}
              type="button"
            >
              {state?.loading === true ? (
                <LoaderCircle aria-hidden="true" size={13} />
              ) : (
                <RotateCw aria-hidden="true" size={13} />
              )}
            </button>
            <span className="zen-research__address" title={state?.url}>
              {state?.url ?? address}
            </span>
          </div>
          <div aria-label="Research page" className="zen-research__page" ref={surface.mount}>
            {surface.failed ? (
              <div className="zen-research__notice" role="alert">
                <p>The page could not attach to the dock.</p>
                <OctantButton onClick={surface.retry} type="button" variant="secondary">
                  Retry
                </OctantButton>
              </div>
            ) : null}
          </div>
        </>
      )}
      {message === undefined ? null : (
        <p className="zen-research__notice" role="alert">
          {message}
        </p>
      )}
    </aside>
  );
}
