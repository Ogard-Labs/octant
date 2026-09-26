import type { ProjectBrowserClient } from "@octant/client-runtime/project-browser-client";
import type { ProjectBrowserResult, ProjectBrowserView } from "@octant/contracts/project-browser";
import type { ZenProjectResearchDock as ZenProjectResearchDockBinding } from "@octant/contracts/zen";
import { ArrowLeft, ArrowRight, ChevronRight, RotateCw, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { normalizeBrowserUrl, RENDERER_OVERLAY_SELECTOR } from "../browser/BrowserWorkspace";
import { useNativeBrowserSurface } from "../browser/useNativeBrowserSurface";
import type { OctantHostBridge } from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

/** How often a headless page's picture is refreshed while the dock is open. */
const PICTURE_INTERVAL_MS = 1_500;

export interface ZenProjectResearchDockProps {
  readonly client: ProjectBrowserClient;
  readonly hostBridge?: OctantHostBridge;
  /** The dock as the space holds it: which Project's own browser it shows. */
  readonly dock: ZenProjectResearchDockBinding;
  readonly onCollapse: (collapsed: boolean) => void;
  readonly onUndock: () => void;
}

/**
 * A Project's own browser docked to the edge of a focus zone space.
 *
 * The page is the person's: it lives in an isolated context the host keeps
 * for this window and Project, apart from every thread's browsing context,
 * and no agent can see or act in it. On the desktop app the page is a live
 * native view; elsewhere the host drives a headless page and this dock shows
 * its picture. Every address the person opens goes through the host, which
 * decides whether this window still holds the Project.
 */
export function ZenProjectResearchDock(props: ZenProjectResearchDockProps) {
  const { client } = props;
  const projectId = props.dock.project.projectId;
  const [view, setView] = useState<ProjectBrowserView>();
  const [address, setAddress] = useState("https://");
  const [message, setMessage] = useState<string>();
  const [opening, setOpening] = useState(false);
  const [nativeSupported, setNativeSupported] = useState<boolean>();
  const context = view?.context;
  const active = context?.state === "active";
  const native = active && context?.presentation === "native-live";

  const adopt = useCallback((result: ProjectBrowserResult): boolean => {
    if (result.kind === "project-browser-refused") {
      setMessage(result.message);
      if (result.reason === "authority-revoked") setView(undefined);
      return false;
    }
    setView(result.browser);
    setMessage(undefined);
    return true;
  }, []);

  useEffect(() => {
    let current = true;
    void Promise.resolve(props.hostBridge?.getHostCapabilities?.()).then((capabilities) => {
      if (current) setNativeSupported(capabilities?.liveBrowserSupported === true);
    });
    return () => {
      current = false;
    };
  }, [props.hostBridge]);

  // Pick up a page this window already has open for the Project, and keep a
  // headless page's picture current while it is on screen.
  useEffect(() => {
    if (props.dock.collapsed) return;
    const controller = new AbortController();
    const read = () =>
      client
        .execute({ kind: "current", projectId }, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) adopt(result);
        })
        .catch(() => {
          if (!controller.signal.aborted) setMessage("This Project's browser is unavailable.");
        });
    void read();
    // Only a headless page needs its picture refreshed; a native view is live.
    const timer =
      active && !native
        ? globalThis.setInterval(() => void read(), PICTURE_INTERVAL_MS)
        : undefined;
    return () => {
      controller.abort();
      if (timer !== undefined) globalThis.clearInterval(timer);
    };
  }, [active, adopt, client, native, projectId, props.dock.collapsed]);

  const surface = useNativeBrowserSurface({
    ...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge }),
    ...(context === undefined ? {} : { contextId: String(context.contextId) }),
    ...(view === undefined ? {} : { threadId: String(view.subjectId) }),
    enabled: nativeSupported === true && native && !props.dock.collapsed,
    overlaySelector: RENDERER_OVERLAY_SELECTOR,
  });

  async function open(): Promise<void> {
    if (opening) return;
    setOpening(true);
    try {
      const target = normalizeBrowserUrl(address);
      setAddress(target);
      adopt(await client.execute({ kind: "open", projectId, url: target }));
    } catch {
      setMessage("This address could not be opened.");
    } finally {
      setOpening(false);
    }
  }

  async function close(): Promise<void> {
    await client.execute({ kind: "stop", projectId }).catch(() => undefined);
  }

  async function command(kind: "back" | "forward" | "reload"): Promise<void> {
    if (context === undefined || view === undefined) return;
    await props.hostBridge
      ?.commandBrowserSurface?.({
        contextId: String(context.contextId),
        threadId: String(view.subjectId),
        command: kind,
      })
      .catch(() => setMessage("The page did not answer."));
  }

  if (props.dock.collapsed) {
    return (
      <aside aria-label="Project browser" className="zen-research zen-research--collapsed">
        <OctantButton
          aria-label="Expand Project browser"
          onClick={() => props.onCollapse(false)}
          type="button"
          variant="secondary"
        >
          <ChevronRight aria-hidden="true" size={14} />
        </OctantButton>
      </aside>
    );
  }

  const addressBar = (
    <form
      className="zen-research__chrome"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void open();
      }}
    >
      {native ? (
        <>
          <OctantButton
            size="icon"
            aria-label="Back"
            disabled={surface.state?.canGoBack !== true}
            onClick={() => void command("back")}
            type="button"
            variant="ghost"
          >
            <ArrowLeft aria-hidden="true" size={14} />
          </OctantButton>
          <OctantButton
            size="icon"
            aria-label="Forward"
            disabled={surface.state?.canGoForward !== true}
            onClick={() => void command("forward")}
            type="button"
            variant="ghost"
          >
            <ArrowRight aria-hidden="true" size={14} />
          </OctantButton>
          <OctantButton
            size="icon"
            aria-label="Reload"
            onClick={() => void command("reload")}
            type="button"
            variant="ghost"
          >
            <RotateCw aria-hidden="true" size={14} />
          </OctantButton>
        </>
      ) : null}
      <OctantInput
        aria-label="Project browser address"
        className="zen-research__address-input"
        onChange={(event) => setAddress(event.target.value)}
        spellCheck={false}
        type="text"
        value={address}
      />
      <OctantButton disabled={opening} type="submit" variant="secondary">
        {opening ? "Opening…" : "Open"}
      </OctantButton>
    </form>
  );

  const page = view?.page;
  return (
    <aside
      aria-label="Project browser"
      className="zen-research"
      style={{ width: props.dock.width }}
    >
      <header className="zen-research__header">
        <span className="zen-research__title">Browser · this Project</span>
        <OctantButton
          size="icon"
          aria-label="Collapse Project browser"
          onClick={() => props.onCollapse(true)}
          type="button"
          variant="ghost"
        >
          <ChevronRight aria-hidden="true" size={14} />
        </OctantButton>
        <OctantButton
          size="icon"
          aria-label="Close Project browser"
          onClick={() => {
            void close();
            props.onUndock();
          }}
          type="button"
          variant="ghost"
        >
          <X aria-hidden="true" size={14} />
        </OctantButton>
      </header>
      {addressBar}
      {!active ? (
        <div className="zen-research__empty">
          <ShieldCheck aria-hidden="true" size={16} />
          <p>Your own browser for this Project. No agent can see or use this page.</p>
        </div>
      ) : native ? (
        <div aria-label="Project page" className="zen-research__page" ref={surface.mount}>
          {surface.failed ? (
            <div className="zen-research__notice" role="alert">
              <p>The page could not attach to the dock.</p>
              <OctantButton onClick={surface.retry} type="button" variant="secondary">
                Retry
              </OctantButton>
            </div>
          ) : null}
        </div>
      ) : (
        <div aria-label="Project page" className="zen-research__page">
          <p className="zen-research__notice" title={page?.url}>
            {page?.title === undefined || page.title === "" ? (page?.url ?? "") : page.title}
          </p>
          {page?.screenshotDataUrl === undefined ? null : (
            <img
              alt={`Picture of ${page.title ?? page.url ?? "the page"}`}
              className="zen-research__picture"
              src={page.screenshotDataUrl}
            />
          )}
        </div>
      )}
      {message === undefined ? null : (
        <p className="zen-research__notice" role="alert">
          {message}
        </p>
      )}
    </aside>
  );
}
